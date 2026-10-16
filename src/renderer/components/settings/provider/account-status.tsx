import type {
  ClaudeAccountUsage,
  ClaudeAccountView,
  ClaudeUsageWindow
} from '@shared/types/claude-accounts.types'
import {
  planLabel,
  primaryUsageWindow,
  type UsageTone,
  usageTone,
  usageWindowLabel
} from '@/lib/claude-usage-format'
import { cn } from '@/lib/utils'

export type AccountTone = 'ok' | 'warning' | 'critical' | 'signed-out' | 'waiting' | 'unknown'

export interface AccountStatus {
  tone: AccountTone
  /** The sub-line under the name: plan, then the state in words. */
  meta: string
  /** The window the main meter shows (the most used one). */
  primary: ClaudeUsageWindow | null
}

/** One status for a row, so the dot, the meta words and the meter agree. */
export function accountStatus(
  account: ClaudeAccountView,
  usage: ClaudeAccountUsage | undefined,
  options: { signingIn?: boolean; projectCount?: number } = {}
): AccountStatus {
  const plan = planLabel(usage?.subscriptionType ?? null)
  const withPlan = (words: string): string => (plan ? `${plan} · ${words}` : words)
  const primary = primaryUsageWindow(usage)
  if (options.signingIn) return { tone: 'waiting', meta: withPlan('waiting for browser'), primary }
  if (account.signedIn === false || usage?.status === 'signed_out') {
    return { tone: 'signed-out', meta: withPlan('signed out'), primary: null }
  }
  if (primary) {
    const tone = usageTone(primary.percent)
    if (tone === 'critical') return { tone: 'critical', meta: withPlan('limit reached'), primary }
    if (tone === 'warning') {
      return {
        tone: 'warning',
        meta: withPlan(`near the ${usageWindowLabel(primary)} limit`),
        primary
      }
    }
  }
  if (account.signedIn === null && !usage)
    return { tone: 'unknown', meta: 'Reading usage…', primary }
  const count = options.projectCount ?? 0
  const projects = count === 1 ? '1 project' : count > 1 ? `${count} projects` : null
  return {
    tone: 'ok',
    meta: plan ? (projects ? `${plan} · ${projects}` : plan) : (projects ?? 'Signed in'),
    primary
  }
}

const DOT: Record<AccountTone, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  critical: 'bg-destructive',
  'signed-out': 'bg-warning',
  waiting: 'bg-muted-foreground/50',
  unknown: 'bg-muted-foreground/50'
}

export function StatusDot({ tone }: { tone: AccountTone }): React.JSX.Element {
  return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', DOT[tone])} />
}

const BAR_FILL: Record<UsageTone, string> = {
  normal: 'bg-muted-foreground',
  warning: 'bg-warning',
  critical: 'bg-destructive'
}

export const PERCENT_TEXT: Record<UsageTone, string> = {
  normal: 'text-foreground',
  warning: 'text-warning',
  critical: 'text-destructive'
}

/** A 4px usage track. Any value above zero shows at least a visible sliver. */
export function UsageBar({
  window,
  label,
  valueText
}: {
  window: ClaudeUsageWindow
  label: string
  valueText: string
}): React.JSX.Element {
  const percent = Math.round(window.percent)
  const fill = window.percent > 0 ? Math.min(100, Math.max(1.5, window.percent)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText}
      className="h-1 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none',
          BAR_FILL[usageTone(window.percent)]
        )}
        style={{ width: `${fill}%` }}
      />
    </div>
  )
}
