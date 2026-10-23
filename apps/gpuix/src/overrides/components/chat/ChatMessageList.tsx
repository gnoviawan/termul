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
 * Follow state comes from `getListScrollTop`: a bottom-aligned list resting
 * at its end reports the at-end sentinel (index === row count). Anywhere else
 * the reader has scrolled away, so the jump-to-latest button shows.
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
import type { SessionId, ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { useAcpStore } from '@/stores/acp-store'
import { log } from '../../../log'
import { tw } from '../../../style/tw'

/** How often the follow state is read back from the native list. */
const FOLLOW_POLL_MS = 120
/** `max-w-3xl`. */
const COLUMN_MAX = 768
/** `px-5` on a pane at least 400px wide (`CHAT_GUTTER_X`). */
const GUTTER = 20
/** `py-4` on the viewport. */
const EDGE_PAD = 16

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

const JUMP_BUTTON = tw(
  'relative flex size-10 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md hover:bg-muted'
)
const BADGE = tw(
  'absolute -top-1.5 rounded-full bg-foreground px-1.5 text-3xs font-semibold text-background shadow-sm'
)

function JumpToLatest({ newCount, onJump }: { newCount: number; onJump: () => void }) {
  return (
    <div
      style={{ position: 'absolute', left: 0, right: 0, bottom: 16, display: 'flex', justifyContent: 'center' }}
    >
      <div
        testId="chat-jump-latest"
        role="button"
        aria-label={newCount > 0 ? `Scroll to latest (${newCount} new)` : 'Scroll to latest'}
        style={{ ...JUMP_BUTTON, ...(newCount > 0 ? tw('border-foreground/40') : {}), cursor: 'pointer' }}
        onClick={onJump}
      >
        <ArrowDown size={16} />
        {newCount > 0 ? (
          <div style={{ ...BADGE, left: 12 }}>
            <text style={tw('text-3xs font-semibold text-background')}>{newCount > 99 ? '99+' : `${newCount}`}</text>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Follow state of a native list: pinned at the live edge, or the reader's anchor. */
function useListFollow(listRef: React.RefObject<PublicInstance | null>, count: number, sessionId: SessionId) {
  const renderer = useGpuixRequired()
  const [pinned, setPinned] = useState(() => !savedAnchors.has(sessionId))
  const anchorRef = useRef<ListAnchor | null>(null)
  const countRef = useRef(count)
  countRef.current = count

  useEffect(() => {
    const read = () => {
      const id = listRef.current?.id
      if (id === undefined) return
      const top = renderer.getListScrollTop?.(id)
      if (!top) return
      const atEnd = top[0] >= countRef.current
      anchorRef.current = atEnd ? null : [top[0], top[1]]
      setPinned(atEnd)
    }
    const timer = setInterval(read, FOLLOW_POLL_MS)
    return () => clearInterval(timer)
  }, [renderer, listRef])

  // Session switch: keep the old reader's place, restore the new one's.
  useLayoutEffect(() => {
    const saved = savedAnchors.get(sessionId)
    const id = listRef.current?.id
    if (saved && id !== undefined) {
      renderer.scrollToItem?.(id, saved[0], saved[1])
      log.info('chat', `transcript.restore ${JSON.stringify({ sessionId, index: saved[0] })}`)
    }
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
    renderer.scrollToItem?.(id, countRef.current)
    anchorRef.current = null
    setPinned(true)
  }, [renderer, listRef])

  return { pinned, jumpToLatest }
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
  const groupedItems = useMemo(() => groupTurnActivity(items, showRunningIndicator), [items, showRunningIndicator])
  const stableRef = useRef<TurnTimelineItem[]>([])
  const stableItems = useMemo(() => {
    stableRef.current = stabilizedTimeline(stableRef.current, groupedItems)
    return stableRef.current
  }, [groupedItems])
  const lastMsgIndex = useMemo(() => lastMessageIndex(stableItems), [stableItems])
  const itemIds = useMemo(() => items.map(timelineItemId), [items])
  const enter = useEnterTracker(sessionId, itemIds)
  const [selection, setSelection] = useState<{ sessionId: SessionId; toolCall: ToolCall } | null>(null)
  const openSubagent = useCallback((toolCall: ToolCall) => setSelection({ sessionId, toolCall }), [sessionId])
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
  const { pinned, jumpToLatest } = useListFollow(listRef, count, sessionId)
  const newCount = useUnread(count, pinned)

  useEffect(() => {
    if (!pinned) return
    useAcpStore.getState?.()?.clearSessionBackfill?.(sessionId)
  }, [pinned, sessionId])

  // Older history loads only on reader intent: scrolled away and at the first row.
  const loadingOlderRef = useRef(false)
  const onVisibleRange = useCallback(
    (event: { startIndex?: number }) => {
      if ((event.startIndex ?? 1) > 0 || pinned || loadingOlderRef.current || count === 0) return
      loadingOlderRef.current = true
      void useAcpStore
        .getState()
        .loadOlderMessages(sessionId, 50)
        .finally(() => {
          loadingOlderRef.current = false
        })
    },
    [pinned, count, sessionId]
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
    ...tw(edge === 'top' ? 'bg-gradient-to-b from-terminal-bg to-transparent' : 'bg-gradient-to-t from-terminal-bg to-transparent')
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
        {stableItems.map((item, index) => (
          <div
            key={item.key}
            testId={`chat-row-${item.key}`}
            style={{
              display: 'flex',
              justifyContent: 'center',
              paddingLeft: GUTTER,
              paddingRight: GUTTER,
              paddingTop: index === 0 ? EDGE_PAD : 0,
              paddingBottom: index === count - 1 ? EDGE_PAD : 0
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: COLUMN_MAX, minWidth: 0 }}>
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
            </div>
          </div>
        ))}
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
