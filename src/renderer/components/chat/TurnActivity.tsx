import { motion, useReducedMotion } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { cn } from '@/lib/utils'
import { ChatMessage } from './ChatMessage'
import { CHEVRON_TRANSITION } from './chat-motion'
import type { TimelineItem } from './chat-timeline'
import { formatTurnDuration } from './format-turn-duration'
import { ThoughtGroup } from './ThoughtGroup'
import { ToolCallCard } from './ToolCallCard'

interface TurnActivityProps {
  items: TimelineItem[]
  active: boolean
  durationMs: number | null
  attentionRequired: boolean
  hasFinalResponse: boolean
  shouldAnimateEnter: (id: string) => boolean
}

/** Borderless, turn-level disclosure for reasoning, tools, and intermediate narration. */
export function TurnActivity({
  items,
  active,
  durationMs,
  attentionRequired,
  hasFinalResponse,
  shouldAnimateEnter
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
          'flex min-h-8 w-full cursor-pointer items-center gap-1.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
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
                return (
                  <ToolCallCard
                    key={item.key}
                    toolCall={item.tool}
                    animateEnter={shouldAnimateEnter(item.tool.toolCallId)}
                  />
                )
              }
              if (item.kind === 'thought-group') {
                return (
                  <ThoughtGroup
                    key={item.key}
                    messages={item.messages}
                    isLiveTail={active && index === items.length - 1}
                  />
                )
              }
              return (
                <ChatMessage
                  key={item.key}
                  message={item.message}
                  showHeader={false}
                  isLast={active && index === items.length - 1}
                  animateEnter={shouldAnimateEnter(item.message.id)}
                />
              )
            })}
          </div>
        </CollapseExpandMotion>
      </CollapsibleContent>
    </Collapsible>
  )
}
