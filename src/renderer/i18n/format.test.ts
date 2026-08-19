import { describe, expect, it } from 'vitest'
import { formatDateTime, formatNumber, formatRelative } from './format'
import { initializeI18n } from './index'

describe('locale formatting', () => {
  it('uses the selected UI language for numbers', async () => {
    await initializeI18n('zh-CN')
    expect(formatNumber(12345.6)).toBe(new Intl.NumberFormat('zh-CN').format(12345.6))
  })

  it('uses the selected UI language for dates and relative time', async () => {
    const date = new Date('2026-01-02T03:04:00Z')
    await initializeI18n('en')
    expect(formatDateTime(date)).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    )
    expect(formatRelative(-1, 'day')).toBe(new Intl.RelativeTimeFormat('en').format(-1, 'day'))
  })
})
