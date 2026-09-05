import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@/App'
import { sampleCapture } from '@/api/mock'

const { getHealth, postCapture } = vi.hoisted(() => ({
  getHealth: vi.fn(),
  postCapture: vi.fn(),
}))

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return { ...actual, getHealth, postCapture, apiConfigured: true }
})

const HEALTHY = {
  status: 'ok',
  tshark_available: true,
  tshark_version: 'TShark (Wireshark) 4.4.18.',
  tshark_error: null,
  captures_held: 0,
}

beforeEach(() => {
  getHealth.mockReset()
  postCapture.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function captureFile(name = 'office.pcapng'): File {
  return new File([new Uint8Array([0x0a, 0x0d, 0x0d, 0x0a])], name)
}

/** The filename in the header, which is the one that tracks the document. */
function headerFilename(container: HTMLElement): string {
  return container.querySelector('.capture-line code')?.textContent ?? ''
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
  return input
}

describe('with a backend answering', () => {
  it('says the backend is ready and names the dissector', async () => {
    getHealth.mockResolvedValue(HEALTHY)
    render(<App />)
    expect(await screen.findByText('Backend ready')).toBeTruthy()
    expect(screen.getByText(/TShark \(Wireshark\)/)).toBeTruthy()
  })

  it('renders the sample until something replaces it', async () => {
    getHealth.mockResolvedValue(HEALTHY)
    render(<App />)
    expect(screen.getByText('sample')).toBeTruthy()
    expect(screen.getByText(sampleCapture.capture.filename)).toBeTruthy()
  })

  it('uploads a capture and renders the document that comes back', async () => {
    getHealth.mockResolvedValue(HEALTHY)
    const returned = {
      ...sampleCapture,
      capture: { ...sampleCapture.capture, filename: 'office.pcapng', packets_total: 31 },
    }
    postCapture.mockResolvedValue(returned)

    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('Backend ready')

    await user.upload(fileInput(container), captureFile())

    await waitFor(() => {
      expect(postCapture).toHaveBeenCalledTimes(1)
    })
    // The header follows the document, and the sample badge goes away.
    await waitFor(() => {
      expect(headerFilename(container)).toBe('office.pcapng')
    })
    expect(screen.queryByText('sample')).toBeNull()
  })

  it('offers a way back to the sample once a real document is loaded', async () => {
    getHealth.mockResolvedValue(HEALTHY)
    // A distinct document: handing back the sample object itself would leave
    // the app on the sample, and there would be nothing to go back from.
    postCapture.mockResolvedValue({
      ...sampleCapture,
      capture: { ...sampleCapture.capture, filename: 'office.pcapng' },
    })

    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('Backend ready')
    await user.upload(fileInput(container), captureFile())

    const back = await screen.findByText('Back to sample')
    await user.click(back)
    await waitFor(() => {
      expect(screen.getByText('sample')).toBeTruthy()
    })
  })

  it('clears the selection when the document changes', async () => {
    // Every id in the old document is meaningless in the new one, so a stale
    // selection would point the panel at nothing.
    getHealth.mockResolvedValue(HEALTHY)
    postCapture.mockResolvedValue({ ...sampleCapture, capture: { ...sampleCapture.capture } })

    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('Backend ready')

    const ring = container.querySelector('.machine-body')
    if (ring === null) throw new Error('no machine on the canvas')
    await user.click(ring)
    // The label is on the canvas too, so this asks the panel specifically.
    expect(container.querySelector('.panel h2')?.textContent).toBe('workstation-01')

    await user.upload(fileInput(container), captureFile())
    await waitFor(() => {
      expect(screen.getByText(/Click a machine/)).toBeTruthy()
    })
  })
})

describe('with a backend that has no dissector', () => {
  it('warns rather than showing a green light', async () => {
    // A server that answers /health but cannot dissect anything would
    // otherwise look healthy right up until the first upload fails.
    getHealth.mockResolvedValue({
      status: 'degraded',
      tshark_available: false,
      tshark_version: null,
      tshark_error: 'tshark not found at "tshark"',
      captures_held: 0,
    })
    render(<App />)
    expect(await screen.findByText(/no dissector/)).toBeTruthy()
    expect(screen.getByText(/tshark not found/)).toBeTruthy()
  })

  it('refuses a capture up front instead of failing mid-upload', async () => {
    getHealth.mockResolvedValue({
      status: 'degraded',
      tshark_available: false,
      tshark_version: null,
      tshark_error: 'tshark not found',
      captures_held: 0,
    })
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText(/no dissector/)

    await user.upload(fileInput(container), captureFile())
    expect(await screen.findByText(/docker compose up/)).toBeTruthy()
    expect(postCapture).not.toHaveBeenCalled()
  })
})

describe('with no backend at all', () => {
  // This is the normal state of the statically deployed build. Everything that
  // does not need a server has to keep working, and the UI has to say what is
  // going on without making it look broken.

  it('says so calmly and still renders the sample', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/api/client')>('@/api/client')
    getHealth.mockRejectedValue(new ApiError('No backend at /api.', 0, true))

    render(<App />)
    expect(await screen.findByText('No backend')).toBeTruthy()
    // The graph is still there and still readable.
    expect(screen.getByText('sample')).toBeTruthy()
    expect(screen.getByLabelText(/Network graph:/)).toBeTruthy()
  })

  it('still parses and renders an uploaded .json document', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/api/client')>('@/api/client')
    getHealth.mockRejectedValue(new ApiError('No backend at /api.', 0, true))

    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('No backend')

    const document = {
      ...sampleCapture,
      capture: { ...sampleCapture.capture, filename: 'exported.json' },
    }
    await user.upload(
      fileInput(container),
      new File([JSON.stringify(document)], 'exported.json', { type: 'application/json' }),
    )

    await waitFor(() => {
      expect(headerFilename(container)).toBe('exported.json')
    })
    expect(postCapture).not.toHaveBeenCalled()
  })

  it('lets the check be retried', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/api/client')>('@/api/client')
    getHealth.mockRejectedValueOnce(new ApiError('No backend at /api.', 0, true))
    getHealth.mockResolvedValueOnce(HEALTHY)

    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByText('Retry'))
    expect(await screen.findByText('Backend ready')).toBeTruthy()
  })
})
