import { parseCaptureJson } from '@/api/parse'
import type { ParseResult } from '@/api/parse'

/**
 * What kind of file the picker produced.
 *
 * A schema document is parsed here in the browser; a capture needs Wireshark's
 * dissectors and so needs the backend. Classification is kept separate from
 * either action so it stays testable without a network.
 */
export type FileKind = 'document' | 'capture' | 'unsupported'

const CAPTURE_EXTENSIONS = ['.pcap', '.pcapng', '.cap', '.pcapng.gz', '.pcap.gz']
const DOCUMENT_EXTENSIONS = ['.json']

export const ACCEPTED_EXTENSIONS = [...DOCUMENT_EXTENSIONS, ...CAPTURE_EXTENSIONS].join(',')

function endsWithAny(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return extensions.some((extension) => lower.endsWith(extension))
}

export function classifyFile(file: File): FileKind {
  if (endsWithAny(file.name, DOCUMENT_EXTENSIONS)) return 'document'
  if (endsWithAny(file.name, CAPTURE_EXTENSIONS)) return 'capture'
  return 'unsupported'
}

/**
 * Read and validate a schema document without involving the server.
 *
 * This path survives on the static build, where there is no backend at all.
 */
export async function readCaptureDocument(file: File): Promise<ParseResult> {
  return parseCaptureJson(await file.text())
}
