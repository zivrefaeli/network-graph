import { parseCaptureDocument } from '@/api/parse'
import type { CaptureDocument } from '@/types/graph'
import type { Health } from '@/types/health'

// The only place this app talks to the backend.
//
// Everything that comes back still goes through `parseCaptureDocument`. That
// is not paranoia about the network: the backend's Pydantic models and
// `@/types/graph` are the same contract in two languages, and a mismatch
// between them is exactly the bug worth catching at the boundary rather than
// three components deep as a NaN.

/** Where the backend lives. Empty means "no backend configured". */
const BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '')

/** Uploads larger than this are refused before a byte leaves the browser. */
const MAX_UPLOAD_BYTES = 2 * 1024 ** 3

export class ApiError extends Error {
  readonly status: number
  /** True when the request never reached a server at all. */
  readonly offline: boolean

  constructor(message: string, status: number, offline = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.offline = offline
  }
}

function url(path: string): string {
  return `${BASE}${path}`
}

/**
 * Turn a failed response into a message worth showing a person.
 *
 * FastAPI puts the reason in `detail`, and the backend is careful about what
 * goes in there -- a dissector crash says "see the server log" rather than
 * leaking a path. Where there is no detail, the status decides the wording.
 */
async function failureFor(response: Response): Promise<ApiError> {
  let detail = ''
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'detail' in body) {
      const value = (body as { detail: unknown }).detail
      if (typeof value === 'string') detail = value
    }
  } catch {
    // A non-JSON body is normal for a proxy error page.
  }
  if (detail) return new ApiError(detail, response.status)

  switch (response.status) {
    case 404:
      return new ApiError('That capture is not on the server.', 404)
    case 413:
      return new ApiError('That capture is larger than the server accepts.', 413)
    case 503:
      return new ApiError('The server is running but cannot dissect captures.', 503)
    default:
      return new ApiError(`The server returned ${response.status}.`, response.status)
  }
}

function offlineError(): ApiError {
  return new ApiError(
    `No backend at ${BASE || '(unset)'}. Run \`docker compose up\`, or keep using ` +
      'the sample and uploaded .json documents.',
    0,
    true,
  )
}

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  let response: Response
  try {
    response = await fetch(url('/health'), { signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw offlineError()
  }
  if (!response.ok) throw await failureFor(response)

  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new ApiError('The health endpoint returned something unreadable.', 502)
  }
  const record = body as Record<string, unknown>
  return {
    status: typeof record['status'] === 'string' ? record['status'] : 'unknown',
    tshark_available: record['tshark_available'] === true,
    tshark_version:
      typeof record['tshark_version'] === 'string' ? record['tshark_version'] : null,
    tshark_error: typeof record['tshark_error'] === 'string' ? record['tshark_error'] : null,
    captures_held: typeof record['captures_held'] === 'number' ? record['captures_held'] : 0,
  }
}

export async function getCapture(
  captureId: string,
  signal?: AbortSignal,
): Promise<CaptureDocument> {
  let response: Response
  try {
    response = await fetch(url(`/captures/${encodeURIComponent(captureId)}`), { signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw offlineError()
  }
  if (!response.ok) throw await failureFor(response)
  return narrow(await response.json())
}

interface UploadOptions {
  /** Fraction uploaded, 0 to 1. Undefined while the length is unknown. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/**
 * Upload a capture file and get its document back.
 *
 * Uses XHR rather than fetch for one reason: fetch cannot report upload
 * progress, and a multi-gigabyte capture with no progress bar is indis-
 * tinguishable from a hung browser. Everything else here would be shorter
 * with fetch.
 */
export function postCapture(file: File, options: UploadOptions = {}): Promise<CaptureDocument> {
  const { onProgress, signal } = options

  if (file.size === 0) {
    return Promise.reject(new ApiError(`${file.name} is empty.`, 422))
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    // Refused here so a gigabyte does not cross the wire to be refused there.
    return Promise.reject(
      new ApiError(`${file.name} is larger than the ${MAX_UPLOAD_BYTES} byte limit.`, 413),
    )
  }

  return new Promise<CaptureDocument>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', url('/captures'))
    request.responseType = 'text'

    const abort = () => request.abort()
    signal?.addEventListener('abort', abort)
    const done = () => signal?.removeEventListener('abort', abort)

    if (onProgress) {
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total)
        }
      })
    }

    request.addEventListener('load', () => {
      done()
      if (request.status < 200 || request.status >= 300) {
        reject(errorFromXhr(request))
        return
      }
      try {
        resolve(narrow(JSON.parse(request.responseText)))
      } catch (error) {
        reject(error instanceof Error ? error : new ApiError(String(error), 502))
      }
    })

    request.addEventListener('error', () => {
      done()
      reject(offlineError())
    })
    request.addEventListener('abort', () => {
      done()
      reject(new DOMException('Upload cancelled', 'AbortError'))
    })
    request.addEventListener('timeout', () => {
      done()
      reject(new ApiError('The server took too long to answer.', 504))
    })

    const form = new FormData()
    form.append('file', file, file.name)
    request.send(form)
  })
}

function errorFromXhr(request: XMLHttpRequest): ApiError {
  let detail = ''
  try {
    const body: unknown = JSON.parse(request.responseText)
    if (typeof body === 'object' && body !== null && 'detail' in body) {
      const value = (body as { detail: unknown }).detail
      if (typeof value === 'string') detail = value
    }
  } catch {
    // Non-JSON body; the status carries the meaning instead.
  }
  if (detail) return new ApiError(detail, request.status)
  if (request.status === 0) return offlineError()
  return new ApiError(`The server returned ${request.status}.`, request.status)
}

/** The contract check. A backend that drifts from the schema fails here. */
function narrow(body: unknown): CaptureDocument {
  const result = parseCaptureDocument(body)
  if (result.ok) return result.document
  throw new ApiError(
    `The server returned a document this build cannot read: ${result.errors.join('; ')}`,
    502,
  )
}

/** Whether a backend is configured at all. False on a static deployment. */
export const apiConfigured = BASE.length > 0
export const apiBase = BASE
