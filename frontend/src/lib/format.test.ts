import { describe, expect, it } from 'vitest'
import {
  durationSeconds,
  formatBytes,
  formatCount,
  formatDuration,
  formatTime,
} from '@/lib/format'

describe('formatBytes', () => {
  it('stays in bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('steps up a unit at 1024, not 1000', () => {
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
  })

  it('drops the decimal once the number is large enough not to need it', () => {
    expect(formatBytes(1024 * 9.5)).toBe('9.5 KB')
    expect(formatBytes(1024 * 40)).toBe('40 KB')
  })

  it('climbs through the units', () => {
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
  })

  it('does not run off the end of the unit list', () => {
    expect(formatBytes(1024 ** 6)).toMatch(/TB$/)
  })

  it('treats nonsense as zero rather than printing NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
  })
})

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(184203)).toBe('184,203')
    expect(formatCount(0)).toBe('0')
  })
})

describe('formatTime', () => {
  it('trims fractional seconds to milliseconds for display', () => {
    expect(formatTime('2026-09-04T17:30:01.482913Z')).toBe('2026-09-04 17:30:01.482')
  })

  it('keeps a nanosecond timestamp readable without mangling shorter ones', () => {
    expect(formatTime('2026-09-04T17:30:01.482913204Z')).toBe('2026-09-04 17:30:01.482')
    expect(formatTime('2026-09-04T17:30:01Z')).toBe('2026-09-04 17:30:01')
  })
})

describe('durationSeconds and formatDuration', () => {
  it('measures the window between two timestamps', () => {
    expect(
      durationSeconds('2026-09-04T17:30:00.000000Z', '2026-09-04T17:30:17.500000Z'),
    ).toBeCloseTo(17.5, 6)
  })

  it('switches to minutes past sixty seconds', () => {
    expect(formatDuration(17.55)).toBe('17.6s')
    expect(formatDuration(59.9)).toBe('59.9s')
    expect(formatDuration(60)).toBe('1m 0s')
    expect(formatDuration(125)).toBe('2m 5s')
  })

  it('says so rather than printing NaN when a timestamp is unparseable', () => {
    expect(formatDuration(durationSeconds('nope', 'also nope'))).toBe('unknown')
  })
})
