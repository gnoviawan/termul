import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatChatCreatedTime,
  formatChatFullTime,
  formatRelativeTime,
  formatRelativeTimeFromMs,
  startOfToday,
  startOfYesterday
} from './relative-time'

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

describe('formatChatCreatedTime', () => {
  // Local wall-clock instants, so the day boundaries hold in any time zone.
  const now = new Date(2026, 9, 30, 16, 0).getTime()
  const clock = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  it('shows the clock time for a chat created today', () => {
    const created = new Date(2026, 9, 30, 14, 5).getTime()
    expect(formatChatCreatedTime(created, now)).toBe(clock(created))
  })

  it('names the day for a chat created yesterday, down to its first minute', () => {
    const created = new Date(2026, 9, 29, 0, 0).getTime()
    expect(formatChatCreatedTime(created, now)).toBe(`Yesterday ${clock(created)}`)
    const late = new Date(2026, 9, 29, 23, 59).getTime()
    expect(formatChatCreatedTime(late, now)).toBe(`Yesterday ${clock(late)}`)
  })

  it('shows the clock time from the first minute of today', () => {
    const created = new Date(2026, 9, 30, 0, 0).getTime()
    expect(formatChatCreatedTime(created, now)).toBe(clock(created))
  })

  it.runIf(enUsDefaultLocale)(
    'shows a short date for older chats, with the year only when it differs',
    () => {
      expect(formatChatCreatedTime(new Date(2026, 9, 28, 23, 59).getTime(), now)).toBe('Oct 28')
      expect(formatChatCreatedTime(new Date(2025, 11, 31, 12, 0).getTime(), now)).toBe(
        'Dec 31, 2025'
      )
    }
  )

  it('shows a date, not a clock time, for anything before yesterday', () => {
    const created = new Date(2026, 9, 28, 23, 59).getTime()
    expect(formatChatCreatedTime(created, now)).toBe(
      new Date(created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    )
  })

  it('shows nothing for a missing, zero or non-finite time', () => {
    expect(formatChatCreatedTime(undefined, now)).toBe('')
    expect(formatChatCreatedTime(0, now)).toBe('')
    expect(formatChatCreatedTime(Number.NaN, now)).toBe('')
    expect(formatChatCreatedTime(Number.POSITIVE_INFINITY, now)).toBe('')
  })

  it('reads the clock when now is omitted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const created = new Date(2026, 9, 30, 9, 30).getTime()
    expect(formatChatCreatedTime(created)).toBe(clock(created))
  })
})

describe('startOfYesterday', () => {
  it('is local midnight of the previous calendar day', () => {
    const now = new Date(2026, 9, 30, 16, 0).getTime()
    expect(startOfYesterday(now)).toBe(new Date(2026, 9, 29, 0, 0).getTime())
    expect(startOfToday(now)).toBe(new Date(2026, 9, 30, 0, 0).getTime())
  })

  describe('in a zone with daylight saving', () => {
    const originalTz = process.env.TZ
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    })

    it('steps a calendar day, not 24 h, the day after a DST change', () => {
      process.env.TZ = 'America/New_York'
      // 2026-03-08 is 23 h long (spring forward), 2026-11-01 is 25 h (fall back).
      expect(startOfYesterday(new Date(2026, 2, 9, 12, 0).getTime())).toBe(
        new Date(2026, 2, 8, 0, 0).getTime()
      )
      expect(startOfYesterday(new Date(2026, 10, 2, 12, 0).getTime())).toBe(
        new Date(2026, 10, 1, 0, 0).getTime()
      )
    })
  })
})

describe('formatChatFullTime', () => {
  const now = new Date(2026, 9, 30, 16, 0).getTime()
  const clock = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  it('names today and yesterday with the clock time', () => {
    const today = new Date(2026, 9, 30, 14, 32).getTime()
    const yesterday = new Date(2026, 9, 29, 9, 10).getTime()
    expect(formatChatFullTime(today, now)).toBe(`Today, ${clock(today)}`)
    expect(formatChatFullTime(yesterday, now)).toBe(`Yesterday, ${clock(yesterday)}`)
  })

  it('keeps the clock time on older days', () => {
    const older = new Date(2026, 9, 28, 23, 59).getTime()
    const date = new Date(older).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    expect(formatChatFullTime(older, now)).toBe(`${date}, ${clock(older)}`)
  })

  it('shows nothing for a missing or non-finite time', () => {
    expect(formatChatFullTime(undefined, now)).toBe('')
    expect(formatChatFullTime(Number.NaN, now)).toBe('')
  })
})
