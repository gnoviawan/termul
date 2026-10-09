import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { groupSessionsByRecency, scopeSessionIndex } from '@/lib/acp-history-persistence'
import { logFrontendError } from '@/lib/log-api'
import { chatsMatchAnnouncement } from '@/lib/shell-announcements'
import { useAcpStore } from '@/stores/acp-store'
import { getActiveWorktreeFromStore, useActiveProject } from '@/stores/project-store'
import { useShellAnnouncerStore } from '@/stores/shell-announcer-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ChatHistoryEntryRow, type ChatHistorySidebarEntry } from './ChatHistoryEntryRow'

/** How many sidebar rows to render per lazy-load page. */
const SIDEBAR_PAGE_SIZE = 50

/**
 * How long the result count must hold still before it is announced, so typing
 * "auth" does not announce the count for "a", "au" and "aut" on the way.
 */
const SEARCH_COUNT_ANNOUNCE_DEBOUNCE_MS = 500

type SidebarEntry = ChatHistorySidebarEntry

interface ChatHistoryTabProps {
  /** Optional callback after a chat row successfully opens (e.g. close a mobile drawer). */
  onSessionOpened?: () => void
  /** Title filter. The search field lives with the host (the mobile drawer), not in this tab. */
  query?: string
  /** Id of the host's History heading: the focus fallback after the last visible row is deleted. */
  historyHeadingId?: string
  /** Scroll container the lazy-load observer watches. Defaults to the viewport. */
  scrollRootRef?: RefObject<HTMLElement | null>
}

