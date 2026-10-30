import { describe, expect, it } from 'vitest'
import {
  contextUsageBreakdown,
  contextUsagePercent,
  conversationUsageMetrics,
  formatTokenCount,
  isDisplayableSessionUsage,
  nextContextWarning,
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

describe('nextContextWarning', () => {
  it('turns on at 80, holds between 78 and 80, and clears below 78', () => {
    expect(nextContextWarning(false, 79)).toBe(false)
    expect(nextContextWarning(false, 80)).toBe(true)
    expect(nextContextWarning(true, 78)).toBe(true)
    expect(nextContextWarning(true, 77.9)).toBe(false)
  })
})

describe('contextUsageBreakdown', () => {
  it('splits used tokens into setup and conversation and reports tokens left', () => {
    const result = contextUsageBreakdown({
      used: 50_000,
      size: 200_000,
      baselineUsed: 10_000,
      updatedAt: 1,
      source: 'reported'
    })
    expect(result).toEqual({
      setupTokens: 10_000,
      conversationTokens: 40_000,
      setupFraction: 0.05,
      conversationFraction: 0.2,
      left: 150_000
    })
  })

  it('clamps a baseline above used and used above size', () => {
    const result = contextUsageBreakdown({
      used: 250_000,
      size: 200_000,
      baselineUsed: 300_000,
      updatedAt: 1,
      source: 'reported'
    })
    expect(result.setupTokens).toBe(200_000)
    expect(result.conversationTokens).toBe(0)
    expect(result.left).toBe(0)
  })
})
