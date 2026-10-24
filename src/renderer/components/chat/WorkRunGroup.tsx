import { motion, useReducedMotion } from 'framer-motion'
import { memo, useState } from 'react'
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
import { ThoughtGroup } from './ThoughtGroup'
import { ToolCallCard } from './ToolCallCard'
import type { ToolActivitySummary } from './tool-call-summary'
import type { EnterTracker } from './use-enter-tracker'

/** One step of agent work between two narration messages. */
export type WorkRunItem = Extract<TimelineItem, { kind: 'tool' } | { kind: 'thought-group' }>

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

interface WorkRunGroupProps {
  /** The run's thoughts and tool calls, in timeline order. */
  items: WorkRunItem[]
  /** Categorized rollup on the trigger line — "Thought 2 times, ran 3 commands". */
  summary: ToolActivitySummary
  /** The parent turn is still running. */
  active: boolean
  /** True while this run owns the turn's last timeline item: the label shimmers and its trailing thought streams. */
  isLiveTail: boolean
  /** A call failed: the trigger reads red. */
  failed: boolean
  enter: EnterTracker
  filePathContext?: FilePathResolutionContext
  onOpenSubagent: (toolCall: ToolCall) => void
}

/**
 * One nested disclosure rolling up a run of thoughts and tool calls between
 * two narration messages; expanding lists them in order. Always starts
 * collapsed, live or failed, so narration stays adjacent; a failed run
 * flags itself in red instead of opening.
 */
function WorkRunGroupComponent({
  items,
  summary,
  active,
  isLiveTail,
  failed,
  enter,
  filePathContext,
  onOpenSubagent
}: WorkRunGroupProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger
        data-press-feedback="off"
        className={cn(
          'flex w-full cursor-pointer items-center gap-1.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          CHAT_ROW_MIN_H,
          failed && 'text-destructive'
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
        {/* The shimmer is CSS on data-text, so a count change re-renders in place. */}
        <span className={cn('t-think is-start min-w-0', !isLiveTail && 'is-settled')}>
          <span className="t-think-text tabular-nums" data-text={summary.label}>
            {summary.label}
          </span>
        </span>
        <DiffStat added={summary.added} removed={summary.removed} />
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <CollapseExpandMotion open={open} motion="chat">
          <div className="min-w-0 pl-4">
            {items.map((item, index) => {
              if (item.kind === 'thought-group') {
                return (
                  <RowReveal
                    key={item.key}
                    animate={enter.animate(item.key)}
                    staggerIndex={enter.staggerIndex(item.key)}
                  >
                    <ThoughtGroup
                      messages={item.messages}
                      isLiveTail={isLiveTail && index === items.length - 1}
                    />
                  </RowReveal>
                )
              }
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
 * Memoized like the turn row above it: the group wraps every card in its run,
 * so a `statusLine`-only re-render of TurnActivity skips the walk.
 */
export const WorkRunGroup = memo(WorkRunGroupComponent)
