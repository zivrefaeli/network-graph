import { useState } from 'react'

const PREFIX = 'network-graph:collapsed:'

/**
 * localStorage throws rather than returning null when site data is blocked --
 * private windows, and browsers set to refuse it. A remembered panel state is
 * not worth a blank screen, so both directions swallow it and fall back to
 * "expanded", which is the state that shows the user everything.
 */
function readCollapsed(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(PREFIX + key)
    return stored === null ? fallback : stored === 'true'
  } catch {
    return fallback
  }
}

function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(PREFIX + key, String(collapsed))
  } catch {
    // Nothing to do. The toggle still works for the rest of this session.
  }
}

/**
 * Whether a panel is collapsed, remembered across reloads.
 *
 * Per-panel rather than lifted into App: which chrome you keep open is a
 * durable preference about the tool, not part of the document being read, and
 * it has no business invalidating on a new capture the way selection does.
 *
 * `initial` is only a starting point -- somewhere to be on a screen that has
 * never said otherwise. Once the panel has been toggled by hand, that choice
 * wins and keeps winning, so a phone-sized default never overrides it.
 */
export function useCollapsed(key: string, initial = false): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(key, initial))

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    writeCollapsed(key, next)
  }

  return [collapsed, toggle]
}
