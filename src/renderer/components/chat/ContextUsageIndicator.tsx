import { useCallback, useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { SessionUsage } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import {
  conversationUsageMetrics,
  formatReportedCost,
  formatTokenCount,
  isDisplayableSessionUsage,
  isMeaningfulReportedCost,
  shouldShowSessionUsage
} from './context-usage-utils'

interface ContextUsageIndicatorProps {
  usage: SessionUsage | null | undefined
  /** Pass session messages so bootstrap-only agent reports stay hidden. */
  messages: ReadonlyArray<{ role: string }>
  className?: string
}

const RING_SIZE = 16
const STROKE = 2
const RADIUS = (RING_SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * The context-window details block: percent, tokens, remaining, total in
 * context, reported cost (when meaningful) and the "Reported by agent" note.
 * Shared by the desktop popover and the mobile bottom sheet. The sheet passes
 * `showHeading={false}` because its `SheetTitle` already reads "Context window".
 */
export function ContextUsageDetails({
  usage,
  showHeading = true
}: {
  usage: SessionUsage
  showHeading?: boolean
}): React.JSX.Element {
  const { conversationUsed, conversationSize, percent, remaining, totalUsed, totalSize } =
    conversationUsageMetrics(usage)
  return (
    <>
      <div className="space-y-1 tabular-nums">
        {showHeading && <p className="font-medium text-foreground">Context window</p>}
        <p className="text-muted-foreground">{Math.round(percent)}% conversation used</p>
        <p className="text-muted-foreground">
          {formatTokenCount(conversationUsed)} / {formatTokenCount(conversationSize)} tokens
        </p>
        <p className="text-muted-foreground">{formatTokenCount(remaining)} remaining</p>
        <p className="text-2xs text-muted-foreground">
          Total in context: {formatTokenCount(totalUsed)} / {formatTokenCount(totalSize)}
        </p>
      </div>
      {isMeaningfulReportedCost(usage.cost) && usage.cost && (
        <div className="space-y-0.5 border-t border-border/60 pt-2">
          <p className="text-muted-foreground">Reported cost</p>
          <p className="font-medium tabular-nums text-foreground">
            {formatReportedCost(usage.cost.amount, usage.cost.currency)}
          </p>
        </div>
      )}
      <p className="border-t border-border/60 pt-2 text-2xs text-muted-foreground">
        Reported by agent
      </p>
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
  className
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

  if (!visible || !isDisplayableSessionUsage(visible)) return null

  const { percent } = conversationUsageMetrics(visible)
  const offset = CIRCUMFERENCE * (1 - percent / 100)

  const ring = (
    <button
      type="button"
      aria-label={`Context ${Math.round(percent)} percent used`}
      className={cn(
        'relative inline-flex size-8 shrink-0 items-center justify-center text-muted-foreground transition-[color,transform] ease-out',
        "after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] @[400px]:after:-inset-y-1 pointer-coarse:@[400px]:after:-inset-y-1.5",
        'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
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
          <div className="space-y-2.5 px-2 pb-2 text-sm">
            <ContextUsageDetails usage={visible} showHeading={false} />
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>{ring}</PopoverTrigger>
      <PopoverContent align="start" className="w-56 space-y-2.5 p-3 text-xs">
        <ContextUsageDetails usage={visible} />
      </PopoverContent>
    </Popover>
  )
}
