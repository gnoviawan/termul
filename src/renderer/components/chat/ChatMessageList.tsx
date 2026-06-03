import { Children, useCallback, useEffect, useRef } from 'react'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { ChatMessage } from './ChatMessage'

interface ChatMessageListProps {
  messages: ChatMessageType[]
  /** Extra content (e.g. tool-call cards) rendered after the message thread. */
  children?: React.ReactNode
}

/**
 * Scrollable message thread. Auto-scrolls to the bottom on new content only
 * when the user is already pinned near the bottom, so reading scrollback isn't
 * interrupted by streaming chunks.
 */
export function ChatMessageList({ messages, children }: ChatMessageListProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedToBottomRef.current = distanceFromBottom < 48
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages/children are intentional re-scroll triggers even though they are not read in the body.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !pinnedToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, children])

  const isEmpty = messages.length === 0 && Children.toArray(children).length === 0
  if (isEmpty) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No messages yet. Say something to get started.
      </div>
    )
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
      <div className="divide-y divide-border/40">
        {messages.map((m) => (
          <ChatMessage key={m.id} message={m} />
        ))}
      </div>
      {children}
    </div>
  )
}
