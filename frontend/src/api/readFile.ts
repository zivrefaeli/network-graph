import { parseCaptureJson } from '@/api/parse'
import type { ParseResult } from '@/api/parse'

/**
 * What the file picker produced.
 *
 * `capture_pending_backend` is the stage-2 gap made explicit rather than
 * silently ignored: a .pcapng needs tshark, which lives in the backend, which
 * is not wired up yet. Stage 3 replaces exactly this branch with a POST.
 */
export type FileResult =
  | { kind: 'document'; result: ParseResult; filename: string }
  | { kind: 'capture_pending_backend'; filename: string }
  | { kind: 'unsupported'; filename: string }

const CAPTURE_EXTENSIONS = ['.pcap', '.pcapng', '.cap', '.pcapng.gz', '.pcap.gz']
const DOCUMENT_EXTENSIONS = ['.json']

export const ACCEPTED_EXTENSIONS = [...DOCUMENT_EXTENSIONS, ...CAPTURE_EXTENSIONS].join(',')

function endsWithAny(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return extensions.some((extension) => lower.endsWith(extension))
}

/**
 * Route a picked file. A schema document is parsed and rendered for real; a
 * capture file is recognised and refused with a reason, not swallowed.
 */
export async function readCaptureFile(file: File): Promise<FileResult> {
  if (endsWithAny(file.name, DOCUMENT_EXTENSIONS)) {
    const text = await file.text()
    return { kind: 'document', result: parseCaptureJson(text), filename: file.name }
  }
  if (endsWithAny(file.name, CAPTURE_EXTENSIONS)) {
    return { kind: 'capture_pending_backend', filename: file.name }
  }
  return { kind: 'unsupported', filename: file.name }
}
