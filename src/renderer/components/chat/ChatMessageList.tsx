import { useVirtualizer } from '@tanstack/react-virtual'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller
} from '@/components/ui/message-scroller'
import type { AgentId, SessionId, ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { AgentSwitchSeparator } from './AgentSwitchSeparator'
import { ChatEmptyState } from './ChatEmptyState'
import { ChatMessage } from './ChatMessage'
import { CHAT_GUTTER_X } from './chat-layout'
import { groupTurnActivity, type TimelineItem, type TurnTimelineItem } from './chat-timeline'
import { RowReveal } from './RowReveal'
import { SubagentDetailsDialog } from './SubagentDetailsDialog'
import { ThoughtGroup } from './ThoughtGroup'
import { ToolCallCard } from './ToolCallCard'
import { TurnActivity } from './TurnActivity'
import { type EnterTracker, useEnterTracker } from './use-enter-tracker'

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
  /** Filesystem roots used for safe file-path links in agent prose. */
  filePathContext?: FilePathResolutionContext
  /**
   * Ephemeral content rendered after the timeline inside the scroll viewport
   * (e.g. the worktree-creation progress card during a pre-session launch).
   * Not part of `items`, so it never reaches history persistence.
   */
  trailingContent?: ReactNode
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

/** Props shared between the list and its virtualized inner timeline. */
interface TimelineRenderProps {
  sessionId: SessionId
  groupedItems: TurnTimelineItem[]
  lastMsgIndex: number
  enter: EnterTracker
  onEditMessage?: (text: string) => void
  onRetry?: () => void
  filePathContext?: FilePathResolutionContext
  onOpenSubagent: (toolCall: ToolCall) => void
  parentTurnActive: boolean
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
  enter,
  onEditMessage,
  onRetry,
  filePathContext,
  onOpenSubagent,
  parentTurnActive
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

  // Reverse-infinite-scroll: lazy-load older messages ONLY on genuine reader
  // intent — the viewport must be scrollable and the reader must have scrolled
  // up off the live edge (not pinned). Without this gate, the first paint (and
  // any session short enough to fit the viewport) has startIndex === 0 and would
  // fire loadOlderMessages with no intent; each prepend changes groupedItems.length
  // and re-runs the effect, cascading until the whole transcript is back in the
  // live window and undoing the bound. The store guards concurrent loads and is
  // idempotent at the history head; this local flag avoids spamming on rapid
  // range notifications. The reader's position is preserved across the prepend.
  const loadingOlderRef = useRef(false)
  const startIndex = virtualizer.range?.startIndex
  useEffect(() => {
    if (startIndex === undefined || startIndex > 0) return
    if (groupedItems.length === 0 || loadingOlderRef.current) return
    if (viewportEl === null || pinned) return
    if (viewportEl.scrollHeight <= viewportEl.clientHeight) return
    const prevScrollHeight = viewportEl.scrollHeight
    const prevScrollTop = viewportEl.scrollTop
    // Cancel on dependency change (e.g. session switch) so a load that resolves
    // after the reader moved to another chat never adjusts the new viewport.
    let cancelled = false
    loadingOlderRef.current = true
    void useAcpStore
      .getState()
      .loadOlderMessages(sessionId, 50)
      .then(() => {
        if (cancelled) return
        // Restore the reader's position after older rows are prepended above.
        requestAnimationFrame(() => {
          if (cancelled || !viewportEl) return
          viewportEl.scrollTop = prevScrollTop + (viewportEl.scrollHeight - prevScrollHeight)
        })
      })
      .finally(() => {
        loadingOlderRef.current = false
      })
    return () => {
      cancelled = true
    }
  }, [startIndex, groupedItems.length, sessionId, viewportEl, pinned])

  // When the reader returns to the live edge, drop the per-session backfill
  // allowance so the next coalesced flush trims the window back to the live
  // bound. Bounded browsing: load-on-scroll-up grows the retained window; coming
  // back to the live edge shrinks it again. Best-effort (optional chaining) so
  // isolated tests that mock the store don't crash on the unconditional call.
  useEffect(() => {
    if (!pinned) return
    useAcpStore.getState?.()?.clearSessionBackfill?.(sessionId)
  }, [pinned, sessionId])

  const renderItemContent = (item: TurnTimelineItem, index: number): React.JSX.Element => {
    if (item.kind === 'activity') {
      return (
        <TurnActivity
          items={item.items}
          active={item.active}
          durationMs={item.durationMs}
          attentionRequired={item.attentionRequired}
          hasFinalResponse={item.hasFinalResponse}
          enter={enter}
          filePathContext={filePathContext}
          onOpenSubagent={onOpenSubagent}
        />
      )
    }
    if (item.kind === 'tool') {
      const id = item.tool.toolCallId
      return (
        <RowReveal animate={enter.animate(id)} staggerIndex={enter.staggerIndex(id)}>
          <ToolCallCard
            toolCall={item.tool}
            filePathContext={filePathContext}
            parentTurnActive={parentTurnActive}
            onOpenSubagent={onOpenSubagent}
          />
        </RowReveal>
      )
    }
    if (item.kind === 'thought-group') {
      return (
        <RowReveal animate={enter.animate(item.key)} staggerIndex={enter.staggerIndex(item.key)}>
          <ThoughtGroup messages={item.messages} isLiveTail={false} />
        </RowReveal>
      )
    }
    // CAP-2 (spec-in-chat-agent-switch): borderless agent-switch separator.
    if (item.kind === 'switch') {
      return <AgentSwitchSeparator switch={item.switch} />
    }
    return (
      <ChatMessage
        message={item.message}
        showHeader
        isLast={index === groupedItems.length - 1}
        isTurnTail={item.isTurnTail}
        turnText={item.turnText}
        actionsPinned={index === lastMsgIndex}
        animateEnter={item.isTurnTail ? false : enter.animate(item.message.id)}
        onEdit={onEditMessage}
        onRetry={onRetry}
        filePathContext={filePathContext}
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
  onRetry,
  filePathContext,
  trailingContent
}: ChatMessageListProps): React.JSX.Element {
  const groupedItems = useMemo(
    () => groupTurnActivity(items, showRunningIndicator),
    [items, showRunningIndicator]
  )
  const lastMsgIndex = useMemo(() => lastMessageIndex(groupedItems), [groupedItems])
  const itemIds = useMemo(() => items.map(timelineItemId), [items])
  const enter = useEnterTracker(sessionId, itemIds)
  const [selection, setSelection] = useState<{ sessionId: SessionId; toolCall: ToolCall } | null>(
    null
  )
  const openSubagent = useCallback(
    (toolCall: ToolCall) => setSelection({ sessionId, toolCall }),
    [sessionId]
  )
  const selectedItem = items.find(
    (item) => item.kind === 'tool' && item.tool.toolCallId === selection?.toolCall.toolCallId
  )
  const selectedTool =
    selection?.sessionId === sessionId
      ? selectedItem?.kind === 'tool'
        ? selectedItem.tool
        : selection.toolCall
      : null

  if (items.length === 0 && !showRunningIndicator && !trailingContent) {
    return <ChatEmptyState agentId={agentId} onPick={onEditMessage} />
  }

  return (
    <div className="relative min-h-0 flex-1">
      {/* Edge fades: content dissolves into the header/composer instead of hard-cutting. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-terminal-bg to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-terminal-bg to-transparent" />
      <MessageScrollerProvider autoScroll>
        <ItemCountReporter count={groupedItems.length} />
        <MessageScroller>
          <MessageScrollerViewport className={cn(CHAT_GUTTER_X, 'py-4')}>
            <VirtualizedTimeline
              sessionId={sessionId}
              groupedItems={groupedItems}
              lastMsgIndex={lastMsgIndex}
              enter={enter}
              filePathContext={filePathContext}
              onEditMessage={onEditMessage}
              onRetry={onRetry}
              onOpenSubagent={openSubagent}
              parentTurnActive={showRunningIndicator}
            />
            {trailingContent ? (
              <div className="mx-auto w-full max-w-3xl">{trailingContent}</div>
            ) : null}
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {selectedTool && (
        <SubagentDetailsDialog
          toolCall={selectedTool}
          parentTurnActive={showRunningIndicator}
          open
          onOpenChange={(open) => {
            if (!open) setSelection(null)
          }}
        />
      )}
    </div>
  )
}
