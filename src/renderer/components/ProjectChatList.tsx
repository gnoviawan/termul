import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  type ProjectChatEntry,
  type ProjectChatLiveState,
  ProjectChatRow
} from '@/components/sidebar/project-chat-row'
import { SidebarSearchField } from '@/components/sidebar/sidebar-search-field'
import { clipboardApi, openerApi } from '@/lib/api'
import { openTerminalAtCwd } from '@/lib/terminal-spawn'
import { useAcpStore } from '@/stores/acp-store'
import { findPaneById, useWorkspaceStore } from '@/stores/workspace-store'

/** Hard cap of rendered chat rows per project before lazy pagination kicks in. */
const PAGE_SIZE = 10

/** Session id of the agent chat tab focused in the active pane, if any. */
function useActiveChatSessionId(): string | null {
  return useWorkspaceStore((s) => {
    const pane = findPaneById(s.root, s.activePaneId)
    if (pane?.type !== 'leaf') return null
    const tab = pane.tabs.find((t) => t.id === pane.activeTabId)
    return tab?.type === 'agent-chat' ? tab.sessionId : null
  })
}

/**
 * Session ids with a live turn, and session ids that wait on a permission or
 * question. Primitive arrays so `useShallow` keeps re-renders cheap.
 */
function useChatLiveSessionIds(): { running: string[]; needsYou: string[] } {
  const running = useAcpStore(
    useShallow((s) =>
      Object.entries(s.sessions ?? {})
        .filter(([, session]) => session.activeTurn)
        .map(([id]) => id)
    )
  )
  const needsYou = useAcpStore(
    useShallow((s) => [
      ...Object.values(s.pendingPermissions ?? {}).map((item) => item.sessionId),
      ...Object.values(s.pendingQuestions ?? {}).map((item) => item.sessionId)
    ])
  )
  return { running, needsYou }
}

interface ProjectChatListProps {
  projectId: string
}

/**
 * Per-project chat history list rendered under a project's expandable submenu.
 * Scopes the ACP session index by `projectId` (Termul-created sessions only,
 * newest-first) — every chat for the project is reachable from one place,
 * regardless of which worktree/root cwd it runs in. A bounded `max-height`
 * container scrolls internally so a long history never pushes the next project
 * down. The terminal icon opens a terminal at the chat's cwd via
 * `openTerminalAtCwd` (no `setActiveWorktree` side effect); clicking a row
 * opens/resumes the chat.
 */
