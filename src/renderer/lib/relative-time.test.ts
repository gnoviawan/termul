import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime, formatRelativeTimeFromMs } from './relative-time'

const enUsDefaultLocale = Intl.DateTimeFormat().resolvedOptions().locale === 'en-US'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

afterEach(() => {
  vi.useRealTimers()
})

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

  it.runIf(enUsDefaultLocale)('falls back to a short date for old timestamps', () => {
    expect(formatRelativeTime('2026-03-01T12:00:00Z', now)).toBe('Mar 1, 2026')
  })

  it('reads the clock when now is omitted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    expect(formatRelativeTime('2026-05-30T09:00:00Z')).toBe('3h')
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

  it.each([
    [59 * SECOND, 'now'],
    [MINUTE, '1m'],
    [59 * MINUTE + 59 * SECOND, '59m'],
    [HOUR, '1h'],
    [23 * HOUR + 59 * MINUTE, '23h'],
    [DAY, '1d'],
    [6 * DAY + 23 * HOUR, '6d'],
    [7 * DAY, '1w'],
    [55 * DAY, '7w']
  ])('formats an age of %ims as %s', (age, expected) => {
    expect(formatRelativeTimeFromMs(now - age, now)).toBe(expected)
  })

  it.runIf(enUsDefaultLocale)('falls back to a short date at 8 weeks', () => {
    expect(formatRelativeTimeFromMs(now - 56 * DAY, now)).toBe('Apr 4, 2026')
  })

  it('reads the clock when now is omitted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    expect(formatRelativeTimeFromMs(now - MINUTE)).toBe('1m')
  })
})
