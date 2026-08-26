import { Copy, FolderOpen, Search, Terminal, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { AgentGlyph } from '@/components/chat/AgentGlyph'
import type { ChatHistorySidebarEntry } from '@/components/chat/ChatHistoryEntryRow'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { clipboardApi, openerApi } from '@/lib/api'
import { formatRelativeTimeFromMs } from '@/lib/git-time'
import { openTerminalAtCwd } from '@/lib/terminal-spawn'
import { cn } from '@/lib/utils'
import { useAcpStore, useAgentIcon, useAgentTemplateId } from '@/stores/acp-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

/** Hard cap of rendered chat rows per project before lazy pagination kicks in. */
const PAGE_SIZE = 10

type ProjectChatEntry = ChatHistorySidebarEntry

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
    <div className="flex flex-col">
      {/* Per-project chat search — scoped to this project's chats only. */}
      <div className="px-2 py-1">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Search chats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                e.stopPropagation()
                setQuery('')
              }
            }}
            className="w-full rounded-none border-0 bg-transparent py-1 pl-7 pr-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:ring-0 [&::-webkit-search-cancel-button]:hidden"
            aria-label="Search chats"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-0 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
              title="Clear search"
              aria-label="Clear chat search"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/*
        Bounded max-height so a long history scrolls internally and never
        pushes the next project off-screen. Fits ~10 rows; lazy pagination
        keeps the rendered count capped at PAGE_SIZE until the sentinel loads
        the next page.
      */}
      <div ref={scrollRef} className="overflow-y-auto max-h-80">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-4 text-center text-xs text-muted-foreground opacity-70">
            No chats yet. Start one with the New Chat button.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">No matches.</div>
        ) : (
          visible.map((entry) => (
            <ProjectChatRow
              key={entry.id}
              entry={entry}
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
              className="w-full rounded-md py-1 text-3xs text-muted-foreground hover:bg-sidebar-accent"
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

interface ProjectChatRowProps {
  entry: ProjectChatEntry
  onOpen: (entry: ProjectChatEntry) => void
  onOpenTerminal: (entry: ProjectChatEntry) => void
  onOpenInFileExplorer: (cwd: string) => void
  onCopyPath: (cwd: string) => void
  onDelete: (entry: ProjectChatEntry) => void
}

function ProjectChatRow({
  entry,
  onOpen,
  onOpenTerminal,
  onOpenInFileExplorer,
  onCopyPath,
  onDelete
}: ProjectChatRowProps): React.JSX.Element {
  const hasCwd = Boolean(entry.cwd)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group flex w-full items-center pr-2 hover:bg-sidebar-accent',
            entry.status === 'closed' && 'opacity-70'
          )}
        >
          <button
            type="button"
            onClick={() => onOpen(entry)}
            title={entry.title}
            className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs"
          >
            <ChatRowIcon agentId={entry.agentId} agentConfigId={entry.agentConfigId} />
            <span className="truncate flex-1 text-sidebar-foreground">{entry.title}</span>
            <span className="text-3xs text-muted-foreground">
              {formatRelativeTimeFromMs(entry.lastActivityAt)}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Open terminal for chat ${entry.title}`}
            title={hasCwd ? `Open terminal at ${entry.cwd}` : 'No working directory for this chat'}
            disabled={!hasCwd}
            onClick={(e) => {
              e.stopPropagation()
              onOpenTerminal(entry)
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className={cn(
              'relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground',
              "after:absolute after:-inset-1.5 after:content-['']",
              'transition-colors hover:bg-sidebar-accent hover:text-foreground',
              'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100',
              !hasCwd && 'cursor-not-allowed'
            )}
          >
            <Terminal size={12} aria-hidden="true" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem disabled={!hasCwd} onSelect={() => void onOpenTerminal(entry)}>
          <Terminal className="mr-2 h-4 w-4" /> Open Terminal Here
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasCwd}
          onSelect={() => {
            if (entry.cwd) void onOpenInFileExplorer(entry.cwd)
          }}
        >
          <FolderOpen className="mr-2 h-4 w-4" /> Open in File Explorer
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasCwd}
          onSelect={() => {
            if (entry.cwd) void onCopyPath(entry.cwd)
          }}
        >
          <Copy className="mr-2 h-4 w-4" /> Copy Path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(entry)}>
          <Trash2 className="mr-2 h-4 w-4" /> Delete Chat
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Resolve the agent's bundled registry icon for a history entry. */
function ChatRowIcon({
  agentId,
  agentConfigId
}: {
  agentId?: string
  agentConfigId?: string
}): React.JSX.Element {
  const templateId = useAgentTemplateId(agentId ?? null, agentConfigId)
  const icon = useAgentIcon(agentId ?? null, agentConfigId)
  return (
    <AgentGlyph templateId={templateId} icon={icon} size={12} className="text-muted-foreground" />
  )
}
