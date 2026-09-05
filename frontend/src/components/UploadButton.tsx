import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, postCapture } from '@/api/client'
import { ACCEPTED_EXTENSIONS, classifyFile, readCaptureDocument } from '@/api/readFile'
import type { CaptureDocument } from '@/types/graph'

/** What the picker last produced, for the notice under the button. */
type Status =
  | { kind: 'idle' }
  | { kind: 'reading'; filename: string }
  | { kind: 'uploading'; filename: string; fraction: number }
  | { kind: 'loaded'; filename: string }
  | { kind: 'rejected'; filename: string; errors: readonly string[] }
  | { kind: 'failed'; filename: string; reason: string }
  | { kind: 'unsupported'; filename: string }

interface UploadButtonProps {
  onDocument: (document: CaptureDocument, filename: string) => void
  /** Shown only while a non-sample document is on screen. */
  canReset: boolean
  onReset: () => void
  /** False when no backend answered. Capture files are refused with a reason. */
  captureUploadAvailable: boolean
}

/**
 * The file picker.
 *
 * Two paths, and the split is deliberate. A `.json` schema document is parsed
 * in the browser and works with no server at all, which is what keeps the
 * statically deployed build useful. A `.pcap`/`.pcapng` needs Wireshark's
 * dissectors, so it is uploaded; when nothing is listening, that is said
 * plainly rather than failing as a network error.
 */
export function UploadButton({
  onDocument,
  canReset,
  onReset,
  captureUploadAvailable,
}: UploadButtonProps) {
  const inputId = useId()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  // An upload outliving the component would call setState on a dead one, and
  // would keep pushing a gigabyte at a server nobody is waiting on.
  useEffect(() => () => abortRef.current?.abort(), [])

  const busy = status.kind === 'reading' || status.kind === 'uploading'

  const handleFile = async (file: File): Promise<void> => {
    const kind = classifyFile(file)

    if (kind === 'unsupported') {
      setStatus({ kind: 'unsupported', filename: file.name })
      return
    }

    if (kind === 'document') {
      setStatus({ kind: 'reading', filename: file.name })
      const result = await readCaptureDocument(file)
      if (!result.ok) {
        setStatus({ kind: 'rejected', filename: file.name, errors: result.errors })
        return
      }
      setStatus({ kind: 'loaded', filename: file.name })
      onDocument(result.document, file.name)
      return
    }

    if (!captureUploadAvailable) {
      setStatus({
        kind: 'failed',
        filename: file.name,
        reason:
          'Dissecting a capture needs the backend, and nothing is answering. ' +
          'Start it with `docker compose up`, or upload a .json capture document instead.',
      })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setStatus({ kind: 'uploading', filename: file.name, fraction: 0 })
    try {
      const document = await postCapture(file, {
        signal: controller.signal,
        onProgress: (fraction) =>
          setStatus({ kind: 'uploading', filename: file.name, fraction }),
      })
      setStatus({ kind: 'loaded', filename: file.name })
      onDocument(document, file.name)
    } catch (error) {
      // A cancel is the user's doing, not a failure to report at them.
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus({ kind: 'idle' })
        return
      }
      setStatus({
        kind: 'failed',
        filename: file.name,
        reason: error instanceof ApiError ? error.message : String(error),
      })
    } finally {
      abortRef.current = null
    }
  }

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    // Picking the same file twice in a row fires no change event otherwise.
    event.target.value = ''
    if (file !== undefined) void handleFile(file)
  }

  const handleReset = (): void => {
    setStatus({ kind: 'idle' })
    onReset()
  }

  return (
    <div className="upload">
      <div className="upload-actions">
        {status.kind === 'uploading' && (
          <button
            type="button"
            className="ghost-button"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel
          </button>
        )}
        {canReset && !busy && (
          <button type="button" className="ghost-button" onClick={handleReset}>
            Back to sample
          </button>
        )}
        <label className={`upload-button${busy ? ' upload-button-busy' : ''}`} htmlFor={inputId}>
          {status.kind === 'reading' && 'Reading…'}
          {status.kind === 'uploading' && `Uploading ${Math.round(status.fraction * 100)}%`}
          {!busy && 'Upload capture'}
        </label>
        <input
          id={inputId}
          className="upload-input"
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          disabled={busy}
          onChange={handleChange}
        />
      </div>

      {status.kind === 'uploading' && (
        <progress className="upload-progress" value={status.fraction} max={1}>
          {Math.round(status.fraction * 100)}%
        </progress>
      )}

      <div className="upload-status" role="status" aria-live="polite">
        {status.kind === 'loaded' && (
          <span className="muted">
            Rendering <code>{status.filename}</code>
          </span>
        )}
        {status.kind === 'unsupported' && (
          <span className="warn">
            <code>{status.filename}</code> is neither a schema document (.json) nor a capture
            (.pcap, .pcapng).
          </span>
        )}
        {status.kind === 'failed' && (
          <span className="warn">
            <code>{status.filename}</code> — {status.reason}
          </span>
        )}
        {status.kind === 'rejected' && (
          <details className="upload-errors" open>
            <summary>
              <code>{status.filename}</code> is not a valid capture document
            </summary>
            <ul>
              {status.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}
