import type { ReactNode } from 'react'
import { EntryGlyph } from '@/components/agents/launcher/pickers'
import { ArrowRightLeft, Check, Download } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'
import type { SessionUsage } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import {
  conversationUsageMetrics,
  formatReportedCost,
  formatTokenCount,
  isMeaningfulReportedCost
} from '../context-usage-utils'
import { SegmentedTrack } from './SegmentedTrack'
import type { AgentTab } from './selector-model'
import type { SelectorModelStatus } from './selector-source'

export const ROW =
  'group flex w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring enabled:active:scale-[0.96] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-60'

export function rowSize(touch: boolean): string {
  return touch ? 'min-h-11 py-2.5' : 'min-h-8 py-1.5'
}

export function TabGlyph({ tab }: { tab: AgentTab }): React.JSX.Element {
  return (
    <EntryGlyph
      config={tab.config}
      templateId={tab.entry?.agent.id ?? tab.config?.templateId}
      name={tab.name}
    />
  )
}

/** One model. Selected = a check only, no fill (the fill means hover or focus). */
export function ModelRow({
  name,
  description,
  selected,
  glyph,
  meta,
  disabled,
  touch,
  onPick
}: {
  name: string
  description?: string | null
  selected: boolean
  glyph?: ReactNode
  meta?: string
  disabled: boolean
  touch: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-selector-row=""
      aria-pressed={selected}
      title={description ?? undefined}
      disabled={disabled}
      data-press-feedback="off"
      onClick={onPick}
      className={cn(ROW, rowSize(touch))}
    >
      {glyph ? <span className="inline-flex shrink-0">{glyph}</span> : null}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {meta ? <span className="shrink-0 text-xs text-muted-foreground">{meta}</span> : null}
      <Check
        size={14}
        aria-hidden="true"
        className={cn('shrink-0', selected ? 'opacity-100' : 'opacity-0')}
      />
    </button>
  )
}

