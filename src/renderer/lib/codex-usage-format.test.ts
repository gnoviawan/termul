import type { CodexAccountUsage } from '@shared/types/codex-accounts.types'
import { describe, expect, it } from 'vitest'
import { codexChipUsage, codexWindowLabel, primaryCodexWindow } from './codex-usage-format'

const usage = (windows: CodexAccountUsage['windows']): CodexAccountUsage => ({
  accountId: 'default',
  status: 'ok',
  planType: 'plus',
  windows,
  checkedAt: 1,
  message: null
})

describe('codex usage format', () => {
  it('names the 5-hour and weekly windows', () => {
    expect(
      codexWindowLabel({ kind: 'session', percent: 1, resetsAt: null, windowDurationMins: 300 })
    ).toBe('5-hour')
    expect(
      codexWindowLabel({ kind: 'weekly', percent: 1, resetsAt: null, windowDurationMins: 10080 })
    ).toBe('Weekly')
  })

  it('picks the most used window', () => {
    const read = usage([
      { kind: 'session', percent: 40, resetsAt: null, windowDurationMins: 300 },
      { kind: 'weekly', percent: 91, resetsAt: null, windowDurationMins: 10080 }
    ])
    expect(primaryCodexWindow(read)?.kind).toBe('weekly')
    expect(codexChipUsage(read)?.main.short).toBe('5h')
    expect(codexChipUsage(read)?.other?.short).toBe('Wk')
  })

  it('skips a window that has already reset', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const read = usage([
      { kind: 'session', percent: 100, resetsAt: past, windowDurationMins: 300 },
      { kind: 'weekly', percent: 80, resetsAt: future, windowDurationMins: 10080 }
    ])
    expect(primaryCodexWindow(read)?.kind).toBe('weekly')
  })

  it('hides a calm weekly window on the chip', () => {
    const read = usage([
      { kind: 'session', percent: 10, resetsAt: null, windowDurationMins: 300 },
      { kind: 'weekly', percent: 12, resetsAt: null, windowDurationMins: 10080 }
    ])
    expect(codexChipUsage(read)?.other).toBeNull()
  })
})
