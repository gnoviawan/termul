/**
 * GPUIX override of `components/chat/ChatMessageList.tsx`.
 *
 * The web list is a TanStack virtualizer inside the MessageScroller engine
 * (DOM scroll element, ResizeObserver, scrollTop arithmetic). Here the rows
 * go into GPUIX's `<virtual-list>`, which measures rows natively, builds only
 * the rows near the viewport, and follows the tail on its own
 * (`alignment="bottom" followTail`). The data path is the web's: the same
 * turn grouping, identity stabilisation and row components.
 *
 * Agent replies span one row per block (`AgentReplyRows`), so GPUI lays out
 * only the blocks near the viewport while a reply streams.
 *
 * Follow state comes from `getListScrollTop`, read after each list scroll: a
 * bottom-aligned list resting at its end reports the at-end sentinel (index
 * === host row count). Anywhere else the reader has scrolled away, so the
 * jump-to-latest button shows.
 */

import { type PublicInstance, useGpuixRequired } from '@gpuix/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentSwitchSeparator } from '@/components/chat/AgentSwitchSeparator'
import { ChatEmptyState } from '@/components/chat/ChatEmptyState'
import { ChatMessage } from '@/components/chat/ChatMessage'
import {
  groupTurnActivity,
  stabilizedTimeline,
  type TimelineItem,
  type TurnTimelineItem
} from '@/components/chat/chat-timeline'
import { opencodeStatusLine } from '@/components/chat/opencode-status'
import { RowReveal } from '@/components/chat/RowReveal'
import { SubagentDetailsDialog } from '@/components/chat/SubagentDetailsDialog'
import { ThoughtGroup } from '@/components/chat/ThoughtGroup'
import { ToolCallCard } from '@/components/chat/ToolCallCard'
import { TurnActivity } from '@/components/chat/TurnActivity'
import { type EnterTracker, useEnterTracker } from '@/components/chat/use-enter-tracker'
import { WorktreeCreationCard } from '@/components/chat/WorktreeCreationCard'
import { ArrowDown } from '@/components/icons'
import { Button } from '@/components/ui/button'
import type { SessionId, ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { AgentReplyRows, hasMediaBlocks } from '../../../chat/AgentReplyRows'
import { RowCountContext, RowShell } from '../../../chat/row-shell'
import { log } from '../../../log'
import { tw } from '../../../style/tw'

/** Delay from a list scroll to reading its anchor, so a queued `scrollToItem` has applied. */
const FOLLOW_READ_DELAY_MS = 120

type ListAnchor = [index: number, offset: number]

/** Reader positions of sessions scrolled away from the live edge, restored on return. */
const savedAnchors = new Map<SessionId, ListAnchor>()

interface ChatMessageListProps {
  items: TimelineItem[]
  sessionId: SessionId
  showRunningIndicator: boolean
  onEditMessage?: (text: string) => void
  onRetry?: () => void
  filePathContext?: FilePathResolutionContext
}

function lastMessageIndex(items: TurnTimelineItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'message') return i
  }
  return -1
}

function timelineItemId(it: TimelineItem): string {
  if (it.kind === 'message') return it.message.id
  if (it.kind === 'tool') return it.tool.toolCallId
  return it.key
}

interface RowProps {
  item: TurnTimelineItem
  index: number
  count: number
  lastMsgIndex: number
  enter: EnterTracker
  onEditMessage?: (text: string) => void
  onRetry?: () => void
  filePathContext?: FilePathResolutionContext
  onOpenSubagent: (toolCall: ToolCall) => void
  parentTurnActive: boolean
  statusLine: string | null
}