/** One agent in the "More" list or a search result for an agent name. */
export function AgentRow({
  tab,
  badge,
  disabled,
  touch,
  onPick
}: {
  tab: AgentTab
  badge: string | null
  disabled: boolean
  touch: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-selector-row=""
      disabled={disabled}
      data-press-feedback="off"
      data-testid={`selector-agent-${tab.configId}`}
      onClick={onPick}
      className={cn(ROW, rowSize(touch))}
    >
      <TabGlyph tab={tab} />
      <span className="min-w-0 flex-1 truncate">{tab.name}</span>
      {badge ? (
        <span className="shrink-0 rounded bg-foreground/[0.08] px-1.5 py-0.5 text-3xs text-muted-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

export function Hint({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
      <ArrowRightLeft size={12} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** A short message sized like two rows, so the panel does not jump. */
export function ListMessage({
  title,
  detail,
  loading
}: {
  title: string
  detail?: string
  loading?: boolean
}): React.JSX.Element {
  return (
    <div role="status" className="flex min-h-16 flex-col justify-center gap-0.5 px-2 py-1.5">
      <p className="flex items-center gap-1.5 text-sm text-foreground">
        {loading ? <Spinner size={12} decorative /> : null}
        {title}
      </p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

/** Busy chat: the status line and the Wait / Cancel turn and switch track. */
export function BusyBlock({
  agentName,
  canCancel,
  touch,
  onWait,
  onCancelAndSwitch
}: {
  agentName: string
  canCancel: boolean
  touch: boolean
  onWait: () => void
  onCancelAndSwitch: () => void
}): React.JSX.Element {
  return (
    <div data-testid="agent-switch-busy" className="flex flex-col gap-2 pt-1.5">
      <p role="status" className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
        <Spinner size={12} decorative />
        {canCancel
          ? `${agentName} is working on a turn.`
          : 'This chat is busy. Wait for the queued prompts or the open request to finish.'}
      </p>
      <SegmentedTrack
        id="busy-actions"
        label="Switch actions"
        touch={touch}
        items={[
          { key: 'wait', label: 'Wait', span: canCancel ? 2 : 5, onSelect: onWait },
          ...(canCancel
            ? [
                {
                  key: 'cancel',
                  label: 'Cancel turn and switch',
                  span: 3,
                  tone: 'primary' as const,
                  onSelect: onCancelAndSwitch,
                  testId: 'agent-switch-cancel-then-switch'
                }
              ]
            : [])
        ]}
      />
    </div>
  )
}

/** A tab for an agent that is not ready: install it, or the reason it cannot run. */
export function InstallState({
  tab,
  reason,
  installing,
  installBlocked,
  touch,
  onInstall
}: {
  tab: AgentTab
  reason: string | null
  installing: boolean
  installBlocked: boolean
  touch: boolean
  onInstall: (() => void) | null
}): React.JSX.Element {
  if (reason || !onInstall) {
    return (
      <ListMessage
        title={`${tab.name} is not available`}
        detail={reason ?? 'Set it up in Settings to use it here.'}
      />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <ListMessage
        title={`${tab.name} is not installed`}
        detail="Install it to use its models in this chat."
      />
      <SegmentedTrack
        id="install-action"
        label="Install"
        touch={touch}
        items={[
          {
            key: 'install',
            span: 5,
            selected: true,
            disabled: installing || installBlocked,
            label: installing ? (
              <>
                <Spinner size={12} decorative />
                Installing…
              </>
            ) : (
              <>
                <Download size={12} aria-hidden="true" />
                {`Install ${tab.name}`}
              </>
            ),
            onSelect: onInstall,
            testId: `agent-install-${tab.configId}`
          }
        ]}
      />
    </div>
  )
}

/**
 * The launcher's model-list problems (setup error, sign-in) with their fixes:
 * Sign in when the agent asks for it, else Try again. `compact` is the line
 * under a list from the cache.
 */
export function StatusActions({
  title,
  detail,
  status,
  touch,
  compact = false
}: {
  title: string
  detail?: string
  status: SelectorModelStatus
  touch: boolean
  compact?: boolean
}): React.JSX.Element {
  const items = [
    ...(status.onSignIn
      ? [
          {
            key: 'sign-in',
            label: status.signInLabel ?? 'Sign in',
            span: status.onRetry ? 3 : 5,
            tone: 'primary' as const,
            onSelect: status.onSignIn,
            testId: 'selector-sign-in'
          }
        ]
      : []),
    ...(status.onRetry
      ? [
          {
            key: 'retry',
            label: 'Try again',
            span: status.onSignIn ? 2 : 5,
            selected: !status.onSignIn,
            onSelect: status.onRetry,
            testId: 'selector-retry'
          }
        ]
      : [])
  ]
  return (
    <div className={cn('flex flex-col', compact ? 'gap-1.5 pt-1.5' : 'gap-2')}>
      {compact ? (
        <div className="flex flex-col gap-0.5">
          <p role="status" className="px-2 text-xs text-muted-foreground">
            {title}
          </p>
          {detail ? <p className="px-2 text-xs text-muted-foreground">{detail}</p> : null}
        </div>
      ) : (
        <ListMessage title={title} detail={detail} />
      )}
      {items.length > 0 ? (
        <SegmentedTrack
          id="model-status-actions"
          label="Model list actions"
          touch={touch}
          items={items}
        />
      ) : null}
    </div>
  )
}

/**
 * Session context usage as a passive row: conversation growth against the
 * adjustable window, with the full breakdown (total window, remaining,
 * reported cost) in the tooltip. The composer's ring (ContextUsageIndicator)
 * stays the primary meter; this repeats it where options are set.
 */
export function ContextSummary({
  usage,
  touch
}: {
  usage: SessionUsage
  touch: boolean
}): React.JSX.Element {
  const metrics = conversationUsageMetrics(usage)
  const cost = usage.cost
  const costTitle =
    cost && isMeaningfulReportedCost(cost)
      ? ` Reported cost: ${formatReportedCost(cost.amount, cost.currency)}.`
      : ''
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 px-2 tabular-nums',
        touch ? 'min-h-11 py-2.5' : 'min-h-8 py-1.5'
      )}
      title={`Context window: ${formatTokenCount(metrics.totalSize)} tokens. ${formatTokenCount(metrics.remaining)} remaining.${costTitle}`}
    >
      <span className="shrink-0 text-muted-foreground">Context</span>
      <span className="min-w-0 truncate text-muted-foreground">
        {formatTokenCount(metrics.conversationUsed)} / {formatTokenCount(metrics.conversationSize)}
        <span className="text-foreground"> · {Math.round(metrics.percent)}%</span>
      </span>
    </div>
  )
}
