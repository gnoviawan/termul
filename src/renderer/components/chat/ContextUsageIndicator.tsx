import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { SessionUsage } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
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
 * Conversation-adjusted context ring from ACP `usage_update`.
 * Hidden when usage is missing, bootstrap-only, or below 1% conversation fill.
 */
export function ContextUsageIndicator({
  usage,
  messages,
  className
}: ContextUsageIndicatorProps): React.JSX.Element | null {
  const visible = shouldShowSessionUsage(usage, messages)
  if (!visible || !isDisplayableSessionUsage(visible)) return null

  const { conversationUsed, conversationSize, percent, remaining, totalUsed, totalSize } =
    conversationUsageMetrics(visible)
  const offset = CIRCUMFERENCE * (1 - percent / 100)

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={`Context ${Math.round(percent)} percent used`}
          className={cn(
            'flex size-8 items-center justify-center text-muted-foreground transition-colors',
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
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-56 space-y-2.5 p-3 text-xs">
        <div className="space-y-1">
          <p className="font-medium text-foreground">Context window</p>
          <p className="text-muted-foreground">{Math.round(percent)}% conversation used</p>
          <p className="text-muted-foreground">
            {formatTokenCount(conversationUsed)} / {formatTokenCount(conversationSize)} tokens
          </p>
          <p className="text-muted-foreground">{formatTokenCount(remaining)} remaining</p>
          <p className="text-3xs text-muted-foreground/80">
            Total in context: {formatTokenCount(totalUsed)} / {formatTokenCount(totalSize)}
          </p>
        </div>
        {isMeaningfulReportedCost(visible.cost) && visible.cost && (
          <div className="space-y-0.5 border-t border-border/60 pt-2">
            <p className="text-muted-foreground">Reported cost</p>
            <p className="font-medium tabular-nums text-foreground">
              {formatReportedCost(visible.cost.amount, visible.cost.currency)}
            </p>
          </div>
        )}
        <p className="border-t border-border/60 pt-2 text-3xs text-muted-foreground">
          Reported by agent
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}
