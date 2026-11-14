import type { ClaudeRateLimit } from '@shared/types/claude-accounts.types'
import type { SessionUsage } from '@/lib/acp-api'

export function withRateLimit(
  usage: SessionUsage | undefined,
  rateLimit: ClaudeRateLimit
): SessionUsage {
  const base = usage ?? { used: 0, size: 0, baselineUsed: 0, source: 'reported' as const }
  return { ...base, rateLimit, updatedAt: Date.now() }
}

export function withoutRejectedRateLimit(
  sessionUsage: Record<string, SessionUsage>,
  sessionId: string
): { sessionUsage: Record<string, SessionUsage> } | Record<string, never> {
  const usage = sessionUsage[sessionId]
  if (usage?.rateLimit?.status !== 'rejected') return {}
  const { rateLimit: _cleared, ...rest } = usage
  return { sessionUsage: { ...sessionUsage, [sessionId]: rest } }
}

/** Codex adapter plan-limit kinds. A hit uses the last good usage probe for the reset time. */
export function isAdapterPlanLimit(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const kind = 'errorKind' in data ? data.errorKind : undefined
  if (kind === 'rate_limited' || kind === 'quota_exhausted') return true
  const info = 'codexErrorInfo' in data ? data.codexErrorInfo : undefined
  return info === 'usageLimitExceeded' || info === 'rateLimitExceeded'
}

export function rejectedRateLimit(message: string): ClaudeRateLimit {
  const kind = /5-hour/i.test(message) ? 'five_hour' : /weekly/i.test(message) ? 'seven_day' : null
  return { status: 'rejected', resetsAt: null, kind, percent: null, overageInUse: false }
}
