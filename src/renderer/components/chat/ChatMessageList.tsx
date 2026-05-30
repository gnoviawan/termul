import { useEffect, useRef, useCallback } from 'react'
import { ChatMessage } from './ChatMessage'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'

interface ChatMessageListProps {
  messages: ChatMessageType[]
}

/**
 * Scrollable message thread. Auto-scrolls to the bottom on new content only
 * when the user is already pinned near the bottom, so reading scrollback isn't
 * interrupted by streaming chunks.
 */
export function ChatMessageList({ messages }: ChatMessageListProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedToBottomRef.current = distanceFromBottom < 48
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !pinnedToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No messages yet. Say something to get started.
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto divide-y divide-border/40"
    >
      {messages.map((m) => (
        <ChatMessage key={m.id} message={m} />
      ))}
    </div>
  )
}