/** Sidebar tab listing persisted Termul-created chat sessions, grouped by recency; filtered by `query`. */
export function ChatHistoryTab({
  onSessionOpened,
  query = '',
  historyHeadingId,
  scrollRootRef
}: ChatHistoryTabProps = {}): React.JSX.Element {
  const sessionIndex = useAcpStore((s) => s.sessionIndex)
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const openDiscoveredSession = useAcpStore((s) => s.openDiscoveredSession)
  const deleteHistorySession = useAcpStore((s) => s.deleteHistorySession)
  const addAgentChatTab = useWorkspaceStore((s) => s.addAgentChatTab)
  // Subscribe to the full active-project record so the sidebar re-scopes when
  // the active worktree changes (not just when the active project id changes).
  const activeProject = useActiveProject()
  const activeProjectId = activeProject?.id ?? ''
  const activeCwd = useMemo(() => {
    if (!activeProject) return ''
    const wt = getActiveWorktreeFromStore(activeProject.id)
    return wt?.path ?? activeProject.path ?? ''
  }, [activeProject])

  // Active project's registered worktree paths. Passed into `scopeSessionIndex`
  // so worktree-cwd chats stay reachable from the project root view and across
  // restarts where `activeWorktreeId` is null (the sidebar would otherwise hide
  // them because their cwd differs from the root). Re-derived whenever the
  // active project record changes (covers reconciler discovery + launch adds).
  const worktreePaths = useMemo(
    () => activeProject?.worktrees?.map((w) => w.path) ?? [],
    [activeProject]
  )

  // ADR 0002 scoping: show only sessions whose `(projectId, cwd)` match the
  // active project + worktree/root, falling back to projectId-only matching
  // when the exact cwd yields nothing (a chat whose cwd drifted since it was
  // created is still reachable instead of silently hidden). Worktree-inclusive
  // reachability (above) keeps the project's worktree chats listed from the
  // root view. See `scopeSessionIndex` for the contract.
  const scopedIndex = useMemo(
    () => scopeSessionIndex(sessionIndex, activeProjectId, activeCwd, worktreePaths),
    [sessionIndex, activeProjectId, activeCwd, worktreePaths]
  )

  // Termul-created sessions only. The host-owned `discovered` flag is `false`
  // for sessions Termul created (`register_session`) and `true` for external
  // `session/list` mirrors — filter hides CLI/other-client chats.
  const mergedEntries = useMemo(() => {
    const entries: SidebarEntry[] = scopedIndex
      .filter((e) => e.discovered !== true)
      .map((e) => ({
        id: e.id,
        title: e.title,
        messageCount: e.messageCount,
        status: e.status,
        discovered: false,
        agentId: e.agentId,
        agentConfigId: e.agentConfigId,
        agents: e.agents,
        lastActivityAt: e.lastActivityAt,
        canOpen: true
      }))

    return entries
  }, [scopedIndex])

  const baseId = useId()
  // Lazy rendering: keep all results in memory but only render a growing window
  // (a project can accumulate hundreds of sessions; rendering all rows is the cost).
  const [visibleCount, setVisibleCount] = useState(SIDEBAR_PAGE_SIZE)
  const rootRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Filter the FULL set by query first (so search reaches every session, not
  // just the rendered window), then sort newest-first so the visible cap keeps
  // the most recent sessions.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base =
      q.length === 0
        ? mergedEntries
        : mergedEntries.filter((e) => e.title.toLowerCase().includes(q))
    return base.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }, [mergedEntries, query])

  // Announce the settled result count to the mobile shell live region. Inert on
  // the desktop sidebar, where no region is mounted. An empty query stays silent.
  const trimmedQuery = query.trim()
  const resultCount = filtered.length
  useEffect(() => {
    if (trimmedQuery.length === 0) return
    const timer = setTimeout(() => {
      useShellAnnouncerStore.getState().announce(chatsMatchAnnouncement(resultCount))
    }, SEARCH_COUNT_ANNOUNCE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [trimmedQuery, resultCount])

  // Reset the window when the query or active scope changes. `worktreePaths`
  // is a scoping input (worktree-inclusive reachability), so a reconciler
  // discovery that grows the set without changing `activeCwd` must also reset
  // the visible window — otherwise a stale "No matches"/window renders against
  // the new scope.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on scope/query change
  useEffect(() => {
    setVisibleCount(SIDEBAR_PAGE_SIZE)
  }, [query, activeProjectId, activeCwd, worktreePaths])

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const hasMore = filtered.length > visible.length

  const groups = useMemo(() => groupSessionsByRecency(visible, Date.now()), [visible])

  // Grow the window when the bottom sentinel scrolls into view (lazy load).
  // `visibleCount` is intentionally in the deps so the observer re-arms after
  // each growth: IntersectionObserver only fires on intersection transitions, so
  // a sentinel already in view after a grow needs a fresh observe() to re-check.
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount re-arms the observer
  useEffect(() => {
    if (!hasMore) return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (obsEntries) => {
        if (obsEntries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => c + SIDEBAR_PAGE_SIZE)
        }
      },
      { root: scrollRootRef?.current ?? null, rootMargin: '200px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, visibleCount, scrollRootRef])

  const handleOpen = useCallback(
    async (entry: SidebarEntry) => {
      try {
        if (entry.discovered && entry.agentId && entry.cwd) {
          // Register the restore synchronously before focusing the tab so its
          // first render shows the branded preload, then reconnect in the
          // background just like local mirrors.
          const opening = openDiscoveredSession(entry.agentId, entry.id, entry.cwd, activeProjectId)
          addAgentChatTab(entry.id)
          void opening.catch(() => {
            toast.error('Could not open that chat. Try again.')
          })
        } else {
          // Register the restore synchronously before focusing the tab so its
          // first render cannot miss the branded preload. Reconnect continues
          // in the background after the local transcript becomes usable.
          const opening = openHistorySession(entry.id)
          addAgentChatTab(entry.id)
          void opening.catch(() => {
            toast.error('Could not reconnect. Try again.')
          })
        }
        onSessionOpened?.()
      } catch {
        toast.error('Could not open that chat. Try again.')
      }
    },
    [addAgentChatTab, openHistorySession, openDiscoveredSession, activeProjectId, onSessionOpened]
  )

  const handleDelete = useCallback(
    (id: string) => {
      void deleteHistorySession(id).catch(() => {
        toast.error('Could not delete that chat. Try again.')
        void logFrontendError({
          level: 'warn',
          source: 'ChatHistoryTab.delete',
          message: `Failed to delete chat history session ${id}`
        })
      })
    },
    [deleteHistorySession]
  )

  // Delete confirm. The trash button only requests it; nothing is deleted
  // until the AlertDialog's Delete. `deleteTarget` outlives `deleteOpen` so the
  // description does not blank out while the dialog animates closed.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // Where focus goes when the dialog closes: set when it opens (Cancel / Esc →
  // that row's trash button) and again on confirm (→ the next visible row).
  const closeFocusRef = useRef<() => void>(() => {})
  // The confirm's Delete stays tappable while the dialog animates closed, so a
  // quick second tap would delete the same session twice (the second rejects
  // and toasts a false "Could not delete"). Cleared each time a confirm opens.
  const confirmedDeleteIdRef = useRef<string | null>(null)

  const rowElements = useCallback(
    (): HTMLElement[] =>
      Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-history-entry-id]') ?? []),
    []
  )

  const focusRowButton = useCallback(
    (id: string, button: 'open' | 'delete'): boolean => {
      const row = rowElements().find((el) => el.dataset.historyEntryId === id)
      const target = row?.querySelector<HTMLElement>(`[data-history-${button}]`)
      if (!target) return false
      target.focus()
      return true
    },
    [rowElements]
  )

  // Last-resort focus target once no row can take it (the deleted chat was the
  // last visible one): the host's History heading, else this tab's own root,
  // which stays mounted (and programmatically focusable) so focus is never lost.
  const focusFallback = useCallback((): void => {
    const heading = historyHeadingId ? document.getElementById(historyHeadingId) : null
    const target = heading ?? rootRef.current
    target?.focus()
  }, [historyHeadingId])

  const requestDelete = useCallback(
    (id: string) => {
      const title = mergedEntries.find((e) => e.id === id)?.title ?? ''
      setDeleteTarget({ id, title })
      setDeleteOpen(true)
      confirmedDeleteIdRef.current = null
      closeFocusRef.current = () => {
        if (!focusRowButton(id, 'delete')) focusFallback()
      }
    },
    [mergedEntries, focusRowButton, focusFallback]
  )

  const confirmDelete = useCallback(() => {
    if (!deleteTarget || confirmedDeleteIdRef.current === deleteTarget.id) return
    const { id } = deleteTarget
    confirmedDeleteIdRef.current = id
    const rows = rowElements()
    const index = rows.findIndex((el) => el.dataset.historyEntryId === id)
    const nextId = index >= 0 ? rows[index + 1]?.dataset.historyEntryId : undefined
    closeFocusRef.current = () => {
      if (!nextId || !focusRowButton(nextId, 'open')) focusFallback()
    }
    handleDelete(id)
  }, [deleteTarget, rowElements, focusRowButton, focusFallback, handleDelete])

  return (
    <div ref={rootRef} tabIndex={-1} className="@container flex flex-col outline-none">
      <div className="py-1">
        {mergedEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-center text-xs text-muted-foreground">
            No chats yet. Start one with the New chat button.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            No chats match this search.
          </div>
        ) : (
          groups.map(({ group, entries }) => {
            const labelId = `${baseId}-${group}`
            return (
              <div key={group}>
                <h3 id={labelId} className="label-group px-3 py-1 text-muted-foreground">
                  {group}
                </h3>
                <div role="group" aria-labelledby={labelId}>
                  {entries.map((entry) => (
                    <ChatHistoryEntryRow
                      key={entry.id}
                      entry={entry}
                      onOpen={(e) => void handleOpen(e)}
                      onDelete={requestDelete}
                    />
                  ))}
                </div>
              </div>
            )
          })
        )}
        {hasMore && (
          <div ref={sentinelRef} className="px-3 py-2">
            <button
              type="button"
              onClick={() => setVisibleCount((c) => c + SIDEBAR_PAGE_SIZE)}
              className="min-h-11 w-full rounded-md py-1 text-xs tabular-nums text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03]"
            >
              Load more ({filtered.length - visible.length} more)
            </button>
          </div>
        )}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // Radix would restore focus to the trigger; there is none (the row's
            // trash button opens this programmatically), so place it ourselves.
            event.preventDefault()
            closeFocusRef.current()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat</AlertDialogTitle>
            <AlertDialogDescription>
              {`Delete “${deleteTarget?.title ?? ''}”? This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
