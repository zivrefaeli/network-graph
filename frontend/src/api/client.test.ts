import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getCapture, getHealth, postCapture } from '@/api/client'
import { sampleCapture } from '@/api/mock'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const HEALTHY = {
  status: 'ok',
  tshark_available: true,
  tshark_version: 'TShark (Wireshark) 4.4.18.',
  tshark_error: null,
  captures_held: 0,
}

describe('getHealth', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('asks the configured base, not the page root', async () => {
    fetchMock.mockResolvedValue(jsonResponse(HEALTHY))
    await getHealth()
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.anything())
  })

  it('reads the fields the backend declares', async () => {
    fetchMock.mockResolvedValue(jsonResponse(HEALTHY))
    const health = await getHealth()
    expect(health.tshark_available).toBe(true)
    expect(health.tshark_version).toContain('TShark')
  })

  it('reports a degraded backend as reachable but without a dissector', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: 'degraded',
        tshark_available: false,
        tshark_version: null,
        tshark_error: 'tshark not found at "tshark"',
        captures_held: 0,
      }),
    )
    const health = await getHealth()
    expect(health.tshark_available).toBe(false)
    expect(health.tshark_error).toContain('not found')
  })

  it('marks a network failure as offline rather than a server error', async () => {
    // The static build has no backend at all. That is a normal condition to
    // report calmly, not a failure.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(getHealth()).rejects.toMatchObject({ offline: true, status: 0 })
  })

  it('says how to start the backend', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(getHealth()).rejects.toThrow(/docker compose up/)
  })

  it('lets an abort through untouched, so callers can tell it apart', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    await expect(getHealth()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('survives a body that is not the shape it expected', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nonsense: true }))
    const health = await getHealth()
    expect(health.tshark_available).toBe(false)
    expect(health.status).toBe('unknown')
  })
})

describe('getCapture', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('escapes the id it is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sampleCapture))
    await getCapture('cap /../etc')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/captures/cap%20%2F..%2Fetc',
      expect.anything(),
    )
  })

  it('surfaces the server’s own reason for a 404', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: "no capture 'cap_nope'; it was never uploaded" }, 404),
    )
    await expect(getCapture('cap_nope')).rejects.toThrow(/never uploaded/)
  })

  it('falls back to a readable message when there is no detail', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 404 }))
    await expect(getCapture('cap_nope')).rejects.toThrow(/not on the server/)
  })

  it('rejects a document that does not match the schema this build reads', async () => {
    // The backend's Pydantic models and @/types/graph are one contract in two
    // languages. Drift between them is caught here, not three components deep.
    fetchMock.mockResolvedValue(
      jsonResponse({ ...sampleCapture, schema_version: '3.0' }),
    )
    await expect(getCapture('cap_x')).rejects.toThrow(/cannot read/)
  })

  it('accepts a document the backend could really produce', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sampleCapture))
    const document = await getCapture('cap_x')
    expect(document.machines).toHaveLength(4)
  })
})

/** Enough of XMLHttpRequest to drive the upload path. */
class FakeXhr {
  static last: FakeXhr | undefined

  status = 0
  responseText = ''
  responseType = ''
  method = ''
  requestUrl = ''
  sent: FormData | undefined
  aborted = false
  readonly upload = new EventTarget()
  private readonly events = new EventTarget()

  constructor() {
    FakeXhr.last = this
  }

  open(method: string, requestUrl: string): void {
    this.method = method
    this.requestUrl = requestUrl
  }

  addEventListener(type: string, listener: EventListener): void {
    this.events.addEventListener(type, listener)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.events.removeEventListener(type, listener)
  }

  send(body: FormData): void {
    this.sent = body
  }

  abort(): void {
    this.aborted = true
    this.events.dispatchEvent(new Event('abort'))
  }

  respond(status: number, body: unknown): void {
    this.status = status
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body)
    this.events.dispatchEvent(new Event('load'))
  }

  fail(): void {
    this.events.dispatchEvent(new Event('error'))
  }

  progress(loaded: number, total: number): void {
    const event = new Event('progress') as Event & {
      lengthComputable: boolean
      loaded: number
      total: number
    }
    event.lengthComputable = true
    event.loaded = loaded
    event.total = total
    this.upload.dispatchEvent(event)
  }
}

describe('postCapture', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    FakeXhr.last = undefined
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const capture = () => new File([new Uint8Array([1, 2, 3, 4])], 'tiny.pcapng')

  it('posts multipart to the captures endpoint', async () => {
    const promise = postCapture(capture())
    const request = FakeXhr.last
    expect(request?.method).toBe('POST')
    expect(request?.requestUrl).toBe('/api/captures')
    expect(request?.sent?.get('file')).toBeInstanceOf(File)
    request?.respond(201, sampleCapture)
    await expect(promise).resolves.toMatchObject({ schema_version: '2.0' })
  })

  it('reports upload progress, which is why this is XHR and not fetch', async () => {
    const seen: number[] = []
    const promise = postCapture(capture(), { onProgress: (f) => seen.push(f) })
    FakeXhr.last?.progress(50, 200)
    FakeXhr.last?.progress(200, 200)
    FakeXhr.last?.respond(201, sampleCapture)
    await promise
    expect(seen).toEqual([0.25, 1])
  })

  it('refuses an empty file before a byte leaves the browser', async () => {
    await expect(postCapture(new File([], 'empty.pcapng'))).rejects.toThrow(/is empty/)
    expect(FakeXhr.last).toBeUndefined()
  })

  it('surfaces the server’s reason for a rejection', async () => {
    const promise = postCapture(capture())
    FakeXhr.last?.respond(422, { detail: 'produced no readable frames' })
    await expect(promise).rejects.toThrow(/no readable frames/)
  })

  it('does not leak a dissector crash beyond what the server chose to say', async () => {
    const promise = postCapture(capture())
    FakeXhr.last?.respond(500, { detail: 'the dissector failed; see the server log' })
    await expect(promise).rejects.toThrow(/see the server log/)
  })

  it('reports a dead connection as offline', async () => {
    const promise = postCapture(capture())
    FakeXhr.last?.fail()
    await expect(promise).rejects.toMatchObject({ offline: true })
  })

  it('aborts when its signal does, and says so as an AbortError', async () => {
    const controller = new AbortController()
    const promise = postCapture(capture(), { signal: controller.signal })
    controller.abort()
    expect(FakeXhr.last?.aborted).toBe(true)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('validates what comes back against this build’s schema', async () => {
    const promise = postCapture(capture())
    FakeXhr.last?.respond(201, { ...sampleCapture, machines: 'not an array' })
    await expect(promise).rejects.toThrow(/cannot read/)
  })

  it('does not crash on a non-JSON error body', async () => {
    const promise = postCapture(capture())
    FakeXhr.last?.respond(502, '<html>bad gateway</html>')
    await expect(promise).rejects.toBeInstanceOf(ApiError)
  })
})