export function ProjectChatList({ projectId }: ProjectChatListProps): React.JSX.Element {
  const sessionIndex = useAcpStore((s) => s.sessionIndex)
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const deleteHistorySession = useAcpStore((s) => s.deleteHistorySession)
  const addAgentChatTab = useWorkspaceStore((s) => s.addAgentChatTab)
  const activeChatSessionId = useActiveChatSessionId()
  const live = useChatLiveSessionIds()
  const liveStateFor = useCallback(
    (id: string): ProjectChatLiveState =>
      live.running.includes(id) ? 'running' : live.needsYou.includes(id) ? 'needs-you' : 'idle',
    [live.running, live.needsYou]
  )

  // Scope by projectId only (all of the project's chats, regardless of cwd),
  // Termul-created sessions only (discovered !== true), newest-first.
  const entries = useMemo<ProjectChatEntry[]>(
    () =>
      sessionIndex
        .filter((e) => e.projectId === projectId && e.discovered !== true)
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
          cwd: e.cwd,
          canOpen: true
        }))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    [sessionIndex, projectId]
  )

  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Filter the FULL set by query first (so search reaches every session, not
  // just the rendered window).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q.length === 0 ? entries : entries.filter((e) => e.title.toLowerCase().includes(q))
  }, [entries, query])

  // Reset the visible window when the query or project scope changes so a
  // stale "No matches"/window never renders against the new scope.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on scope/query change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [query, projectId])

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const hasMore = filtered.length > visible.length

  // Grow the window when the bottom sentinel scrolls into view (lazy load).
  // `visibleCount` is intentionally in the deps so the observer re-arms after
  // each growth: IntersectionObserver only fires on intersection transitions,
  // so a sentinel already in view after a grow needs a fresh observe() to
  // re-check. A "Load more" button mirrors the same growth for pointer/touch
  // and for test environments where the observer is a no-op.
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount re-arms the observer
  useEffect(() => {
    if (!hasMore) return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (obsEntries) => {
        if (obsEntries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => c + PAGE_SIZE)
        }
      },
      { root: scrollRef.current, rootMargin: '200px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, visibleCount])

  // Delete is irreversible — route it through a confirmation dialog (mirrors
  // the project/group delete pattern) instead of deleting on the first click.
  const [deleteConfirm, setDeleteConfirm] = useState<ProjectChatEntry | null>(null)

  const handleOpen = useCallback(
    (entry: ProjectChatEntry) => {
      try {
        const opening = openHistorySession(entry.id)
        addAgentChatTab(entry.id)
        void opening.catch(() => {
          toast.error('Could not open that chat. Try again.')
        })
      } catch {
        toast.error('Could not open that chat. Try again.')
      }
    },
    [addAgentChatTab, openHistorySession]
  )

  const handleDelete = useCallback(
    (id: string) => {
      void deleteHistorySession(id).catch(() => {
        toast.error('Could not delete that chat. Try again.')
      })
    },
    [deleteHistorySession]
  )

  const handleOpenTerminal = useCallback(
    async (entry: ProjectChatEntry) => {
      if (!entry.cwd) return
      const outcome = await openTerminalAtCwd(projectId, entry.cwd)
      if (outcome.status === 'opened') {
        toast.success('Terminal opened', { description: `Opened at ${entry.cwd}` })
      } else if (outcome.status === 'no-pane') {
        toast.error('No active pane', {
          description: 'Cannot open terminal without an active workspace pane.'
        })
      } else {
        toast.error('Failed to open terminal', {
          description: outcome.error || 'Could not create a terminal.'
        })
      }
    },
    [projectId]
  )

  const handleCopyPath = useCallback(async (cwd: string) => {
    try {
      const result = await clipboardApi.writeText(cwd)
      if (result.success) {
        toast.success('Path copied', { description: cwd })
      } else {
        toast.error('Failed to copy path', { description: 'Could not copy to clipboard' })
      }
    } catch {
      toast.error('Failed to copy path', { description: 'Could not copy to clipboard' })
    }
  }, [])

  const handleOpenInFileExplorer = useCallback(
    async (cwd: string) => {
      const result = await openerApi.revealInFileManager(cwd)
      if (!result.success) {
        // Fallback: copy the path so the user can still reach it.
        await handleCopyPath(cwd)
      }
    },
    [handleCopyPath]
  )

  return (
    <div className="relative ml-5 flex flex-col">
      {/* Tree rail: 1px line that ties the chats to their project row. */}
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-px bg-border" />
      {/* Per-project chat search — scoped to this project's chats only. */}
      <div className="pl-1 pr-2 py-1">
        <SidebarSearchField
          size="sm"
          value={query}
          onChange={setQuery}
          placeholder="Search chats…"
          ariaLabel="Search chats"
          clearLabel="Clear chat search"
        />
      </div>

      {/*
        Bounded max-height so a long history scrolls internally and never
        pushes the next project off-screen. Fits ~10 rows; lazy pagination
        keeps the rendered count capped at PAGE_SIZE until the sentinel loads
        the next page.
      */}
      <div ref={scrollRef} className="flex max-h-80 flex-col gap-0.5 overflow-y-auto pl-1 pr-0.5">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-4 text-center text-xs text-muted-foreground opacity-70">
            No chats yet. Start one with the New chat button.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">No matches.</div>
        ) : (
          visible.map((entry) => (
            <ProjectChatRow
              key={entry.id}
              entry={entry}
              isActive={entry.id === activeChatSessionId}
              liveState={liveStateFor(entry.id)}
              onOpen={handleOpen}
              onOpenTerminal={handleOpenTerminal}
              onOpenInFileExplorer={handleOpenInFileExplorer}
              onCopyPath={handleCopyPath}
              onDelete={setDeleteConfirm}
            />
          ))
        )}
        {hasMore && (
          <div ref={sentinelRef} className="px-3 py-2">
            <button
              type="button"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="w-full rounded-md py-1 text-3xs tabular-nums text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03]"
            >
              Load more ({filtered.length - visible.length} more)
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={deleteConfirm !== null}
        title="Delete chat"
        message={
          deleteConfirm ? `Delete “${deleteConfirm.title}”? This action cannot be undone.` : ''
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          if (deleteConfirm) {
            const id = deleteConfirm.id
            setDeleteConfirm(null)
            handleDelete(id)
          }
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  )
}
