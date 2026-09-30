import { motion, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ShimmerText } from '@/components/ui/shimmer-text'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import { ChatMessage } from './ChatMessage'
import { CHAT_ROW_MIN_H } from './chat-layout'
import { CHEVRON_TRANSITION } from './chat-motion'
import type { TimelineItem } from './chat-timeline'
import { formatTurnDuration } from './format-turn-duration'
import { RowReveal } from './RowReveal'
import { ThoughtGroup } from './ThoughtGroup'
import { ToolCallCard } from './ToolCallCard'
import type { EnterTracker } from './use-enter-tracker'

interface TurnActivityProps {
  items: TimelineItem[]
  active: boolean
  durationMs: number | null
  attentionRequired: boolean
  hasFinalResponse: boolean
  enter: EnterTracker
  /** Filesystem roots used for "Open file" actions on file tool calls. */
  filePathContext?: FilePathResolutionContext
  onOpenSubagent: (toolCall: ToolCall) => void
}

/** Borderless, turn-level disclosure for reasoning, tools, and intermediate narration. */
export function TurnActivity({
  items,
  active,
  durationMs,
  attentionRequired,
  hasFinalResponse,
  enter,
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
  const label = active ? 'Working…' : duration ? `Worked for ${duration}` : 'Worked'

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
        <span className="font-medium">{active ? <ShimmerText text={label} /> : label}</span>
        {attentionRequired && !active ? <span>· needs attention</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <CollapseExpandMotion open={open}>
          <div className="min-w-0 pb-1 pl-4">
            {items.map((item, index) => {
              if (item.kind === 'tool') {
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
              // CAP-2 / worktree progress: switch markers and worktree rows
              // never reach the turn bucket (groupTurnActivity emits them
              // top-level), but guard the render so the type stays exhaustive.
              if (item.kind === 'switch' || item.kind === 'worktree') return null
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
