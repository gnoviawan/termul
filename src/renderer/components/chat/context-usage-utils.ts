import type { SessionUsage } from '@/lib/acp-api'

const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1
})

/** Compact token count (e.g. 31.4K, 1.2M). */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1_000) return String(Math.round(value))
  return compact.format(value)
}

/** True when agent-reported usage is safe to show in the UI. */
export function isDisplayableSessionUsage(
  usage: SessionUsage | null | undefined
): usage is SessionUsage {
  if (!usage) return false
  if (!Number.isFinite(usage.used) || !Number.isFinite(usage.size)) return false
  if (!Number.isFinite(usage.baselineUsed)) return false
  if (usage.size <= 0) return false
  if (usage.used <= 0) return false
  return true
}

/**
 * ACP `used` counts every token currently in context (system prompt, tools,
 * history). Subtract the first snapshot so the UI reflects conversation
 * growth instead of a static agent bootstrap block.
 *
 * @see https://agentclientprotocol.com/rfds/session-usage — `used` field
 */
export function conversationUsageMetrics(usage: SessionUsage): {
  conversationUsed: number
  conversationSize: number
  percent: number
  remaining: number
  totalUsed: number
  totalSize: number
} {
  const baseline = Math.min(usage.baselineUsed, usage.used, usage.size)
  const conversationUsed = Math.max(0, usage.used - baseline)
  const conversationSize = Math.max(0, usage.size - baseline)
  const percent = conversationSize > 0 ? contextUsagePercent(conversationUsed, conversationSize) : 0
  return {
    conversationUsed,
    conversationSize,
    percent,
    remaining: Math.max(0, conversationSize - conversationUsed),
    totalUsed: usage.used,
    totalSize: usage.size
  }
}

/**
 * Hide bootstrap-only reports (OpenCode ~22K/200K on session/new) and noise
 * until conversation tokens meaningfully occupy the adjustable window.
 */
export function shouldShowSessionUsage(
  usage: SessionUsage | null | undefined,
  messages: ReadonlyArray<{ role: string }>
): SessionUsage | null {
  if (!isDisplayableSessionUsage(usage)) return null
  if (!messages.some((m) => m.role === 'user')) return null

  const { conversationUsed, percent } = conversationUsageMetrics(usage)
  if (conversationUsed <= 0) return null
  // Sub-1% slivers are usually bootstrap jitter, not actionable context pressure.
  if (Math.round(percent) < 1) return null

  return usage
}

/** True when agent-reported cost is meaningful (non-zero). */
export function isMeaningfulReportedCost(cost: SessionUsage['cost']): boolean {
  return Boolean(cost && Number.isFinite(cost.amount) && cost.amount > 0 && cost.currency)
}

export function contextUsagePercent(used: number, size: number): number {
  return Math.min(100, Math.max(0, (used / size) * 100))
}

export function formatReportedCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 4
    }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}
