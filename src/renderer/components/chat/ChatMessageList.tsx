import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect } from 'react'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller
} from '@/components/ui/message-scroller'
import type { AgentId } from '@/lib/acp-api'
import { AgentBadge } from './AgentBadge'
import { ChatEmptyState } from './ChatEmptyState'
import { ChatMessage } from './ChatMessage'
import type { TimelineItem } from './chat-timeline'
import { ToolCallCard } from './ToolCallCard'

/** Reports the live item count to the scroller so the jump button can badge unread. */
function ItemCountReporter({ count }: { count: number }): null {
  const { setItemCount } = useMessageScroller()
  useEffect(() => {
    setItemCount(count)
  }, [count, setItemCount])
  return null
}

interface ChatMessageListProps {
  items: TimelineItem[]
  /** Agent behind this session (drives the agent name/icon on replies). */
  agentId: AgentId
  /** True while a turn is in flight but no agent text has streamed yet. */
  showTyping: boolean
  /** Seed the composer with a user message's text (edit affordance). */
  onEditMessage?: (text: string) => void
  /** Re-run the latest user turn (regenerate affordance on agent replies). */
  onRetry?: () => void
}

/** Hide the agent header when the previous timeline entry is also an agent reply. */
function isGroupedReply(items: TimelineItem[], index: number): boolean {
  const it = items[index]
  if (it.kind !== 'message' || it.message.role !== 'agent') return false
  const prev = items[index - 1]
  return prev?.kind === 'message' && prev.message.role === 'agent'
}

/**
 * Scrollable message thread built on the MessageScroller engine. Auto-follows
 * the live edge only while the reader is pinned to the bottom; a jump-to-latest
 * control appears otherwise. New user turns anchor the scroll position.
 */
export function ChatMessageList({
  items,
  agentId,
  showTyping,
  onEditMessage,
  onRetry
}: ChatMessageListProps): React.JSX.Element {
  if (items.length === 0 && !showTyping) {
    return <ChatEmptyState agentId={agentId} onPick={onEditMessage} />
  }

  return (
    <div className="relative min-h-0 flex-1">
      {/* Edge fades: content dissolves into the header/composer instead of hard-cutting. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-background to-transparent" />
      <MessageScrollerProvider autoScroll>
        <ItemCountReporter count={items.length} />
        <MessageScroller>
          <MessageScrollerViewport className="px-5 py-4">
            <MessageScrollerContent className="mx-auto w-full max-w-3xl">
              {items.map((it, i) => (
                <MessageScrollerItem
                  key={it.key}
                  messageId={it.key}
                  scrollAnchor={it.kind === 'message' && it.message.role === 'user'}
                >
                  {it.kind === 'tool' ? (
                    <ToolCallCard toolCall={it.tool} />
                  ) : (
                    <ChatMessage
                      message={it.message}
                      agentId={agentId}
                      showHeader={!isGroupedReply(items, i)}
                      isLast={i === items.length - 1}
                      onEdit={onEditMessage}
                      onRetry={onRetry}
                    />
                  )}
                </MessageScrollerItem>
              ))}
              <AnimatePresence>
                {showTyping && <TypingIndicator key="typing" agentId={agentId} />}
              </AnimatePresence>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}

/** "Agent is typing" status shown before the first text chunk streams. */
function TypingIndicator({ agentId }: { agentId: AgentId }): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  return (
    <motion.div
      className="min-w-0 shrink-0 px-1 py-2"
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <div className="mb-1.5">
        <AgentBadge agentId={agentId} iconSize={12} />
      </div>
      <Marker role="status">
        <MarkerIcon className="gap-1">
          <TypingDots />
        </MarkerIcon>
        <MarkerContent className="shimmer">Thinking…</MarkerContent>
      </Marker>
    </motion.div>
  )
}

/** Three staggered hopping dots — the classic "is typing" cue. */
function TypingDots(): React.JSX.Element {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      <span className="size-1.5 animate-typing-bounce rounded-full bg-muted-foreground motion-reduce:animate-none" />
      <span className="size-1.5 animate-typing-bounce rounded-full bg-muted-foreground [animation-delay:150ms] motion-reduce:animate-none" />
      <span className="size-1.5 animate-typing-bounce rounded-full bg-muted-foreground [animation-delay:300ms] motion-reduce:animate-none" />
    </span>
  )
}
