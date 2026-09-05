import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { sampleCapture } from '@/api/mock'
import { UploadButton } from '@/components/UploadButton'
import type { CaptureDocument } from '@/types/graph'

const { postCapture } = vi.hoisted(() => ({ postCapture: vi.fn() }))

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return { ...actual, postCapture }
})

afterEach(() => {
  postCapture.mockReset()
})

function jsonFile(name: string, body: unknown): File {
  return new File([JSON.stringify(body)], name, { type: 'application/json' })
}

function captureFile(name = 'office.pcapng'): File {
  return new File([new Uint8Array([0x0a, 0x0d, 0x0d, 0x0a])], name)
}

function renderUpload({ captureUploadAvailable = true } = {}) {
  const onDocument = vi.fn<(doc: CaptureDocument, filename: string) => void>()
  const onReset = vi.fn()
  const view = render(
    <UploadButton
      onDocument={onDocument}
      canReset={false}
      onReset={onReset}
      captureUploadAvailable={captureUploadAvailable}
    />,
  )
  const input = view.container.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
  return { ...view, input, onDocument, onReset }
}

describe('picking a schema document', () => {
  it('accepts both schema documents and capture files', () => {
    const { input } = renderUpload()
    expect(input.accept).toContain('.json')
    expect(input.accept).toContain('.pcapng')
  })

  it('parses and renders it in the browser, with no server involved', async () => {
    const user = userEvent.setup()
    const { input, onDocument } = renderUpload({ captureUploadAvailable: false })
    await user.upload(input, jsonFile('capture.json', sampleCapture))
    await waitFor(() => {
      expect(onDocument).toHaveBeenCalledTimes(1)
    })
    // This path is what keeps the statically deployed build useful.
    expect(postCapture).not.toHaveBeenCalled()
    const [document, filename] = onDocument.mock.calls[0] ?? []
    expect(filename).toBe('capture.json')
    expect(document?.machines).toHaveLength(4)
  })

  it('lists the reasons a document was rejected', async () => {
    const user = userEvent.setup()
    const { input, onDocument } = renderUpload()
    await user.upload(input, jsonFile('future.json', { ...sampleCapture, schema_version: '3.0' }))
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
})

describe('uploading a capture', () => {
  it('posts it and renders what comes back', async () => {
    postCapture.mockResolvedValue(sampleCapture)
    const user = userEvent.setup()
    const { input, onDocument } = renderUpload()

    await user.upload(input, captureFile())
    await waitFor(() => {
      expect(onDocument).toHaveBeenCalledWith(sampleCapture, 'office.pcapng')
    })
    expect(postCapture).toHaveBeenCalledTimes(1)
    const [file] = postCapture.mock.calls[0] ?? []
    expect((file as File).name).toBe('office.pcapng')
  })

  it('shows progress while the bytes are going up', async () => {
    // fetch cannot report upload progress, which is the only reason the client
    // uses XHR. If the wiring breaks, a gigabyte upload looks like a hang.
    let report: ((fraction: number) => void) | undefined
    postCapture.mockImplementation(
      (_file: File, options: { onProgress?: (fraction: number) => void }) => {
        report = options.onProgress
        return new Promise(() => {})
      },
    )
    const user = userEvent.setup()
    const { input } = renderUpload()

    await user.upload(input, captureFile())
    await waitFor(() => {
      expect(report).toBeDefined()
    })
    report?.(0.42)
    expect(await screen.findByText(/Uploading 42%/)).toBeTruthy()
    expect(screen.getByRole('progressbar')).toBeTruthy()
  })

  it('offers a cancel while uploading, and says nothing when it is taken', async () => {
    let aborted = false
    postCapture.mockImplementation((_file: File, options: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('Upload cancelled', 'AbortError'))
        })
      })
    })
    const user = userEvent.setup()
    const { input } = renderUpload()

    await user.upload(input, captureFile())
    const cancel = await screen.findByText('Cancel')
    await user.click(cancel)

    await waitFor(() => {
      expect(aborted).toBe(true)
    })
    // A cancel is the user's own doing, not a failure to report at them.
    await waitFor(() => {
      expect(screen.queryByText(/Cancel/)).toBeNull()
    })
    expect(screen.queryByText(/cancelled/i)).toBeNull()
  })

  it('shows the server’s own reason when dissection fails', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/api/client')>('@/api/client')
    postCapture.mockRejectedValue(
      new ApiError('the dissector failed on this file; see the server log', 500),
    )
    const user = userEvent.setup()
    const { input, onDocument } = renderUpload()

    await user.upload(input, captureFile())
    expect(await screen.findByText(/see the server log/)).toBeTruthy()
    expect(onDocument).not.toHaveBeenCalled()
  })

  it('refuses a capture when no backend answered, and says what to do', async () => {
    const user = userEvent.setup()
    const { input } = renderUpload({ captureUploadAvailable: false })
    await user.upload(input, captureFile())
    expect(await screen.findByText(/docker compose up/)).toBeTruthy()
    // Refused here rather than failing as an opaque network error there.
    expect(postCapture).not.toHaveBeenCalled()
  })

  it('aborts an upload in flight if the component goes away', async () => {
    let signal: AbortSignal | undefined
    postCapture.mockImplementation((_file: File, options: { signal?: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => {})
    })
    const user = userEvent.setup()
    const { input, unmount } = renderUpload()

    await user.upload(input, captureFile())
    await waitFor(() => {
      expect(signal).toBeDefined()
    })
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})

describe('getting back to the sample', () => {
  it('offers the way back only once a document is loaded', async () => {
    const onDocument = vi.fn()
    const onReset = vi.fn()
    const { rerender } = render(
      <UploadButton
        onDocument={onDocument}
        canReset={false}
        onReset={onReset}
        captureUploadAvailable
      />,
    )
    expect(screen.queryByText('Back to sample')).toBeNull()

    rerender(
      <UploadButton
        onDocument={onDocument}
        canReset
        onReset={onReset}
        captureUploadAvailable
      />,
    )
    await userEvent.setup().click(screen.getByText('Back to sample'))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
