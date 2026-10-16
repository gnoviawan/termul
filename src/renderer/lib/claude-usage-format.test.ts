import type { ClaudeAccountUsage, ClaudeUsageWindow } from '@shared/types/claude-accounts.types'
import { describe, expect, it } from 'vitest'
import {
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
})
