import { apiBase } from '@/api/client'
import type { HealthState } from '@/hooks/useHealth'

interface HealthStripProps {
  state: HealthState
  onRecheck: () => void
}

/**
 * One line saying whether captures can be uploaded, and why not if they cannot.
 *
 * The distinction that matters is between "no backend" and "backend up but no
 * tshark". The first is the normal state of the static build and is stated
 * plainly; the second is a broken deployment and is a warning, because a
 * server that answers /health but cannot dissect anything would otherwise look
 * healthy right up until the first upload fails.
 */
export function HealthStrip({ state, onRecheck }: HealthStripProps) {
  if (state.kind === 'checking') {
    return (
      <p className="health health-checking" role="status">
        <span className="health-dot" />
        Looking for a backend…
      </p>
    )
  }

  if (state.kind === 'ready' && state.health.tshark_available) {
    return (
      <p className="health health-ok" role="status">
        <span className="health-dot" />
        Backend ready
        <span className="health-detail">{state.health.tshark_version}</span>
      </p>
    )
  }

  if (state.kind === 'ready') {
    return (
      <p className="health health-warn" role="status">
        <span className="health-dot" />
        Backend up, but it has no dissector
        <span className="health-detail">
          {state.health.tshark_error ?? 'tshark was not found on the server.'}
        </span>
        <Recheck onRecheck={onRecheck} />
      </p>
    )
  }

  const warn = state.kind === 'error'
  return (
    <p className={`health ${warn ? 'health-warn' : 'health-offline'}`} role="status">
      <span className="health-dot" />
      {warn ? 'Backend error' : 'No backend'}
      <span className="health-detail">
        {state.reason}
        {state.kind === 'offline' && apiBase ? ` Looked at ${apiBase}.` : ''}
      </span>
      <Recheck onRecheck={onRecheck} />
    </p>
  )
}

function Recheck({ onRecheck }: { onRecheck: () => void }) {
  return (
    <button type="button" className="link-button" onClick={onRecheck}>
      Retry
    </button>
  )
}
