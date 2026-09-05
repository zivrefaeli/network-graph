import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { ApiError } from '@/api/client'
import { useHealth } from '@/hooks/useHealth'

const { getHealth } = vi.hoisted(() => ({ getHealth: vi.fn() }))

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return { ...actual, getHealth, apiConfigured: true }
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
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('useHealth', () => {
  it('starts out checking', () => {
    getHealth.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useHealth())
    expect(result.current.state.kind).toBe('checking')
  })

  it('reports a backend that answered', async () => {
    getHealth.mockResolvedValue(HEALTHY)
    const { result } = renderHook(() => useHealth())
    await waitFor(() => {
      expect(result.current.state.kind).toBe('ready')
    })
    if (result.current.state.kind !== 'ready') throw new Error('expected ready')
    expect(result.current.state.health.tshark_available).toBe(true)
  })

  it('treats an unreachable backend as offline, not an error', async () => {
    // The static build has no backend. That is a normal condition, and the UI
    // should say so calmly rather than show a failure.
    getHealth.mockRejectedValue(new ApiError('No backend at /api.', 0, true))
    const { result } = renderHook(() => useHealth())
    await waitFor(() => {
      expect(result.current.state.kind).toBe('offline')
    })
  })

  it('distinguishes a real server error from being offline', async () => {
    getHealth.mockRejectedValue(new ApiError('The server returned 500.', 500))
    const { result } = renderHook(() => useHealth())
    await waitFor(() => {
      expect(result.current.state.kind).toBe('error')
    })
  })

  it('ignores an abort, which is only this effect being torn down', async () => {
    getHealth.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    const { result } = renderHook(() => useHealth())
    // Never leaves "checking": an abort is not something to report.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(result.current.state.kind).toBe('checking')
  })

  it('asks again on recheck', async () => {
    getHealth.mockRejectedValueOnce(new ApiError('No backend at /api.', 0, true))
    getHealth.mockResolvedValueOnce(HEALTHY)

    const { result } = renderHook(() => useHealth())
    await waitFor(() => {
      expect(result.current.state.kind).toBe('offline')
    })

    result.current.recheck()
    await waitFor(() => {
      expect(result.current.state.kind).toBe('ready')
    })
    expect(getHealth).toHaveBeenCalledTimes(2)
  })

  it('aborts the in-flight check when it goes away', async () => {
    let signal: AbortSignal | undefined
    getHealth.mockImplementation((given?: AbortSignal) => {
      signal = given
      return new Promise(() => {})
    })
    const { unmount } = renderHook(() => useHealth())
    await waitFor(() => {
      expect(signal).toBeDefined()
    })
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})
