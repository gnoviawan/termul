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

export function rejectedRateLimit(message: string): ClaudeRateLimit {
  const kind = /5-hour/i.test(message) ? 'five_hour' : /weekly/i.test(message) ? 'seven_day' : null
  return { status: 'rejected', resetsAt: null, kind, percent: null, overageInUse: false }
}
