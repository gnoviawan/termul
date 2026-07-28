import { describe, expect, it } from 'vitest'
import {
  contextUsagePercent,
  conversationUsageMetrics,
  formatTokenCount,
  isDisplayableSessionUsage,
  shouldShowSessionUsage
} from './context-usage-utils'

const bootstrapUsage = {
  used: 22_258,
  size: 200_000,
  baselineUsed: 22_258,
  updatedAt: 1,
  source: 'reported' as const
}

describe('context-usage-utils', () => {
  it('formats compact token counts', () => {
    expect(formatTokenCount(842)).toBe('842')
    expect(formatTokenCount(31_400)).toMatch(/31[.,]4K/)
  })

  it('computes capped percentage', () => {
    expect(contextUsagePercent(50_000, 200_000)).toBe(25)
    expect(contextUsagePercent(250_000, 200_000)).toBe(100)
  })

  it('subtracts bootstrap from ACP used totals', () => {
    const metrics = conversationUsageMetrics({
      ...bootstrapUsage,
      used: 22_300
    })
    expect(metrics.conversationUsed).toBe(42)
    expect(metrics.conversationSize).toBe(200_000 - 22_258)
    expect(metrics.percent).toBeLessThan(1)
  })

  it('hides OpenCode-style bootstrap-only short chats', () => {
    expect(shouldShowSessionUsage(bootstrapUsage, [])).toBeNull()
    expect(
      shouldShowSessionUsage({ ...bootstrapUsage, used: 22_280 }, [
        { role: 'user', blocks: [{ type: 'text', text: 'hi' }], timestamp: 1 }
      ])
    ).toBeNull()
  })

  it('shows when conversation fill reaches 1%', () => {
    const usage = {
      ...bootstrapUsage,
      used: 22_258 + Math.ceil(0.01 * (200_000 - 22_258))
    }
    expect(shouldShowSessionUsage(usage, [{ role: 'user', blocks: [], timestamp: 1 }])).toEqual(
      usage
    )
  })

  it('accepts valid reported usage only', () => {
    expect(isDisplayableSessionUsage(bootstrapUsage)).toBe(true)
    expect(isDisplayableSessionUsage(null)).toBe(false)
    expect(
      isDisplayableSessionUsage({
        used: 1,
        size: 0,
        baselineUsed: 0,
        updatedAt: 1,
        source: 'reported'
      })
    ).toBe(false)
  })
})