function RowContent({
  item,
  index,
  count,
  lastMsgIndex,
  enter,
  onEditMessage,
  onRetry,
  filePathContext,
  onOpenSubagent,
  parentTurnActive,
  statusLine
}: RowProps) {
  if (item.kind === 'activity') {
    return (
      <TurnActivity
        items={item.items}
        active={item.active}
        durationMs={item.durationMs}
        attentionRequired={item.attentionRequired}
        hasFinalResponse={item.hasFinalResponse}
        enter={enter}
        statusLine={item.active ? statusLine : null}
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
  if (item.kind === 'reload') {
    const rule = tw('h-px flex-1 bg-border')
    return (
      <div role="status" style={tw('flex items-center gap-3 py-1')}>
        <div style={rule} />
        <text style={tw('text-2xs text-muted-foreground')}>Agent reloaded</text>
        <div style={rule} />
      </div>
    )
  }
  if (item.kind === 'worktree') {
    return (
      <RowReveal animate={enter.animate(item.key)} staggerIndex={enter.staggerIndex(item.key)}>
        <WorktreeCreationCard progressId={item.progressId} />
      </RowReveal>
    )
  }
  if (item.kind === 'switch') return <AgentSwitchSeparator switch={item.switch} />
  return (
    <ChatMessage
      message={item.message}
      showHeader
      isLast={index === count - 1}
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

const BADGE = tw(
  'absolute -top-1.5 rounded-full bg-foreground px-1.5 text-3xs font-semibold text-background shadow-sm'
)

/** `MessageScrollerButton`: the same Button variant and classes, centred over the list's bottom. */
function JumpToLatest({ newCount, onJump }: { newCount: number; onJump: () => void }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 16,
        display: 'flex',
        justifyContent: 'center'
      }}
    >
      <Button
        data-testid="chat-jump-latest"
        type="button"
        variant="secondary"
        size="icon-sm"
        aria-label={newCount > 0 ? `Scroll to latest (${newCount} new)` : 'Scroll to latest'}
        onClick={onJump}
        className={cn(
          'relative size-10 rounded-full border border-border bg-background text-foreground shadow-md hover:bg-muted',
          newCount > 0 && 'border-foreground/40'
        )}
      >
        <ArrowDown />
        {newCount > 0 ? (
          <div style={{ ...BADGE, left: 12 }}>
            <text style={tw('text-3xs font-semibold text-background')}>
              {newCount > 99 ? '99+' : `${newCount}`}
            </text>
          </div>
        ) : null}
      </Button>
    </div>
  )
}

/**
 * Follow state of a native list: pinned at the live edge, or the reader's anchor.
 *
 * The anchor is read once after the list reports a scroll (`onVisibleRange`
 * fires for the wheel and for `scrollToItem`), never on a timer: a mounted
 * transcript nobody scrolls costs nothing, and a hidden one never asks the
 * UI thread. A read that times out (`native-guard.ts`) keeps the last state.
 */
function useListFollow(
  listRef: React.RefObject<PublicInstance | null>,
  hostRows: () => number,
  sessionId: SessionId
) {
  const renderer = useGpuixRequired()
  const [pinned, setPinned] = useState(() => !savedAnchors.has(sessionId))
  const anchorRef = useRef<ListAnchor | null>(null)
  const countRef = useRef(hostRows)
  countRef.current = hostRows
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const read = useCallback(() => {
    readTimer.current = null
    const id = listRef.current?.id
    if (id === undefined) return
    const top = renderer.getListScrollTop?.(id)
    if (!top) return
    const atEnd = top[0] >= countRef.current()
    anchorRef.current = atEnd ? null : [top[0], top[1]]
    setPinned(atEnd)
  }, [renderer, listRef])

  /** Called on every list scroll; reads the anchor once the scroll has been applied. */
  const onScrolled = useCallback(() => {
    if (readTimer.current === null) readTimer.current = setTimeout(read, FOLLOW_READ_DELAY_MS)
  }, [read])

  useEffect(
    () => () => {
      if (readTimer.current !== null) clearTimeout(readTimer.current)
    },
    []
  )

  // Session switch: keep the old reader's place, restore the new one's.
  useLayoutEffect(() => {
    const saved = savedAnchors.get(sessionId)
    const id = listRef.current?.id
    if (saved && id !== undefined) {
      renderer.scrollToItem?.(id, saved[0], saved[1])
      log.info('chat', `transcript.restore ${JSON.stringify({ sessionId, index: saved[0] })}`)
    }
    anchorRef.current = saved ?? null
    setPinned(!saved)
    return () => {
      if (anchorRef.current) savedAnchors.set(sessionId, anchorRef.current)
      else savedAnchors.delete(sessionId)
      anchorRef.current = null
    }
  }, [renderer, listRef, sessionId])

  const jumpToLatest = useCallback(() => {
    const id = listRef.current?.id
    if (id === undefined) return
    renderer.scrollToItem?.(id, countRef.current())
    anchorRef.current = null
    setPinned(true)
  }, [renderer, listRef])

  return { pinned, jumpToLatest, onScrolled }
}

/** Items appended while the reader is away from the live edge. */
function useUnread(count: number, pinned: boolean): number {
  const [seen, setSeen] = useState(count)
  useEffect(() => {
    if (pinned) setSeen(count)
  }, [pinned, count])
  return pinned ? 0 : Math.max(0, count - seen)
}

export function ChatMessageList({
  items,
  sessionId,
  showRunningIndicator,
  onEditMessage,
  onRetry,
  filePathContext
}: ChatMessageListProps) {
  const opencodeNotice = useAcpStore((s) => s.sessions[sessionId]?.opencodeNotice)
  const statusLine = opencodeStatusLine(opencodeNotice)
  const groupedItems = useMemo(
    () => groupTurnActivity(items, showRunningIndicator),
    [items, showRunningIndicator]
  )
  const stableRef = useRef<TurnTimelineItem[]>([])
  const stableItems = useMemo(() => {
    stableRef.current = stabilizedTimeline(stableRef.current, groupedItems)
    return stableRef.current
  }, [groupedItems])
  const lastMsgIndex = useMemo(() => lastMessageIndex(stableItems), [stableItems])
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

  const listRef = useRef<PublicInstance | null>(null)
  const count = stableItems.length
  const rowCounts = useRef(new Map<string, number>()).current
  const itemsRef = useRef(stableItems)
  itemsRef.current = stableItems
  const hostRows = useCallback(
    () => itemsRef.current.reduce((sum, item) => sum + (rowCounts.get(item.key) ?? 1), 0),
    [rowCounts]
  )
  const { pinned, jumpToLatest, onScrolled } = useListFollow(listRef, hostRows, sessionId)
  const newCount = useUnread(count, pinned)

  useEffect(() => {
    if (!pinned) return
    useAcpStore.getState?.()?.clearSessionBackfill?.(sessionId)
  }, [pinned, sessionId])

  // Older history loads only on reader intent: scrolled away and at the first row.
  const loadingOlderRef = useRef(false)
  const onVisibleRange = useCallback(
    (event: { startIndex?: number }) => {
      onScrolled()
      if ((event.startIndex ?? 1) > 0 || pinned || loadingOlderRef.current || count === 0) return
      loadingOlderRef.current = true
      void useAcpStore
        .getState()
        .loadOlderMessages(sessionId, 50)
        .finally(() => {
          loadingOlderRef.current = false
        })
    },
    [pinned, count, sessionId, onScrolled]
  )

  if (items.length === 0 && !showRunningIndicator) {
    return <ChatEmptyState sessionId={sessionId} />
  }

  const fade = (edge: 'top' | 'bottom') => ({
    position: 'absolute' as const,
    left: 0,
    right: 0,
    [edge]: 0,
    height: 24,
    pointerEvents: 'none' as const,
    ...tw(
      edge === 'top'
        ? 'bg-gradient-to-b from-terminal-bg to-transparent'
        : 'bg-gradient-to-t from-terminal-bg to-transparent'
    )
  })

  return (
    <div style={tw('relative flex min-h-0 flex-1 flex-col')} testId="chat-transcript">
      <virtual-list
        ref={listRef}
        testId="chat-transcript-list"
        alignment="bottom"
        followTail
        estimatedItemHeight={120}
        onVisibleRange={onVisibleRange}
        style={{ flexGrow: 1, minHeight: 0 }}
      >
        <RowCountContext.Provider value={rowCounts}>
          {stableItems.map((item, index) => {
            const edges = { first: index === 0, last: index === count - 1 }
            if (
              item.kind === 'message' &&
              item.message.role !== 'user' &&
              !hasMediaBlocks(item.message)
            ) {
              return (
                <AgentReplyRows
                  key={item.key}
                  rowKey={item.key}
                  message={item.message}
                  isLast={index === count - 1}
                  isTurnTail={item.isTurnTail === true}
                  turnText={item.turnText}
                  actionsPinned={index === lastMsgIndex}
                  onRetry={onRetry}
                  filePathContext={filePathContext}
                  edges={edges}
                />
              )
            }
            rowCounts.delete(item.key)
            return (
              <RowShell key={item.key} testId={`chat-row-${item.key}`} edges={edges}>
                <RowContent
                  item={item}
                  index={index}
                  count={count}
                  lastMsgIndex={lastMsgIndex}
                  enter={enter}
                  onEditMessage={onEditMessage}
                  onRetry={onRetry}
                  filePathContext={filePathContext}
                  onOpenSubagent={openSubagent}
                  parentTurnActive={showRunningIndicator}
                  statusLine={statusLine}
                />
              </RowShell>
            )
          })}
        </RowCountContext.Provider>
      </virtual-list>
      <div style={fade('top')} />
      <div style={fade('bottom')} />
      {!pinned ? <JumpToLatest newCount={newCount} onJump={jumpToLatest} /> : null}
      {selectedTool && (
        <SubagentDetailsDialog
          toolCall={selectedTool}
          parentTurnActive={showRunningIndicator}
          filePathContext={filePathContext}
          open
          onOpenChange={(open: boolean) => {
            if (!open) setSelection(null)
          }}
        />
      )}
    </div>
  )
}
