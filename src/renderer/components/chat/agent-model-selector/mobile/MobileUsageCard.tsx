import { useChatClaudeAccount } from '@/components/chat/claude-account/use-chat-claude-account'
import { type CompactSignals, useCompactRequest } from '@/components/chat/compact-request'
import { displayedUsagePercent } from '@/components/chat/context-usage-utils'
import { accountReadiness } from '@/components/settings/provider/account-status'
import { SheetGroup, SheetRow } from '@/components/ui/mobile-sheet'
import type { SessionUsage } from '@/lib/acp-api'
import {
  fiveHourUsage,
  type UsageReading,
  type UsageTone,
  usageTone
} from '@/lib/claude-usage-format'
import { cn } from '@/lib/utils'

/** What the Context row's Compact needs; the same handler and signals as the ring. */
export interface CompactControl {
  onCompact: (() => void) | undefined
  signals: Omit<CompactSignals, 'usageUpdatedAt'>
}

const TONE_TEXT: Record<UsageTone, string> = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  critical: 'text-destructive'
}

const TONE_FILL: Record<UsageTone, string> = {
  normal: 'bg-foreground/70',
  warning: 'bg-warning',
  critical: 'bg-destructive'
}

/** The Claude account's 5-hour window; null for a chat without a signed-in managed account. */
function useClaudeUsage(sessionId: string): { reading: UsageReading; account: string } | null {
  const ctx = useChatClaudeAccount(sessionId)
  if (!ctx || accountReadiness(ctx.current.account, ctx.current.usage) !== 'ready') return null
  const reading = fiveHourUsage(ctx.current.usage, ctx.rateLimit)?.main
  return reading ? { reading, account: ctx.current.account.name } : null
}

function ContextRow({
  usage,
  compact
}: {
  usage: SessionUsage
  compact: CompactControl | null
}): React.JSX.Element {
  const percent = Math.round(displayedUsagePercent(usage))
  const tone = usageTone(percent)
  const request = useCompactRequest(
    { ...(compact?.signals ?? IDLE), usageUpdatedAt: usage.updatedAt ?? null },
    compact?.onCompact
  )
  const pending = request.phase === 'pending'
  const blocked = !compact || compact.signals.activeTurn || !compact.signals.connected
  return (
    <SheetRow
      title="Context"
      subtitle={
        <span className="mt-1.5 flex flex-col gap-1">
          <span
            aria-hidden="true"
            className="block h-1.5 w-32 overflow-hidden rounded-full bg-foreground/10"
          >
            <span
              className={cn('block h-full rounded-full', TONE_FILL[tone])}
              style={{ width: `${percent}%` }}
            />
          </span>
          {request.phase === 'failed' ? (
            <span className="text-destructive">Compact didn't finish</span>
          ) : null}
        </span>
      }
      value={<span className="tabular-nums">{percent}%</span>}
      aside={
        compact?.onCompact ? (
          <button
            type="button"
            onClick={request.request}
            disabled={pending || blocked}
            aria-busy={pending || undefined}
            className="my-2 mr-3 shrink-0 self-center rounded-full bg-foreground/[0.08] px-3 py-2 text-sm font-medium text-foreground transition-colors duration-150 ease-out enabled:active:bg-foreground/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-disabled-foreground"
          >
            {pending ? 'Compacting…' : 'Compact'}
          </button>
        ) : undefined
      }
    />
  )
}

const IDLE: CompactControl['signals'] = { connected: false, activeTurn: false, compaction: null }

/** Account usage and the context window, each only when there is a reading. */
export function UsageCard({
  sessionId,
  usage,
  compact
}: {
  sessionId: string
  usage: SessionUsage | null
  compact: CompactControl | null
}): React.JSX.Element | null {
  const claude = useClaudeUsage(sessionId)
  if (!claude && !usage) return null
  return (
    <SheetGroup>
      {claude ? (
        <SheetRow
          title="Usage"
          subtitle={`${claude.reading.label} limit · ${claude.account}`}
          value={
            <span className={cn('tabular-nums', TONE_TEXT[claude.reading.tone])}>
              {claude.reading.percent}%
            </span>
          }
        />
      ) : null}
      {usage ? <ContextRow usage={usage} compact={compact} /> : null}
    </SheetGroup>
  )
}
