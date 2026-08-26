import { describe, expect, it } from 'vitest'
import { formatRelativeTime, formatRelativeTimeFromMs } from './git-time'

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

describe('formatRelativeTimeFromMs', () => {
  const now = Date.parse('2026-05-30T12:00:00Z')

  it('returns empty string for non-finite input (NaN/Infinity)', () => {
    expect(formatRelativeTimeFromMs(Number.NaN, now)).toBe('')
    expect(formatRelativeTimeFromMs(Number.POSITIVE_INFINITY, now)).toBe('')
  })

  it('matches formatRelativeTime for the same instant', () => {
    const iso = '2026-05-30T09:00:00Z'
    expect(formatRelativeTimeFromMs(Date.parse(iso), now)).toBe(formatRelativeTime(iso, now))
  })

  it("formats sub-minute as 'now' and clamps future timestamps to 'now'", () => {
    expect(formatRelativeTimeFromMs(now - 30_000, now)).toBe('now')
    expect(formatRelativeTimeFromMs(now + 60_000, now)).toBe('now')
  })

  it('formats minutes, hours, days, and weeks', () => {
    expect(formatRelativeTimeFromMs(now - 5 * 60_000, now)).toBe('5m')
    expect(formatRelativeTimeFromMs(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatRelativeTimeFromMs(now - 2 * 86_400_000, now)).toBe('2d')
    expect(formatRelativeTimeFromMs(now - 14 * 86_400_000, now)).toBe('2w')
  })
})
