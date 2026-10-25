import { motion, useReducedMotion } from 'framer-motion'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
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
import { formatTurnDuration } from './format-turn-duration'
import { RowReveal } from './RowReveal'
import { ThinkingStatus } from './ThinkingStatus'
import { ThoughtGroup } from './ThoughtGroup'
import { summarizeToolActivity, type ToolActivitySummary } from './tool-call-summary'
import type { EnterTracker } from './use-enter-tracker'
import { DiffStat, WorkRunGroup, type WorkRunItem } from './WorkRunGroup'

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
  const [open, setOpen] = useState(active || (!attentionRequired && !hasFinalResponse))
  const wasActive = useRef(active)

  useEffect(() => {
    if (active) {
      setOpen(true)
    } else if (wasActive.current && (hasFinalResponse || attentionRequired)) {
      setOpen(false)
    }
    wasActive.current = active
  }, [active, attentionRequired, hasFinalResponse])

  const duration = formatTurnDuration(durationMs)
  const lastItem = items[items.length - 1]
  // Each contiguous run of thoughts and tool calls gets its own nested
  // disclosure, so narration between two runs keeps its seat: work, text,
  // work. `workRuns` maps every member's key to its run, so a lone thought
  // (absent) still renders bare. `summary` still covers every call in the
  // turn for the trigger's aggregate diffstat.
  const { summary, workRuns } = useMemo(() => {
    const allCalls: ToolCall[] = []
    const runs = new Map<
      string,
      {
        items: WorkRunItem[]
        summary: ToolActivitySummary
        failed: boolean
      }
    >()
    let run: WorkRunItem[] | null = null
    const flush = (): void => {
      if (run) {
        const calls = run.flatMap((item) => (item.kind === 'tool' ? [item.tool] : []))
        const runSummary =
          calls.length > 0
            ? summarizeToolActivity(calls, { thoughts: run.length - calls.length })
            : null
        if (runSummary) {
          const entry = {
            items: run,
            summary: runSummary,
            failed: run.some((member) => member.kind === 'tool' && member.tool.status === 'failed')
          }
          for (const member of run) runs.set(member.key, entry)
        }
      }
      run = null
    }
    for (const item of items) {
      if (item.kind === 'tool' || item.kind === 'thought-group') {
        if (item.kind === 'tool') allCalls.push(item.tool)
        if (!run) run = []
        run.push(item)
      } else {
        flush()
      }
    }
    flush()
    return { summary: summarizeToolActivity(allCalls), workRuns: runs }
  }, [items])
  const label =
    active && statusLine
      ? statusLine
      : active
        ? 'Working…'
        : duration
          ? `Worked for ${duration}`
          : 'Worked'

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
            {items.map((item, index) => {
              const run = workRuns.get(item.key)
              if (run) {
                // Only a run's first item renders — as the group's disclosure;
                // the rest live inside it.
                if (run.items[0] !== item) return null
                return (
                  <WorkRunGroup
                    key={item.key}
                    items={run.items}
                    summary={run.summary}
                    active={active}
                    // Lets a still-streaming thought inside the run keep streaming.
                    isLiveTail={active && run.items[run.items.length - 1] === lastItem}
                    failed={run.failed}
                    enter={enter}
                    filePathContext={filePathContext}
                    onOpenSubagent={onOpenSubagent}
                  />
                )
              }
              if (item.kind === 'thought-group') {
                return (
                  <RowReveal
                    key={item.key}
                    animate={enter.animate(item.key)}
                    staggerIndex={enter.staggerIndex(item.key)}
                  >
                    <ThoughtGroup
                      messages={item.messages}
                      isLiveTail={active && index === items.length - 1}
                    />
                  </RowReveal>
                )
              }
              // Every tool sits in a run above. CAP-2 / worktree progress: switch
              // markers and worktree rows never reach the turn bucket
              // (groupTurnActivity emits them top-level), but guard the render
              // so the type stays exhaustive.
              if (
                item.kind === 'tool' ||
                item.kind === 'switch' ||
                item.kind === 'worktree' ||
                item.kind === 'reload'
              )
                return null
              return (
                <ChatMessage
                  key={item.key}
                  message={item.message}
                  showHeader={false}
                  isLast={active && index === items.length - 1}
                  animateEnter={enter.animate(item.message.id)}
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
