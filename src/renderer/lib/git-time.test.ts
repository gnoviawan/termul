import { describe, expect, it } from 'vitest'
import { formatRelativeTime } from './git-time'

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-05-30T12:00:00Z')

  it('returns empty string for invalid input', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('')
    expect(formatRelativeTime('', now)).toBe('')
  })

  it("formats sub-minute as 'now'", () => {
    expect(formatRelativeTime('2026-05-30T11:59:30Z', now)).toBe('now')
  })

  it('formats minutes, hours, days, and weeks', () => {
    expect(formatRelativeTime('2026-05-30T11:55:00Z', now)).toBe('5m')
    expect(formatRelativeTime('2026-05-30T09:00:00Z', now)).toBe('3h')
    expect(formatRelativeTime('2026-05-28T12:00:00Z', now)).toBe('2d')
    expect(formatRelativeTime('2026-05-16T12:00:00Z', now)).toBe('2w')
  })

  it("clamps future timestamps to 'now'", () => {
    expect(formatRelativeTime('2026-05-30T12:05:00Z', now)).toBe('now')
  })

  it('falls back to a date for old timestamps', () => {
    // ~12 weeks earlier: beyond the 8-week relative window.
    const result = formatRelativeTime('2026-03-01T12:00:00Z', now)
    expect(result).not.toBe('')
    expect(result).not.toMatch(/^\d+[mhdw]$/)
  })
})
