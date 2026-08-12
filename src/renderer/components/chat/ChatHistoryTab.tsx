import { Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { groupSessionsByRecency, scopeSessionIndex } from '@/lib/acp-history-persistence'
import { useAcpStore } from '@/stores/acp-store'
import { getActiveWorktreeFromStore, useActiveProject } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ChatHistoryEntryRow, type ChatHistorySidebarEntry } from './ChatHistoryEntryRow'

/** How many sidebar rows to render per lazy-load page. */
const SIDEBAR_PAGE_SIZE = 50

type SidebarEntry = ChatHistorySidebarEntry

/** Sidebar tab listing persisted Termul-created chat sessions, grouped by recency with search. */
export function ChatHistoryTab({
  onSessionOpened
}: {
  /** Optional callback after a chat row successfully opens (e.g. close a mobile drawer). */
  onSessionOpened?: () => void
} = {}): React.JSX.Element {
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
        lastActivityAt: e.lastActivityAt,
        canOpen: true
      }))

    return entries
  }, [scopedIndex])

  const [query, setQuery] = useState('')
  // Lazy rendering: keep all results in memory but only render a growing window
  // (a project can accumulate hundreds of sessions; rendering all rows is the cost).
  const [visibleCount, setVisibleCount] = useState(SIDEBAR_PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
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
      { root: scrollRef.current, rootMargin: '200px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, visibleCount])

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
      })
    },
    [deleteHistorySession]
  )

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 py-1.5 border-b border-sidebar-border">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="w-full rounded-md bg-background pl-7 pr-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto py-1">
        {mergedEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-center text-xs text-muted-foreground opacity-70">
            No chats yet. Start one with the New Chat button.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">No matches.</div>
        ) : (
          groups.map(({ group, entries }) => (
            <div key={group}>
              <div className="label-group px-3 py-1 text-muted-foreground/70">{group}</div>
              {entries.map((entry) => (
                <ChatHistoryEntryRow
                  key={entry.id}
                  entry={entry}
                  onOpen={(e) => void handleOpen(e)}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          ))
        )}
        {hasMore && (
          <div ref={sentinelRef} className="px-3 py-2">
            <button
              type="button"
              onClick={() => setVisibleCount((c) => c + SIDEBAR_PAGE_SIZE)}
              className="w-full rounded-md py-1 text-3xs text-muted-foreground hover:bg-sidebar-accent"
            >
              Load more ({filtered.length - visible.length} more)
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
