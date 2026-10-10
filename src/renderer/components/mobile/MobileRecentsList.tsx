import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { ChatEntryIcon, type ChatHistorySidebarEntry } from '@/components/chat/ChatHistoryEntryRow'
import { ChatDeleteConfirmDialog } from '@/components/chat/ChatHistoryTab'
import { useChatHistoryEntries } from '@/components/chat/use-chat-history-entries'
import { MoreHorizontal } from '@/components/icons'
import {
  AgentChatStatusGlyphs,
  agentChatStatusSlots,
  useAgentChatStatusSignals
} from '@/components/workspace/tabs/agent-chat-status'
import { useMobileTabActions } from '@/hooks/use-mobile-tab-actions'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { MobileRecentsActionsSheet } from './MobileRecentsActionsSheet'

/** How long a touch must hold still before it opens the row actions (iOS fires no `contextmenu`). */
const LONG_PRESS_MS = 500
/** A touch that moves further than this (px) is a scroll, not a long-press. */
const LONG_PRESS_SLOP_PX = 10

/**
 * Open chats not in the session index yet sort to the top of Today: the
 * largest timestamp `groupSessionsByRecency` still buckets as today.
 */
const OPEN_ONLY_ACTIVITY_AT = Number.MAX_SAFE_INTEGER

/** Claude-style row: borderless 16px label, the active row a full-width pill. */
function rowClass(isActive: boolean): string {
  return cn(
    'flex min-h-11 w-full min-w-0 items-center gap-3 rounded-full px-4 py-2 text-left text-base outline-none transition-colors duration-150 ease-out',
    'select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
    isActive ? 'bg-secondary text-foreground' : 'text-foreground hover:bg-foreground/[0.04]'
  )
}

/**
 * How long the click a touch long-press ends with may arrive and still be
 * swallowed. Past it (no click came: the touch was cancelled), keys and taps
 * select the row again.
 */
const SWALLOW_CLICK_MS = 800

/**
 * Long-press for touch (a held pointer), plus `contextmenu` for Android
 * long-press, a mouse right-click and the keyboard menu key. Only a touch
 * long-press is followed by a click, so only it swallows the next click, and
 * only briefly; a key press always selects.
 */
function useRowLongPress(onLongPress: () => void) {
  const timerRef = useRef<number | null>(null)
  const swallowTimerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)
  const clear = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }
  const resetSwallow = (): void => {
    if (swallowTimerRef.current !== null) window.clearTimeout(swallowTimerRef.current)
    swallowTimerRef.current = null
    firedRef.current = false
  }
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      if (swallowTimerRef.current !== null) window.clearTimeout(swallowTimerRef.current)
    },
    []
  )
  /** A touch hold fired: open the actions and swallow the click that ends the touch. */
  const fireFromTouch = (): void => {
    clear()
    resetSwallow()
    firedRef.current = true
    swallowTimerRef.current = window.setTimeout(resetSwallow, SWALLOW_CLICK_MS)
    onLongPress()
  }
  return {
    handlers: {
      onPointerDown: (event: React.PointerEvent) => {
        resetSwallow()
        if (event.pointerType !== 'touch') return
        startRef.current = { x: event.clientX, y: event.clientY }
        timerRef.current = window.setTimeout(fireFromTouch, LONG_PRESS_MS)
      },
      onPointerMove: (event: React.PointerEvent) => {
        const start = startRef.current
        if (!start) return
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) {
          clear()
        }
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onKeyDown: resetSwallow,
      onContextMenu: (event: React.MouseEvent) => {
        event.preventDefault()
        // Android fires `contextmenu` for the same hold the timer caught.
        if (firedRef.current) return
        if (startRef.current) {
          // A touch hold still in progress: same as the timer firing.
          fireFromTouch()
          return
        }
        // A right-click or the keyboard menu key: no click follows.
        onLongPress()
      }
    },
    /** True (once) when the click that follows a touch long-press must be ignored. */
    consumeLongPress: (): boolean => {
      const fired = firedRef.current
      resetSwallow()
      return fired
    }
  }
}

interface RowShellProps {
  entryId: string
  title: string
  isActive: boolean
  ariaLabel: string
  disabled?: boolean
  icon: React.ReactNode
  status?: React.ReactNode
  onSelect: () => void
  onOpenActions: () => void
}

