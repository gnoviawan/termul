import { useVirtualizer } from '@tanstack/react-virtual'
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
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { ChatEmptyState } from './ChatEmptyState'
import { ChatMessage } from './ChatMessage'
import { CHAT_GUTTER_X } from './chat-layout'
import { groupTurnActivity, type TimelineItem, type TurnTimelineItem } from './chat-timeline'
import { ThoughtGroup } from './ThoughtGroup'
import { ToolCallCard } from './ToolCallCard'
import { TurnActivity } from './TurnActivity'

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
  /** True for the complete duration of an in-flight agent turn. */
  showRunningIndicator: boolean
  /** Seed the composer with a user message's text (edit affordance). */
  onEditMessage?: (text: string) => void
  /** Re-run the latest user turn (regenerate affordance on agent replies). */
  onRetry?: () => void
}

/** Index of the last visible message item in the turn-grouped timeline. */
function lastMessageIndex(items: TurnTimelineItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'message') return i
  }
  return -1
}

/** Stable id for animate-enter tracking across message, tool, thought, and activity rows. */
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

/** Props shared between the list and its virtualized inner timeline. */
interface TimelineRenderProps {
  sessionId: SessionId
  groupedItems: TurnTimelineItem[]
  lastMsgIndex: number
  shouldAnimateEnter: (id: string) => boolean
  onEditMessage?: (text: string) => void
  onRetry?: () => void
}

/**
 * Virtualized timeline body. Lives inside <MessageScrollerProvider> so it can
 * read `viewportEl` (the virtualizer's scroll element) and `pinned` (follow
 * state) from the scroller context. Only near-viewport rows are mounted.
 */
function VirtualizedTimeline({
  sessionId,
  groupedItems,
  lastMsgIndex,
  shouldAnimateEnter,
  onEditMessage,
  onRetry
}: TimelineRenderProps): React.JSX.Element {
  const { viewportEl, pinned } = useMessageScroller()
  const virtualizer = useVirtualizer({
    count: groupedItems.length,
    getScrollElement: () => viewportEl,
    estimateSize: () => 120,
    overscan: 6,
    getItemKey: (i) => groupedItems[i]?.key ?? i
  })

  // Stick-to-bottom while streaming: only auto-follow when the reader is
  // pinned to the live edge (followOnAppend — do NOT pull a reader who has
  // scrolled up to read history back down).
  useEffect(() => {
    if (pinned && groupedItems.length > 0) {
      virtualizer.scrollToIndex(groupedItems.length - 1, { align: 'end' })
    }
  }, [groupedItems.length, pinned, virtualizer])

  // Reverse-infinite-scroll: lazy-load older messages when the reader reaches
  // the top of the mounted window. The store guards against concurrent loads
  // and is idempotent at the history head, but we keep a local in-flight flag
  // to avoid spamming the action on rapid range notifications.
  const loadingOlderRef = useRef(false)
  const startIndex = virtualizer.range?.startIndex
  useEffect(() => {
    if (startIndex === undefined || startIndex > 0) return
    if (groupedItems.length === 0 || loadingOlderRef.current) return
    loadingOlderRef.current = true
    void useAcpStore
      .getState()
      .loadOlderMessages(sessionId, 50)
      .finally(() => {
        loadingOlderRef.current = false
      })
  }, [startIndex, groupedItems.length, sessionId])

  const renderItemContent = (item: TurnTimelineItem, index: number): React.JSX.Element => {
    if (item.kind === 'activity') {
      return (
        <TurnActivity
          items={item.items}
          active={item.active}
          durationMs={item.durationMs}
          attentionRequired={item.attentionRequired}
          hasFinalResponse={item.hasFinalResponse}
          shouldAnimateEnter={shouldAnimateEnter}
        />
      )
    }
    if (item.kind === 'tool') {
      return (
        <ToolCallCard
          toolCall={item.tool}
          animateEnter={shouldAnimateEnter(item.tool.toolCallId)}
        />
      )
    }
    if (item.kind === 'thought-group') {
      return <ThoughtGroup messages={item.messages} isLiveTail={false} />
    }
    return (
      <ChatMessage
        message={item.message}
        showHeader
        isLast={index === groupedItems.length - 1}
        isTurnTail={item.isTurnTail}
        turnText={item.turnText}
        actionsPinned={index === lastMsgIndex}
        animateEnter={item.isTurnTail ? false : shouldAnimateEnter(item.message.id)}
        onEdit={onEditMessage}
        onRetry={onRetry}
      />
    )
  }

  // Fallback: when the viewport can't be measured (zero height — jsdom in tests,
  // or the pre-measurement first paint), render all items in normal flow so
  // content is always present. A real production viewport yields virtual items
  // and the windowed path runs.
  const virtualItems = virtualizer.getVirtualItems()
  if (viewportEl === null || virtualItems.length === 0) {
    return (
      <MessageScrollerContent className="mx-auto w-full max-w-3xl">
        {groupedItems.map((item, index) => (
          <MessageScrollerItem
            key={item.key}
            messageId={item.key}
            scrollAnchor={item.kind === 'message' && item.message.role === 'user'}
          >
            {renderItemContent(item, index)}
          </MessageScrollerItem>
        ))}
      </MessageScrollerContent>
    )
  }

  return (
    <MessageScrollerContent
      className="mx-auto w-full max-w-3xl"
      style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
    >
      {virtualItems.map((virtualItem) => {
        const item = groupedItems[virtualItem.index]
        if (!item) return null
        return (
          <MessageScrollerItem
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            messageId={item.key}
            scrollAnchor={item.kind === 'message' && item.message.role === 'user'}
            data-index={virtualItem.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`
            }}
          >
            {renderItemContent(item, virtualItem.index)}
          </MessageScrollerItem>
        )
      })}
    </MessageScrollerContent>
  )
}

/**
 * Scrollable message thread built on the MessageScroller engine. Agent process
 * output is grouped into one turn-level disclosure; the final reply remains a
 * normal message below it.
 */
export function ChatMessageList({
  items,
  sessionId,
  agentId,
  showRunningIndicator,
  onEditMessage,
  onRetry
}: ChatMessageListProps): React.JSX.Element {
  const groupedItems = useMemo(
    () => groupTurnActivity(items, showRunningIndicator),
    [items, showRunningIndicator]
  )
  const lastMsgIndex = useMemo(() => lastMessageIndex(groupedItems), [groupedItems])
  const shouldAnimateEnter = useAnimateEnter(sessionId, items)

  if (items.length === 0 && !showRunningIndicator) {
    return <ChatEmptyState agentId={agentId} onPick={onEditMessage} />
  }

  return (
    <div className="relative min-h-0 flex-1">
      {/* Edge fades: content dissolves into the header/composer instead of hard-cutting. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-background to-transparent" />
      <MessageScrollerProvider autoScroll>
        <ItemCountReporter count={groupedItems.length} />
        <MessageScroller>
          <MessageScrollerViewport className={cn(CHAT_GUTTER_X, 'py-4')}>
            <VirtualizedTimeline
              sessionId={sessionId}
              groupedItems={groupedItems}
              lastMsgIndex={lastMsgIndex}
              shouldAnimateEnter={shouldAnimateEnter}
              onEditMessage={onEditMessage}
              onRetry={onRetry}
            />
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}
