import { useCallback, useEffect, useRef } from 'react'
import type { AgentId } from '@/lib/acp-api'
import { AgentBadge } from './AgentBadge'
import { ChatMessage } from './ChatMessage'
import type { TimelineItem } from './chat-timeline'
import { ToolCallCard } from './ToolCallCard'

interface ChatMessageListProps {
  items: TimelineItem[]
  /** Agent behind this session (drives the agent name/icon on replies). */
  agentId: AgentId
  /** True while a turn is in flight but no agent text has streamed yet. */
  showTyping: boolean
}

/**
 * Scrollable message thread. Auto-scrolls to the bottom on new content only
 * when the user is already pinned near the bottom, so reading scrollback isn't
 * interrupted by streaming chunks.
 */
export function ChatMessageList({
  items,
  agentId,
  showTyping
}: ChatMessageListProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedToBottomRef.current = distanceFromBottom < 48
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: items/showTyping are intentional re-scroll triggers even though they are not read in the body.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !pinnedToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [items, showTyping])

  if (items.length === 0 && !showTyping) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No messages yet. Say something to get started.
      </div>
    )
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto w-full max-w-3xl">
        {items.map((it) =>
          it.kind === 'tool' ? (
            <ToolCallCard key={it.key} toolCall={it.tool} />
          ) : (
            <ChatMessage key={it.key} message={it.message} agentId={agentId} />
          )
        )}
        {showTyping && <TypingIndicator agentId={agentId} />}
      </div>
    </div>
  )
}

/** "Agent is typing" placeholder shown before the first text chunk streams. */
function TypingIndicator({ agentId }: { agentId: AgentId }): React.JSX.Element {
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <AgentBadge agentId={agentId} iconSize={12} />
      </div>
      <div className="flex items-center gap-1" aria-label="Agent is typing">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s] motion-reduce:animate-none" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s] motion-reduce:animate-none" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 motion-reduce:animate-none" />
      </div>
    </div>
  )
}
