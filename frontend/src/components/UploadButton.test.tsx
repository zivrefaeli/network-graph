import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { sampleCapture } from '@/api/mock'
import { UploadButton } from '@/components/UploadButton'
import type { CaptureDocument } from '@/types/graph'

function jsonFile(name: string, body: unknown): File {
  return new File([JSON.stringify(body)], name, { type: 'application/json' })
}

function renderUpload() {
  const onDocument = vi.fn<(doc: CaptureDocument, filename: string) => void>()
  const onReset = vi.fn()
  const view = render(
    <UploadButton onDocument={onDocument} canReset={false} onReset={onReset} />,
  )
  const input = view.container.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
  return { ...view, input, onDocument, onReset }
}

describe('UploadButton', () => {
  it('accepts both schema documents and capture files', () => {
    const { input } = renderUpload()
    expect(input.accept).toContain('.json')
    expect(input.accept).toContain('.pcapng')
  })

  it('renders a valid schema document for real', async () => {
    const user = userEvent.setup()
    const { input, onDocument } = renderUpload()
    await user.upload(input, jsonFile('capture.json', sampleCapture))
    await waitFor(() => {
      expect(onDocument).toHaveBeenCalledTimes(1)
    })
    const [document, filename] = onDocument.mock.calls[0] ?? []
    expect(filename).toBe('capture.json')
    expect(document?.machines).toHaveLength(4)
    expect(await screen.findByText('capture.json')).toBeTruthy()
  })

  it('explains why a capture file cannot be rendered yet', async () => {
    const user = userEvent.setup()
    const { input, onDocument } = renderUpload()
    await user.upload(input, new File(['\xd4\xc3\xb2\xa1'], 'office.pcapng'))
    expect(await screen.findByText(/needs tshark/)).toBeTruthy()
    expect(onDocument).not.toHaveBeenCalled()
  })

  it('lists the reasons a document was rejected', async () => {
    const user = userEvent.setup()
    const { input, onDocument } = renderUpload()
    const broken = { ...sampleCapture, schema_version: '3.0' }
    await user.upload(input, jsonFile('future.json', broken))
    expect(await screen.findByText(/is not a valid capture document/)).toBeTruthy()
    expect(screen.getByText(/schema_version 3\.0 is not supported/)).toBeTruthy()
    expect(onDocument).not.toHaveBeenCalled()
  })

  it('reports malformed JSON rather than throwing', async () => {
    const user = userEvent.setup()
    const { input, onDocument } = renderUpload()
    await user.upload(input, new File(['{ not json'], 'broken.json'))
    expect(await screen.findByText(/not valid JSON/)).toBeTruthy()
    expect(onDocument).not.toHaveBeenCalled()
  })

  it('turns away a file that is neither', async () => {
    // applyAccept: false is the user picking "All files" in the native dialog
    // and getting past the accept filter, which is the only way this branch
    // is reachable.
    const user = userEvent.setup({ applyAccept: false })
    const { input } = renderUpload()
    await user.upload(input, new File(['hello'], 'notes.txt'))
    expect(await screen.findByText(/neither a schema document/)).toBeTruthy()
  })

  it('offers a way back to the sample only once a document is loaded', async () => {
    const onDocument = vi.fn()
    const onReset = vi.fn()
    const { rerender } = render(
      <UploadButton onDocument={onDocument} canReset={false} onReset={onReset} />,
    )
    expect(screen.queryByText('Back to sample')).toBeNull()

    rerender(<UploadButton onDocument={onDocument} canReset={true} onReset={onReset} />)
    await userEvent.setup().click(screen.getByText('Back to sample'))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
