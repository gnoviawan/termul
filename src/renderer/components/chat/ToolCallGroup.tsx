import { motion, useReducedMotion } from 'framer-motion'
import { memo, useEffect, useRef, useState } from 'react'
import { ChevronRight } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import { CHAT_ROW_MIN_H } from './chat-layout'
import { CHEVRON_TRANSITION } from './chat-motion'
import type { TimelineItem } from './chat-timeline'
import { RowReveal } from './RowReveal'
import { ThinkingStatus } from './ThinkingStatus'
import { ToolCallCard } from './ToolCallCard'
import type { ToolActivitySummary } from './tool-call-summary'
import type { EnterTracker } from './use-enter-tracker'

export type ToolTimelineItem = Extract<TimelineItem, { kind: 'tool' }>

interface DiffStatProps {
  added: number
  removed: number
}

/**
 * Aggregate `+N −N` chip for a turn's tool calls. `+N` shows whenever either
 * side is non-zero; `−N` only when lines came out — the same shape
 * `describeToolCall` gives a single edit's detail.
 */
export function DiffStat({ added, removed }: DiffStatProps): React.JSX.Element | null {
  if (added <= 0 && removed <= 0) return null
  return (
    <span className="shrink-0 text-2xs tabular-nums">
      <span className="text-success">+{added}</span>
      {removed > 0 && <span className="text-destructive"> &minus;{removed}</span>}
    </span>
  )
}

interface ToolCallGroupProps {
  /** The turn's tool calls, in timeline order. */
  items: ToolTimelineItem[]
  /** Categorized rollup on the trigger line — "Ran 2 commands, created 1 file". */
  summary: ToolActivitySummary
  /** The parent turn is still running. */
  active: boolean
  /** True while this run owns the turn's last timeline item — its live edge. */
  isLiveTail: boolean
  attentionRequired: boolean
  enter: EnterTracker
  filePathContext?: FilePathResolutionContext
  onOpenSubagent: (toolCall: ToolCall) => void
}

/**
 * One nested disclosure rolling up the turn's tool calls; expanding lists
 * every call's card. Mirrors the thought group: open while the run is the
 * turn's live edge, and once activity moves past it — or the turn settles —
 * it stays open only when a call needs a look: an unfinished or failed call
 * sits one click deep, not two. A manual toggle sticks (userOverride) until
 * a call newly needs attention, which re-arms the auto-drive.
 */
function ToolCallGroupComponent({
  items,
  summary,
  active,
  isLiveTail,
  attentionRequired,
  enter,
  filePathContext,
  onOpenSubagent
}: ToolCallGroupProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const [open, setOpen] = useState(isLiveTail || attentionRequired)
  const userOverride = useRef(false)
  const wasAttentionRequired = useRef(attentionRequired)

  useEffect(() => {
    // A call that newly needs attention is a fresh event: it re-arms the
    // auto-drive even after a manual toggle.
    if (attentionRequired && !wasAttentionRequired.current) userOverride.current = false
    wasAttentionRequired.current = attentionRequired
    if (userOverride.current) return
    setOpen(isLiveTail || attentionRequired)
  }, [isLiveTail, attentionRequired])

  const handleOpenChange = (next: boolean): void => {
    userOverride.current = true
    setOpen(next)
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="min-w-0">
      <CollapsibleTrigger
        data-press-feedback="off"
        className={cn(
          'flex w-full cursor-pointer items-center gap-1.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          CHAT_ROW_MIN_H
        )}
      >
        <motion.span
          aria-hidden="true"
          className="shrink-0"
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduced ? { duration: 0 } : CHEVRON_TRANSITION}
        >
          <ChevronRight size={13} />
        </motion.span>
        <ThinkingStatus text={summary.label} shimmer={false} />
        <DiffStat added={summary.added} removed={summary.removed} />
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <CollapseExpandMotion open={open} motion="chat">
          <div className="min-w-0 pl-4">
            {items.map((item) => {
              const id = item.tool.toolCallId
              return (
                <RowReveal
                  key={item.key}
                  animate={enter.animate(id)}
                  staggerIndex={enter.staggerIndex(id)}
                >
                  <ToolCallCard
                    toolCall={item.tool}
                    filePathContext={filePathContext}
                    parentTurnActive={active}
                    onOpenSubagent={onOpenSubagent}
                  />
                </RowReveal>
              )
            })}
          </div>
        </CollapseExpandMotion>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Memoized like the turn row above it: the group wraps every tool card in
 * the turn, so a `statusLine`-only re-render of TurnActivity skips the walk.
 */
export const ToolCallGroup = memo(ToolCallGroupComponent)
