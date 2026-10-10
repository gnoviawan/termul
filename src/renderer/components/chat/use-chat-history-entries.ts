import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { groupSessionsByRecency, scopeSessionIndex } from '@/lib/acp-history-persistence'
import { logFrontendError } from '@/lib/log-api'
import { chatsMatchAnnouncement } from '@/lib/shell-announcements'
import { useAcpStore } from '@/stores/acp-store'
import { getActiveWorktreeFromStore, useActiveProject } from '@/stores/project-store'
import { useShellAnnouncerStore } from '@/stores/shell-announcer-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { ChatHistorySidebarEntry } from './ChatHistoryEntryRow'

/** How many sidebar rows to render per lazy-load page. */
export const SIDEBAR_PAGE_SIZE = 50

/**
 * How long the result count must hold still before it is announced, so typing
 * "auth" does not announce the count for "a", "au" and "aut" on the way.
 */
const SEARCH_COUNT_ANNOUNCE_DEBOUNCE_MS = 500

interface UseChatHistoryEntriesOptions {
  /** Title filter. */
  query: string
  /** Scroll container the lazy-load observer watches. Defaults to the viewport. */
  scrollRootRef?: RefObject<HTMLElement | null>
  /**
   * Entries merged into the scoped history (the mobile Recents list's open
   * chats). One the scoped history already lists is dropped, so every chat
   * appears once. Must be memoized.
   */
  extraEntries?: ChatHistorySidebarEntry[]
  /** Called after a chat row successfully opens (e.g. close a mobile drawer). */
  onSessionOpened?: () => void
  /** `log-api` source for a failed delete (the calling surface). */
  logSource?: string
}

export interface ChatHistoryEntries {
  /** Every scoped entry (extras merged in), unfiltered: empty means "no chats yet". */
  mergedEntries: ChatHistorySidebarEntry[]
  /** The entries matching the query, newest first. */
  filtered: ChatHistorySidebarEntry[]
  /** The rendered window of `filtered`. */
  visible: ChatHistorySidebarEntry[]
  /** `visible` grouped Today / Yesterday / Earlier. */
  groups: ReturnType<typeof groupSessionsByRecency<ChatHistorySidebarEntry>>
  hasMore: boolean
  /** Attach to the lazy-load sentinel below the list. */
  sentinelRef: RefObject<HTMLDivElement>
  loadMore: () => void
  openEntry: (entry: ChatHistorySidebarEntry) => Promise<void>
  deleteEntry: (id: string) => void
}

/**
 * The chat history derivation shared by the desktop `ChatHistoryTab` and the
 * mobile Recents list: ADR 0002 scoping, Termul-created sessions only, query
 * filter, newest-first sort, the settled-count announcement, the lazy window
 * with its sentinel observer, recency groups, and the open/delete actions.
 */
export function useChatHistoryEntries({
  query,
  scrollRootRef,
  extraEntries,
  onSessionOpened,
  logSource = 'ChatHistoryTab.delete'
}: UseChatHistoryEntriesOptions): ChatHistoryEntries {
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
    const entries: ChatHistorySidebarEntry[] = scopedIndex
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

    if (!extraEntries || extraEntries.length === 0) return entries
    // An extra entry the scoped history already lists appears once, as
    // history, under the extra's title (the one the row displays, e.g. an
    // open chat's live title) so the search matches what the user sees.
    const extraById = new Map(extraEntries.map((e) => [e.id, e]))
    const listed = new Set(entries.map((e) => e.id))
    const merged = entries.map((e) => {
      const extra = extraById.get(e.id)
      return extra && extra.title !== e.title ? { ...e, title: extra.title } : e
    })
    const extras = extraEntries.filter((e) => !listed.has(e.id))
    return extras.length > 0 ? [...extras, ...merged] : merged
  }, [scopedIndex, extraEntries])

  // Lazy rendering: keep all results in memory but only render a growing window
  // (a project can accumulate hundreds of sessions; rendering all rows is the cost).
  const [visibleCount, setVisibleCount] = useState(SIDEBAR_PAGE_SIZE)
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

  const loadMore = useCallback(() => setVisibleCount((c) => c + SIDEBAR_PAGE_SIZE), [])

  const openEntry = useCallback(
    async (entry: ChatHistorySidebarEntry) => {
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

  const deleteEntry = useCallback(
    (id: string) => {
      void deleteHistorySession(id).catch(() => {
        toast.error('Could not delete that chat. Try again.')
        void logFrontendError({
          level: 'warn',
          source: logSource,
          message: `Failed to delete chat history session ${id}`
        })
      })
    },
    [deleteHistorySession, logSource]
  )

  return {
    mergedEntries,
    filtered,
    visible,
    groups,
    hasMore,
    sentinelRef,
    loadMore,
    openEntry,
    deleteEntry
  }
}
