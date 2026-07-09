import { motion, useReducedMotion } from 'framer-motion'
import { Brain, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import type { ContentBlock } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/acp-store'
import { CHAT_SPRING } from './chat-motion'

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

function thoughtTexts(messages: ChatMessage[]): string {
  return messages
    .map((m) => blocksToText(m.blocks))
    .filter((t) => t.length > 0)
    .join('\n\n')
}

interface ThoughtGroupProps {
  messages: ChatMessage[]
  /** True when this group is the last timeline item (nothing after it yet). */
  isLiveTail: boolean
}

/**
 * Consolidated agent reasoning block — auto-opens while streaming at the live
 * tail, collapses once tools or reply follow (AI SDK Reasoning pattern).
 */
export function ThoughtGroup({ messages, isLiveTail }: ThoughtGroupProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const isStreaming = isLiveTail && messages.some((m) => m.streaming)
  const text = thoughtTexts(messages)
  const lines = text.split('\n').filter((l) => l.trim().length > 0).length

  const [open, setOpen] = useState(false)
  const userOverride = useRef(false)

  useEffect(() => {
    if (userOverride.current) return
    setOpen(isStreaming)
  }, [isStreaming])

  const handleOpenChange = (next: boolean): void => {
    userOverride.current = true
    setOpen(next)
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="py-2">
      <CollapsibleTrigger
        data-press-feedback="off"
        className="flex min-h-10 w-full cursor-pointer items-center gap-1 text-left"
      >
        <Marker variant="default" className="inline-flex min-w-0 flex-1 italic">
          <MarkerIcon>
            <Brain />
          </MarkerIcon>
          <MarkerContent className={cn('min-w-0 flex-1', isStreaming && 'shimmer')}>
            {isStreaming ? 'Thinking…' : 'Thought'}
            {lines > 0 ? (
              <>
                {' · '}
                <span className="tabular-nums">
                  {lines} line{lines === 1 ? '' : 's'}
                </span>
              </>
            ) : null}
          </MarkerContent>
        </Marker>
        <motion.span
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduced ? { duration: 0 } : CHAT_SPRING}
        >
          <ChevronRight size={13} />
        </motion.span>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <CollapseExpandMotion open={open}>
          <div className="mt-1.5 whitespace-pre-wrap break-words pl-3 text-xs italic text-muted-foreground">
            {text}
          </div>
        </CollapseExpandMotion>
      </CollapsibleContent>
    </Collapsible>
  )
}
