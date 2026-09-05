import { useEffect, useState } from 'react'
import { ApiError, apiConfigured, getHealth } from '@/api/client'
import type { Health } from '@/types/health'

/**
 * What the backend said about itself, if anything.
 *
 * `offline` is a first-class state rather than an error, because it is the
 * normal condition for the static build published to Pages: there is no
 * backend there, the sample and uploaded `.json` documents still work, and the
 * UI should say so calmly instead of showing a failure.
 */
export type HealthState =
  | { kind: 'checking' }
  | { kind: 'ready'; health: Health }
  | { kind: 'offline'; reason: string }
  | { kind: 'error'; reason: string }

export function useHealth(): { state: HealthState; recheck: () => void } {
  const [state, setState] = useState<HealthState>(
    apiConfigured ? { kind: 'checking' } : { kind: 'offline', reason: 'No backend configured.' },
  )
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!apiConfigured) return

    const controller = new AbortController()
    let live = true

    getHealth(controller.signal)
      .then((health) => {
        if (live) setState({ kind: 'ready', health })
      })
      .catch((error: unknown) => {
        // An abort is this effect being torn down, not a failure to report.
        if (!live || (error instanceof DOMException && error.name === 'AbortError')) return
        if (error instanceof ApiError && error.offline) {
          setState({ kind: 'offline', reason: error.message })
          return
        }
        setState({
          kind: 'error',
          reason: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      live = false
      controller.abort()
    }
  }, [attempt])

  return { state, recheck: () => setAttempt((value) => value + 1) }
}
