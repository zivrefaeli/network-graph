import { useId, useRef, useState } from 'react'
import { ACCEPTED_EXTENSIONS, readCaptureFile } from '@/api/readFile'
import type { CaptureDocument } from '@/types/graph'

/** What the picker last produced, for the notice under the button. */
type Status =
  | { kind: 'idle' }
  | { kind: 'reading'; filename: string }
  | { kind: 'loaded'; filename: string }
  | { kind: 'rejected'; filename: string; errors: readonly string[] }
  | { kind: 'needs_backend'; filename: string }
  | { kind: 'unsupported'; filename: string }

interface UploadButtonProps {
  onDocument: (document: CaptureDocument, filename: string) => void
  /** Shown only while a non-sample document is on screen. */
  canReset: boolean
  onReset: () => void
}

/**
 * The file picker.
 *
 * A .json schema document is parsed, validated and rendered for real. A
 * .pcapng needs tshark, which lives in the backend -- stage 3 replaces that
 * one branch with a POST and nothing else here moves.
 */
export function UploadButton({ onDocument, canReset, onReset }: UploadButtonProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function handleChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    // Picking the same file twice in a row fires no change event otherwise.
    event.target.value = ''
    if (file === undefined) return

    setStatus({ kind: 'reading', filename: file.name })
    const outcome = await readCaptureFile(file)

    if (outcome.kind === 'capture_pending_backend') {
      setStatus({ kind: 'needs_backend', filename: outcome.filename })
      return
    }
    if (outcome.kind === 'unsupported') {
      setStatus({ kind: 'unsupported', filename: outcome.filename })
      return
    }
    if (!outcome.result.ok) {
      setStatus({ kind: 'rejected', filename: outcome.filename, errors: outcome.result.errors })
      return
    }
    setStatus({ kind: 'loaded', filename: outcome.filename })
    onDocument(outcome.result.document, outcome.filename)
  }

  function handleReset(): void {
    setStatus({ kind: 'idle' })
    onReset()
  }

  return (
    <div className="upload">
      <div className="upload-actions">
        {canReset && (
          <button type="button" className="ghost-button" onClick={handleReset}>
            Back to sample
          </button>
        )}
        <label className="upload-button" htmlFor={inputId}>
          {status.kind === 'reading' ? 'Reading…' : 'Upload capture'}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          className="upload-input"
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          onChange={(event) => {
            void handleChange(event)
          }}
        />
      </div>

      <div className="upload-status" role="status" aria-live="polite">
        {status.kind === 'loaded' && (
          <span className="muted">
            Rendering <code>{status.filename}</code>
          </span>
        )}
        {status.kind === 'needs_backend' && (
          <span className="warn">
            <code>{status.filename}</code> is a capture file. Dissecting it needs tshark,
            which lives in the backend — not wired up yet.
          </span>
        )}
        {status.kind === 'unsupported' && (
          <span className="warn">
            <code>{status.filename}</code> is neither a schema document (.json) nor a
            capture (.pcap, .pcapng).
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
