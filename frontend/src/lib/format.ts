import type { Timestamp } from '@/types/graph'

// Number and timestamp formatting for display. Pure, no React, no scales --
// how big to draw something and how to spell it are different jobs.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Human-readable byte count. The caller is responsible for labelling *which*
 * byte count it is: frame_bytes and payload_bytes are different numbers and
 * must never be summed.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const label = UNITS[unit] ?? 'B'
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${label}`
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * Trim the fractional seconds to milliseconds for display. The full-precision
 * RFC 3339 string stays in the document untouched -- a nanosecond capture
 * keeps its low digits even though no one wants to read them on screen.
 */
export function formatTime(iso: Timestamp): string {
  return iso
    .replace('T', ' ')
    .replace(/(\.\d{3})\d*Z$/, '$1')
    .replace(/Z$/, '')
}

export function durationSeconds(startIso: Timestamp, endIso: Timestamp): number {
  return (Date.parse(endIso) - Date.parse(startIso)) / 1000
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}
