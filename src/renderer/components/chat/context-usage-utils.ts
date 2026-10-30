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

/**
 * The percent shown to the user (number, ring, aria-label): all used tokens,
 * setup included, of the full window, so it matches the bar. The 80/78
 * warning uses it too.
 */
export function displayedUsagePercent(usage: SessionUsage): number {
  return usage.size > 0 ? contextUsagePercent(Math.max(0, usage.used), usage.size) : 0
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

/** Warning turns on at 80% and clears below 78%, so it never flickers at the edge. */
export const CONTEXT_WARNING_ON = 80
export const CONTEXT_WARNING_OFF = 78

export function nextContextWarning(previous: boolean, percent: number): boolean {
  // Compare the rounded percent the label shows, so "80%" always means warning.
  const shown = Math.round(percent)
  if (shown >= CONTEXT_WARNING_ON) return true
  if (shown < CONTEXT_WARNING_OFF) return false
  return previous
}

/**
 * The two parts of the window the agent tells us about: the first report
 * (system prompt, tools) and everything the conversation added after it.
 * ACP has no finer breakdown, so the UI shows exactly these two.
 */
export function contextUsageBreakdown(usage: SessionUsage): {
  setupTokens: number
  conversationTokens: number
  setupFraction: number
  conversationFraction: number
  left: number
} {
  const size = Math.max(0, usage.size)
  const used = Math.min(Math.max(0, usage.used), size)
  const setupTokens = Math.min(Math.max(0, usage.baselineUsed), used)
  const conversationTokens = used - setupTokens
  return {
    setupTokens,
    conversationTokens,
    setupFraction: size > 0 ? setupTokens / size : 0,
    conversationFraction: size > 0 ? conversationTokens / size : 0,
    left: size - used
  }
}
