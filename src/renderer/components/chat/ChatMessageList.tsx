import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { GradientSpin } from 'gradient-spin'
import { useEffect, useMemo, useRef } from 'react'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller
} from '@/components/ui/message-scroller'
import type { AgentId, SessionId } from '@/lib/acp-api'
import { ChatEmptyState } from './ChatEmptyState'
import { ChatMessage } from './ChatMessage'
import { agentTurnMeta, type TimelineItem } from './chat-timeline'
import { ThoughtGroup } from './ThoughtGroup'
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
  /** Active session — resets enter-animation baseline on switch. */
  sessionId: SessionId
  /** Agent behind this session (drives the agent name/icon on replies). */
  agentId: AgentId
  /** True while a turn is in flight and the live tail is not already streaming. */
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

/** Index of the last message item in the timeline (skips trailing tool cards). */
function lastMessageIndex(items: TimelineItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'message') return i
  }
  return -1
}

/** Stable id for animate-enter tracking across message, tool, and thought rows. */
function timelineItemId(it: TimelineItem): string {
  if (it.kind === 'message') return it.message.id
  if (it.kind === 'tool') return it.tool.toolCallId
  return it.key
}

/**
 * Returns true for timeline items that arrived after the list's first paint
 * (or after a session switch). History loaded on open does not re-enter.
 */
function useAnimateEnter(sessionId: SessionId, items: TimelineItem[]): (id: string) => boolean {
  const sessionRef = useRef(sessionId)
  const initialIdsRef = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId
      initialIdsRef.current = null
    }
  }, [sessionId])

  if (initialIdsRef.current === null) {
    initialIdsRef.current = new Set(items.map(timelineItemId))
  }

  return (id: string) => !initialIdsRef.current!.has(id)
}

/**
 * Scrollable message thread built on the MessageScroller engine. Auto-follows
 * the live edge only while the reader is pinned to the bottom; a jump-to-latest
 * control appears otherwise. New user turns anchor the scroll position.
 */
export function ChatMessageList({
  items,
  sessionId,
  agentId,
  showTyping,
  onEditMessage,
  onRetry
}: ChatMessageListProps): React.JSX.Element {
  const turnMeta = useMemo(() => agentTurnMeta(items), [items])
  const lastMsgIndex = useMemo(() => lastMessageIndex(items), [items])
  const shouldAnimateEnter = useAnimateEnter(sessionId, items)

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
                    <ToolCallCard
                      toolCall={it.tool}
                      animateEnter={shouldAnimateEnter(it.tool.toolCallId)}
                    />
                  ) : it.kind === 'thought-group' ? (
                    <ThoughtGroup messages={it.messages} isLiveTail={i === items.length - 1} />
                  ) : (
                    <ChatMessage
                      message={it.message}
                      showHeader={!isGroupedReply(items, i)}
                      isLast={i === items.length - 1}
                      isTurnTail={turnMeta.tail.has(it.message.id)}
                      turnText={turnMeta.text.get(it.message.id)}
                      actionsPinned={i === lastMsgIndex}
                      animateEnter={shouldAnimateEnter(it.message.id)}
                      onEdit={onEditMessage}
                      onRetry={onRetry}
                    />
                  )}
                </MessageScrollerItem>
              ))}
              <AnimatePresence initial={false}>
                {showTyping && <TypingIndicator key="typing" />}
              </AnimatePresence>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}

/** Turn-still-running cue — gradient matrix spin (no text label). */
function TypingIndicator(): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  return (
    <motion.div
      className="min-w-0 shrink-0 px-1 py-2"
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      <GradientSpin gradient="bay" pattern="diagonal" label="Planning next move" />
    </motion.div>
  )
}
