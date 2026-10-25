import { motion, useReducedMotion } from 'framer-motion'
import { memo, useMemo } from 'react'
import { ChevronRight } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import { ChatMessage } from './ChatMessage'
import { CHAT_ROW_MIN_H } from './chat-layout'
import { CHEVRON_TRANSITION } from './chat-motion'
import type { TimelineItem } from './chat-timeline'
import { RowReveal } from './RowReveal'
import { ThinkingStatus } from './ThinkingStatus'
import { ThoughtGroup } from './ThoughtGroup'
import { turnActivityLabel, turnActivityModel, useTurnActivityOpen } from './turn-activity-model'
import type { EnterTracker } from './use-enter-tracker'
import { DiffStat, WorkRunGroup } from './WorkRunGroup'

interface TurnActivityProps {
  items: TimelineItem[]
  active: boolean
  durationMs: number | null
  attentionRequired: boolean
  hasFinalResponse: boolean
  enter: EnterTracker
  /** Live OpenCode compaction or retry line. Shown only while the turn is active. */
  statusLine?: string | null
  /** Filesystem roots used for "Open file" actions on file tool calls. */
  filePathContext?: FilePathResolutionContext
  onOpenSubagent: (toolCall: ToolCall) => void
}

/** Borderless, turn-level disclosure for reasoning, tools, and intermediate narration. */
function TurnActivityComponent({
  items,
  active,
  durationMs,
  attentionRequired,
  hasFinalResponse,
  enter,
  statusLine,
  filePathContext,
  onOpenSubagent
}: TurnActivityProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const [open, setOpen] = useTurnActivityOpen(active, attentionRequired, hasFinalResponse)
  const { entries, summary } = useMemo(() => turnActivityModel(items, active), [items, active])
  const label = turnActivityLabel(active, durationMs, statusLine)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1 min-w-0">
      <CollapsibleTrigger
        data-press-feedback="off"
        className={cn(
          'flex w-full cursor-pointer items-center gap-1.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          CHAT_ROW_MIN_H,
          attentionRequired && !active && 'text-destructive'
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
        <ThinkingStatus text={label} shimmer={active} className="font-medium" />
        {summary ? <DiffStat added={summary.added} removed={summary.removed} /> : null}
        {attentionRequired && !active ? <span>· needs attention</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <CollapseExpandMotion open={open} motion="chat">
          <div className="min-w-0 pb-1 pl-4">
            {entries.map((entry) => {
              if (entry.kind === 'work-run') {
                return (
                  <WorkRunGroup
                    key={entry.key}
                    items={entry.items}
                    summary={entry.summary}
                    active={active}
                    isLiveTail={entry.isLiveTail}
                    failed={entry.failed}
                    enter={enter}
                    filePathContext={filePathContext}
                    onOpenSubagent={onOpenSubagent}
                  />
                )
              }
              if (entry.kind === 'thought') {
                return (
                  <RowReveal
                    key={entry.key}
                    animate={enter.animate(entry.key)}
                    staggerIndex={enter.staggerIndex(entry.key)}
                  >
                    <ThoughtGroup messages={entry.messages} isLiveTail={entry.isLiveTail} />
                  </RowReveal>
                )
              }
              return (
                <ChatMessage
                  key={entry.key}
                  message={entry.message}
                  showHeader={false}
                  isLast={entry.isLast}
                  animateEnter={enter.animate(entry.message.id)}
                  filePathContext={filePathContext}
                />
              )
            })}
          </div>
        </CollapseExpandMotion>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Memoized: a turn's activity row wraps every tool card + thought in that
 * turn — under a stream it is the largest subtree in the timeline. With
 * stabilized timeline items + a stable `enter` tracker, an unchanged turn
 * bails out of render entirely instead of re-walking hundreds of icons.
 */
export const TurnActivity = memo(TurnActivityComponent)