/** The markup every Recents row shares: one select button and a focus-only actions button. */
function RecentsRowShell({
  entryId,
  title,
  isActive,
  ariaLabel,
  disabled,
  icon,
  status,
  onSelect,
  onOpenActions
}: RowShellProps): React.JSX.Element {
  const { handlers, consumeLongPress } = useRowLongPress(onOpenActions)
  return (
    <div data-recents-entry-id={entryId} className="relative flex min-w-0 items-center">
      <button
        type="button"
        data-recents-open=""
        className={rowClass(isActive)}
        aria-current={isActive ? 'page' : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        {...handlers}
        onClick={() => {
          if (consumeLongPress()) return
          onSelect()
        }}
      >
        <span className="inline-flex shrink-0 items-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {status ? <span className="flex shrink-0 items-center gap-1">{status}</span> : null}
      </button>
      {/* Keyboard and screen-reader route to the row actions. Invisible and
          untouchable until it holds focus (a screen reader's double-tap
          focuses it first), so the row shows no trailing icon. */}
      <button
        type="button"
        data-recents-actions=""
        aria-label={`More actions for ${title}`}
        aria-haspopup="dialog"
        onClick={onOpenActions}
        className="pointer-events-none absolute right-1 top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-secondary text-foreground opacity-0 outline-none focus:pointer-events-auto focus:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

interface OpenRecentsRowProps {
  entry: ChatHistorySidebarEntry
  sessionId: string
  isActive: boolean
  onSelect: () => void
  onOpenActions: (title: string) => void
}

/**
 * An open chat in Recents: live title and status glyphs (the signals the
 * desktop `agent-chat-tab` uses; "New activity" from the unread store). Status
 * is glyphs with sr-only text, never a text chip beside the title.
 */
function OpenRecentsRow({
  entry,
  sessionId,
  isActive,
  onSelect,
  onOpenActions
}: OpenRecentsRowProps): React.JSX.Element {
  const signals = useAgentChatStatusSignals(sessionId)
  const unread = useAgentChatUnreadStore((state) => Boolean(state.unread[sessionId]))
  const { showWorking, showUnread, statusText } = agentChatStatusSlots({ ...signals, unread })
  const { title, indexAgentId, agentConfigId, agents } = useAcpStore(
    useShallow((s) => {
      const indexEntry = (s.sessionIndex ?? []).find((e) => e.id === sessionId)
      return {
        title: s.sessions?.[sessionId]?.title || indexEntry?.title || entry.title || 'Agent Chat',
        indexAgentId: indexEntry?.agentId,
        agentConfigId: indexEntry?.agentConfigId,
        agents: indexEntry?.agents
      }
    })
  )
  const hasStatus = signals.closing || signals.needsAttention || showWorking || showUnread
  return (
    <RecentsRowShell
      entryId={entry.id}
      title={title}
      isActive={isActive}
      ariaLabel={statusText ? `${title}, ${statusText}` : title}
      icon={
        <ChatEntryIcon
          agentId={signals.session?.agentId ?? indexAgentId ?? entry.agentId}
          agentConfigId={agentConfigId ?? entry.agentConfigId}
          agents={agents ?? entry.agents}
        />
      }
      status={
        hasStatus ? (
          <AgentChatStatusGlyphs
            closing={signals.closing}
            needsAttention={signals.needsAttention}
            showWorking={showWorking}
            showUnread={showUnread}
          />
        ) : null
      }
      onSelect={onSelect}
      onOpenActions={() => onOpenActions(title)}
    />
  )
}

interface MobileRecentsListProps {
  /** Title filter (the drawer's search field). */
  query: string
  /** Id of the drawer's Recents heading: the focus fallback once no row can take it. */
  headingId: string
  /** The drawer's scroll body, watched by the lazy-load sentinel. */
  scrollRootRef?: RefObject<HTMLElement | null>
  /** The active pane's active tab id: that open chat's row is `aria-current="page"`. */
  activeTabId: string | null
  /** A row took the user to a chat: the drawer closes for a navigation. */
  onNavigate: () => void
}

/**
 * The row the actions sheet acts on: Close for an open chat, Delete for a chat
 * the session index holds (an open chat in history offers both).
 */
interface ActionsTarget {
  entryId: string
  title: string
  canClose: boolean
  canDelete: boolean
}

/**
 * The drawer's one chat list: open chats merged into the scoped history, so
 * each chat appears once (an open one with its live status, highlighted when
 * it is on screen), grouped Today / Yesterday / Earlier. An open chat the
 * session index does not list yet sits at the top of Today.
 */
export function MobileRecentsList({
  query,
  headingId,
  scrollRootRef,
  activeTabId,
  onNavigate
}: MobileRecentsListProps): React.JSX.Element {
  const baseId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const { paneTabs, selectTab, closePaneTab } = useMobileTabActions()

  const openChats = useMemo(
    () =>
      paneTabs.flatMap(({ tab, paneId }) => (tab.type === 'agent-chat' ? [{ tab, paneId }] : [])),
    [paneTabs]
  )
  const openSessionIds = useMemo(() => openChats.map(({ tab }) => tab.sessionId), [openChats])
  const sessionIndex = useAcpStore((s) => s.sessionIndex)
  const indexedIds = useMemo(() => new Set((sessionIndex ?? []).map((e) => e.id)), [sessionIndex])
  // Titles of the open chats, for the search filter on chats the index lacks.
  const openTitles = useAcpStore(
    useShallow((s) =>
      openSessionIds.map(
        (id) =>
          s.sessions?.[id]?.title ||
          (s.sessionIndex ?? []).find((e) => e.id === id)?.title ||
          'Agent Chat'
      )
    )
  )
  const extraEntries = useMemo<ChatHistorySidebarEntry[]>(
    () =>
      openSessionIds.map((id, index) => ({
        id,
        title: openTitles[index] ?? 'Agent Chat',
        messageCount: 0,
        status: 'active',
        discovered: false,
        lastActivityAt: OPEN_ONLY_ACTIVITY_AT,
        canOpen: true
      })),
    [openSessionIds, openTitles]
  )

  const {
    mergedEntries,
    filtered,
    visible,
    groups,
    hasMore,
    sentinelRef,
    loadMore,
    openEntry,
    deleteEntry
  } = useChatHistoryEntries({
    query,
    scrollRootRef,
    extraEntries,
    onSessionOpened: onNavigate,
    logSource: 'MobileRecentsList.delete'
  })

  const openBySession = useMemo(
    () => new Map(openChats.map((entry) => [entry.tab.sessionId, entry])),
    [openChats]
  )

  const [actionsTarget, setActionsTarget] = useState<ActionsTarget | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  // The delete confirm, as the desktop History: `deleteTarget` outlives
  // `deleteOpen` so the description does not blank while it animates closed.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const deleteFocusRef = useRef<() => void>(() => {})
  const confirmedDeleteIdRef = useRef<string | null>(null)
  // Set when an action opens the delete confirm: it takes focus, so the
  // actions sheet must not put focus back on the row first.
  const skipSheetFocusRef = useRef(false)

  const rowElements = useCallback(
    (): HTMLElement[] =>
      Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-recents-entry-id]') ?? []),
    []
  )

  // Focus a row's select button, else the Recents heading, else this list's
  // root (always mounted and programmatically focusable), so focus is never lost.
  const focusRowOrFallback = useCallback(
    (id: string | undefined): void => {
      const row = id ? rowElements().find((el) => el.dataset.recentsEntryId === id) : undefined
      const button = row?.querySelector<HTMLElement>('[data-recents-open]')
      for (const target of [button, document.getElementById(headingId), rootRef.current]) {
        if (!target?.isConnected) continue
        target.focus()
        if (document.activeElement === target) return
      }
      void logFrontendError({
        level: 'info',
        source: 'MobileRecentsList.focus',
        message: 'Recents action ended with no connected focus target'
      })
    },
    [rowElements, headingId]
  )

  const openActions = (target: ActionsTarget): void => {
    skipSheetFocusRef.current = false
    setActionsTarget(target)
    setActionsOpen(true)
  }

  const closeOpenChat = (sessionId: string): void => {
    const open = openBySession.get(sessionId)
    if (!open) {
      void logFrontendError({
        level: 'warn',
        source: 'MobileRecentsList.close',
        message: `Close requested for chat ${sessionId}, which has no open tab`
      })
      return
    }
    closePaneTab(open.tab)
  }

  const requestDelete = (id: string, title: string): void => {
    skipSheetFocusRef.current = true
    setDeleteTarget({ id, title })
    setDeleteOpen(true)
    confirmedDeleteIdRef.current = null
    deleteFocusRef.current = () => focusRowOrFallback(id)
  }

  const confirmDelete = (): void => {
    if (!deleteTarget || confirmedDeleteIdRef.current === deleteTarget.id) return
    const { id } = deleteTarget
    confirmedDeleteIdRef.current = id
    const rows = rowElements()
    const index = rows.findIndex((el) => el.dataset.recentsEntryId === id)
    const nextId = index >= 0 ? rows[index + 1]?.dataset.recentsEntryId : undefined
    deleteFocusRef.current = () => focusRowOrFallback(nextId)
    deleteEntry(id)
  }

  return (
    <div ref={rootRef} tabIndex={-1} className="flex flex-col px-2 pb-2 outline-none">
      {mergedEntries.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          No chats yet. Start one with the New chat button.
        </p>
      ) : filtered.length === 0 ? (
        <p className="px-4 py-4 text-center text-sm text-muted-foreground">
          No chats match this search.
        </p>
      ) : (
        groups.map(({ group, entries }) => {
          const labelId = `${baseId}-${group}`
          return (
            <div key={group}>
              <h3 id={labelId} className="label-group px-4 pb-1 pt-3 text-muted-foreground">
                {group}
              </h3>
              <div role="group" aria-labelledby={labelId} className="flex flex-col gap-0.5">
                {entries.map((entry) => {
                  const open = openBySession.get(entry.id)
                  if (open) {
                    return (
                      <OpenRecentsRow
                        key={entry.id}
                        entry={entry}
                        sessionId={open.tab.sessionId}
                        isActive={open.tab.id === activeTabId}
                        onSelect={() => {
                          selectTab(open.paneId, open.tab.id)
                          onNavigate()
                        }}
                        onOpenActions={(title) =>
                          openActions({
                            entryId: entry.id,
                            title,
                            canClose: true,
                            canDelete: indexedIds.has(entry.id)
                          })
                        }
                      />
                    )
                  }
                  return (
                    <RecentsRowShell
                      key={entry.id}
                      entryId={entry.id}
                      title={entry.title}
                      isActive={false}
                      ariaLabel={entry.status === 'error' ? `${entry.title}, Failed` : entry.title}
                      disabled={entry.discovered && !entry.canOpen}
                      icon={
                        <ChatEntryIcon
                          agentId={entry.agentId}
                          agentConfigId={entry.agentConfigId}
                          agents={entry.agents}
                        />
                      }
                      status={
                        entry.status === 'error' ? (
                          <span
                            className="inline-flex size-3.5 items-center justify-center"
                            title="Failed"
                          >
                            <span className="size-2 rounded-full bg-destructive" aria-hidden />
                            <span className="sr-only">Failed</span>
                          </span>
                        ) : null
                      }
                      onSelect={() => void openEntry(entry)}
                      onOpenActions={() =>
                        openActions({
                          entryId: entry.id,
                          title: entry.title,
                          canClose: false,
                          canDelete: true
                        })
                      }
                    />
                  )
                })}
              </div>
            </div>
          )
        })
      )}
      {hasMore && (
        <div ref={sentinelRef} className="px-2 py-2">
          <button
            type="button"
            onClick={loadMore}
            className="min-h-11 w-full rounded-full py-1 text-sm tabular-nums text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.04]"
          >
            Load more ({filtered.length - visible.length} more)
          </button>
        </div>
      )}

      <MobileRecentsActionsSheet
        open={actionsOpen}
        onOpenChange={setActionsOpen}
        title={actionsTarget?.title ?? ''}
        onCloseChat={
          actionsTarget?.canClose ? () => closeOpenChat(actionsTarget.entryId) : undefined
        }
        onDeleteChat={
          actionsTarget?.canDelete
            ? () => requestDelete(actionsTarget.entryId, actionsTarget.title)
            : undefined
        }
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (skipSheetFocusRef.current) return
          // A closed chat's row may re-render as a history row: look it up now.
          focusRowOrFallback(actionsTarget?.entryId)
        }}
      />

      <ChatDeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={deleteTarget?.title ?? ''}
        onConfirm={confirmDelete}
        onClosed={() => deleteFocusRef.current()}
      />
    </div>
  )
}
