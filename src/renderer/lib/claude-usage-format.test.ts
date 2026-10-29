import type {
  ClaudeAccountUsage,
  ClaudeRateLimit,
  ClaudeUsageWindow
} from '@shared/types/claude-accounts.types'
import { describe, expect, it } from 'vitest'
import {
  fiveHourUsage,
  formatUsageChecked,
  formatUsageReset,
  planLabel,
  primaryUsageWindow,
  usageTone,
  usageWindowLabel
} from './claude-usage-format'

const window = (kind: string, percent: number, scope: string | null = null): ClaudeUsageWindow => ({
  kind,
  group: null,
  scope,
  percent,
  resetsAt: null,
  severity: null
})

const NOW = Date.parse('2026-10-13T10:00:00Z')

describe('claude usage format', () => {
  it('names the windows in plain words', () => {
    expect(usageWindowLabel(window('session', 0))).toBe('5-hour')
    expect(usageWindowLabel(window('weekly_all', 0))).toBe('Weekly')
    expect(usageWindowLabel(window('weekly_scoped', 0, 'Opus'))).toBe('Weekly · Opus')
    expect(usageWindowLabel(window('monthly_extra', 0))).toBe('Monthly extra')
  })

  it('tones a window by how much is used', () => {
    expect(usageTone(79)).toBe('normal')
    expect(usageTone(80)).toBe('warning')
    expect(usageTone(100)).toBe('critical')
  })

  it('formats the time to the reset', () => {
    expect(formatUsageReset(null, NOW)).toBeNull()
    expect(formatUsageReset('not a date', NOW)).toBeNull()
    expect(formatUsageReset('2026-10-13T10:00:20Z', NOW)).toBe('resets now')
    expect(formatUsageReset('2026-10-13T10:45:00Z', NOW)).toBe('resets in 45m')
    expect(formatUsageReset('2026-10-13T12:14:00Z', NOW)).toBe('resets in 2h 14m')
    expect(formatUsageReset('2026-10-13T13:00:00Z', NOW)).toBe('resets in 3h')
    expect(formatUsageReset('2026-10-16T10:00:00Z', NOW)).toBe('resets in 3d')
    expect(formatUsageReset(NOW / 1000 + 3600, NOW)).toBe('resets in 1h')
  })

  it('formats when the usage was read', () => {
    expect(formatUsageChecked(NOW - 10_000, NOW)).toBe('Updated just now')
    expect(formatUsageChecked(NOW - 4 * 60_000, NOW)).toBe('Updated 4m ago')
    expect(formatUsageChecked(NOW - 3 * 3_600_000, NOW)).toBe('Updated 3h ago')
  })

  it('picks the most used window, only for a good read', () => {
    const usage: ClaudeAccountUsage = {
      accountId: 'a',
      status: 'ok',
      subscriptionType: 'max',
      windows: [window('session', 12), window('weekly_all', 40)],
      checkedAt: NOW,
      message: null
    }
    expect(primaryUsageWindow(usage)?.kind).toBe('weekly_all')
    expect(primaryUsageWindow({ ...usage, status: 'error' })).toBeNull()
    expect(primaryUsageWindow(undefined)).toBeNull()
    expect(planLabel('max')).toBe('Max')
    expect(planLabel(null)).toBeNull()
  })

  describe('fiveHourUsage', () => {
    const read = (...windows: ClaudeUsageWindow[]): ClaudeAccountUsage => ({
      accountId: 'a',
      status: 'ok',
      subscriptionType: 'max',
      windows,
      checkedAt: NOW,
      message: null
    })
    const live = (kind: string | null, percent: number | null): ClaudeRateLimit => ({
      status: 'allowed',
      resetsAt: null,
      kind,
      percent,
      overageInUse: false
    })

    it('leads with the 5-hour window and keeps the most used other window beside it', () => {
      const usage = read(
        window('session', 42.4),
        window('weekly_all', 61),
        window('weekly_scoped', 86.6, 'Opus')
      )
      expect(fiveHourUsage(usage, null)).toEqual({
        main: { short: '5h', label: '5-hour', percent: 42, tone: 'normal' },
        other: { short: 'Wk', label: 'Weekly · Opus', percent: 87, tone: 'warning' }
      })
    })

    it('takes a live 5-hour reading over the polled one', () => {
      const usage = read(window('session', 12), window('weekly_all', 40))
      expect(fiveHourUsage(usage, live('five_hour', 83))).toEqual({
        main: { short: '5h', label: '5-hour', percent: 83, tone: 'warning' },
        other: { short: 'Wk', label: 'Weekly', percent: 40, tone: 'normal' }
      })
    })

    it('drops a live reading once its window has reset', () => {
      const usage = read(window('session', 3))
      const past = { ...live('five_hour', 97), resetsAt: Math.floor(NOW / 1000) - 60 }
      const future = { ...live('five_hour', 97), resetsAt: Math.floor(NOW / 1000) + 60 }
      expect(fiveHourUsage(usage, past, NOW)?.main.percent).toBe(3)
      expect(fiveHourUsage(usage, future, NOW)?.main.percent).toBe(97)
    })

    it('takes a live weekly reading as the weekly window, not the 5-hour one', () => {
      const usage = read(window('session', 12), window('weekly_all', 40))
      expect(fiveHourUsage(usage, live('seven_day', 100))).toEqual({
        main: { short: '5h', label: '5-hour', percent: 12, tone: 'normal' },
        other: { short: 'Wk', label: 'Weekly', percent: 100, tone: 'critical' }
      })
      expect(fiveHourUsage(undefined, live('seven_day_sonnet', 90))).toEqual({
        main: { short: 'Wk', label: 'Weekly · Sonnet', percent: 90, tone: 'warning' },
        other: null
      })
    })

    it('falls back to the most used window, labeled, without a 5-hour window', () => {
      expect(
        fiveHourUsage(read(window('weekly_all', 30), window('monthly_extra', 55)), null)
      ).toEqual({
        main: { short: 'Monthly extra', label: 'Monthly extra', percent: 55, tone: 'normal' },
        other: null
      })
      expect(fiveHourUsage(read(window('session', 7)), null)).toEqual({
        main: { short: '5h', label: '5-hour', percent: 7, tone: 'normal' },
        other: null
      })
    })

    it('is empty without a good read or a live percent', () => {
      expect(fiveHourUsage(undefined, null)).toBeNull()
      expect(fiveHourUsage({ ...read(window('session', 50)), status: 'error' }, null)).toBeNull()
      expect(fiveHourUsage(read(), live('five_hour', null))).toBeNull()
    })
  })
})
