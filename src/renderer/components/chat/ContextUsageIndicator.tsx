import { useCallback, useEffect, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { SessionUsage } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { type CompactPhase, type CompactSignals, useCompactRequest } from './compact-request'
import {
  contextUsageBreakdown,
  conversationUsageMetrics,
  formatReportedCost,
  formatTokenCount,
  isDisplayableSessionUsage,
  isMeaningfulReportedCost,
  nextContextWarning,
  shouldShowSessionUsage
} from './context-usage-utils'
import { RollingText } from './RollingText'

interface ContextUsageIndicatorProps {
  usage: SessionUsage | null | undefined
  /** Pass session messages so bootstrap-only agent reports stay hidden. */
  messages: ReadonlyArray<{ role: string }>
  className?: string
  /** Sends `/compact`. Pass it only when the agent lists a `compact` command. */
  onCompact?: () => void
  /** Session state the Compact button watches so its pending state never sticks. */
  compactSignals?: Omit<CompactSignals, 'usageUpdatedAt'>
}

const IDLE_SIGNALS: Omit<CompactSignals, 'usageUpdatedAt'> = {
  connected: true,
  activeTurn: false,
  compaction: null
}

/** Ring and bar share one curve so they move together. */
const FILL_TRANSITION =
  'transition-[stroke-dashoffset,transform,color] duration-[400ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none'

/** Card grows out of the ring: 350ms open, 250ms close, on the ring's corner. */
const CARD_MOTION =
  'origin-[var(--radix-popover-content-transform-origin)] ease-[cubic-bezier(0.32,0.72,0,1)] data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[state=open]:duration-[350ms] data-[state=closed]:duration-[250ms] motion-reduce:animate-none'

/** Card blocks fade up one after another, 40ms apart. */
const STAGGER_ITEM =
  'animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-200 ease-out motion-reduce:animate-none'

function stagger(index: number): React.CSSProperties {
  return { animationDelay: `${index * 40}ms` }
}

const RING_SIZE = 16
const STROKE = 2
const RADIUS = (RING_SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function useContextWarning(percent: number): boolean {
  const warningRef = useRef(false)
  warningRef.current = nextContextWarning(warningRef.current, percent)
  return warningRef.current
}

/**
 * The context-window details block: a two-part bar (setup and conversation),
 * the two rows that explain it, an optional Compact button, cost when the
 * agent reports one, and a footer with the tokens left.
 * Shared by the desktop popover and the mobile bottom sheet. The sheet passes
 * `showHeading={false}` because its `SheetTitle` already reads "Context window".
 */
export function ContextUsageDetails({
  usage,
  showHeading = true,
  warning,
  onCompact,
  compactPhase = 'idle',
  compactDisabled = false
}: {
  usage: SessionUsage
  showHeading?: boolean
  warning?: boolean
  onCompact?: () => void
  compactPhase?: CompactPhase
  compactDisabled?: boolean
}): React.JSX.Element {
  const { percent } = conversationUsageMetrics(usage)
  const { setupTokens, conversationTokens, setupFraction, conversationFraction, left } =
    contextUsageBreakdown(usage)
  const isWarning = warning ?? nextContextWarning(false, percent)
  const pending = compactPhase === 'pending'
  const leftLabel = `${formatTokenCount(left)} left`
  return (
    <>
      <div className={cn('space-y-2 tabular-nums', STAGGER_ITEM)} style={stagger(0)}>
        {showHeading && (
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-medium text-foreground">Context window</p>
            <RollingText className="text-muted-foreground" text={`${Math.round(percent)}% used`} />
          </div>
        )}
        {!showHeading && (
          <RollingText
            className="block text-muted-foreground"
            text={`${Math.round(percent)}% used`}
          />
        )}
        <div
          className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
          data-testid="context-usage-bar"
          aria-hidden="true"
        >
          <div
            data-segment="setup"
            className="h-full shrink-0 rounded-full bg-foreground/35"
            style={{ width: `${setupFraction * 100}%` }}
          />
          <div className="h-full min-w-0 flex-1">
            <div
              data-segment="conversation"
              className={cn(
                'h-full origin-left rounded-full',
                FILL_TRANSITION,
                isWarning ? 'bg-warning' : 'bg-foreground'
              )}
              style={{
                transform: `scaleX(${
                  setupFraction < 1 ? Math.min(1, conversationFraction / (1 - setupFraction)) : 0
                })`
              }}
            />
          </div>
        </div>
        <dl className="space-y-1 text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <dt className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-foreground/35" aria-hidden="true" />
              Setup
            </dt>
            <dd>{formatTokenCount(setupTokens)}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="flex items-center gap-1.5">
              <span
                className={cn('size-1.5 rounded-full', isWarning ? 'bg-warning' : 'bg-foreground')}
                aria-hidden="true"
              />
              Conversation
            </dt>
            <dd>{formatTokenCount(conversationTokens)}</dd>
          </div>
        </dl>
      </div>
      {onCompact && (
        <button
          type="button"
          onClick={onCompact}
          style={stagger(1)}
          disabled={pending || compactDisabled}
          aria-busy={pending || undefined}
          className={cn(
            'inline-flex h-7 w-full items-center justify-center rounded-md border border-border/60 text-xs font-medium text-foreground transition-colors duration-150',
            'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none',
            STAGGER_ITEM
          )}
        >
          {pending ? 'Compacting…' : 'Compact'}
        </button>
      )}
      {isMeaningfulReportedCost(usage.cost) && usage.cost && (
        <div
          className={cn('space-y-0.5 border-t border-border/60 pt-2', STAGGER_ITEM)}
          style={stagger(2)}
        >
          <p className="text-muted-foreground">Reported cost</p>
          <p className="font-medium tabular-nums text-foreground">
            {formatReportedCost(usage.cost.amount, usage.cost.currency)}
          </p>
        </div>
      )}
      <div
        className={cn(
          'flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-2xs text-muted-foreground',
          STAGGER_ITEM
        )}
        style={stagger(3)}
      >
        <p className={cn(isWarning && 'text-warning')} data-testid="context-left">
          <RollingText text={isWarning ? `Nearing the limit · ${leftLabel}` : leftLabel} />
        </p>
        {compactPhase === 'failed' ? (
          <p
            role="status"
            className="animate-in fade-in-0 duration-150 text-destructive motion-reduce:animate-none"
          >
            Compact didn't finish
          </p>
        ) : (
          <p>Reported by agent</p>
        )}
      </div>
    </>
  )
}

/**
 * Conversation-adjusted context ring from ACP `usage_update`.
 * Hidden when usage is missing, bootstrap-only, or below 1% conversation fill.
 *
 * Desktop opens the details in a popover. The mobile web shell opens the same
 * details in a bottom sheet (a 224px popover clips and collides with the OSK on
 * a phone).
 */
export function ContextUsageIndicator({
  usage,
  messages,
  className,
  onCompact,
  compactSignals = IDLE_SIGNALS
}: ContextUsageIndicatorProps): React.JSX.Element | null {
  // Every hook runs before the early return below so the hook order never
  // depends on whether the ring is currently visible.
  const isMobile = useMobileWebShell()
  const [sheetOpen, setSheetOpen] = useState(false)
  const closeSheet = useCallback(() => setSheetOpen(false), [])
  const visible = shouldShowSessionUsage(usage, messages)
  const ringRendered = Boolean(visible && isDisplayableSessionUsage(visible))
  // The sheet only exists on the mobile shell, so only a mobile sheet registers.
  useOverlayRegistration('context-details-sheet', isMobile && sheetOpen && ringRendered, closeSheet)
  // A hidden ring, or a shell flip to desktop (the `Sheet` unmounts), must not
  // leave the sheet armed: Back would consume a phantom overlay and flipping
  // back would pop the sheet open again.
  useEffect(() => {
    if (!ringRendered || !isMobile) setSheetOpen(false)
  }, [ringRendered, isMobile])
  const compact = useCompactRequest(
    { ...compactSignals, usageUpdatedAt: usage?.updatedAt ?? null },
    onCompact
  )
  const warning = useContextWarning(
    visible && isDisplayableSessionUsage(visible) ? conversationUsageMetrics(visible).percent : 0
  )

  if (!visible || !isDisplayableSessionUsage(visible)) return null

  const { percent, remaining } = conversationUsageMetrics(visible)
  const offset = CIRCUMFERENCE * (1 - percent / 100)
  const details = (showHeading: boolean) => (
    <ContextUsageDetails
      usage={visible}
      showHeading={showHeading}
      warning={warning}
      onCompact={onCompact ? compact.request : undefined}
      compactPhase={compact.phase}
      compactDisabled={compactSignals.activeTurn || !compactSignals.connected}
    />
  )

  const ring = (
    <button
      type="button"
      aria-label={`Context ${Math.round(percent)} percent used, ${formatTokenCount(remaining)} left${
        warning ? ', nearing the limit' : ''
      }`}
      data-warning={warning || undefined}
      className={cn(
        'relative inline-flex size-8 shrink-0 items-center justify-center transition-[color,transform] ease-out',
        warning ? 'text-warning' : 'text-muted-foreground hover:text-foreground',
        "after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] @[400px]:after:-inset-y-1",
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className
      )}
    >
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="shrink-0 -rotate-90"
        role="presentation"
        focusable="false"
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.22}
          strokeWidth={STROKE}
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          className={FILL_TRANSITION}
        />
      </svg>
    </button>
  )

  if (isMobile) {
    return (
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetTrigger asChild>{ring}</SheetTrigger>
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          className="flex max-h-[85dvh] flex-col gap-0 overflow-y-auto overscroll-contain p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="space-y-0 px-2 py-2 pr-10 text-left">
            <SheetTitle className="text-base">Context window</SheetTitle>
          </SheetHeader>
          <div className="space-y-2.5 px-2 pb-2 text-sm">{details(false)}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>{ring}</PopoverTrigger>
      <PopoverContent align="start" className={cn('w-56 space-y-2.5 p-3 text-xs', CARD_MOTION)}>
        {details(true)}
      </PopoverContent>
    </Popover>
  )
}
