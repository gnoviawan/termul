import { Bot, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { groupSessionsByRecency } from '@/lib/acp-history-persistence'
import { cn } from '@/lib/utils'
import { configIdFromReuseKey, useAcpStore } from '@/stores/acp-store'
import { getActiveWorktreeFromStore, useActiveProject } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { templateIcon } from './agent-templates'

/** A unified sidebar entry: either from the local mirror or discovered via session/list. */
interface SidebarEntry {
  /** Session id (same as sessionId for discovered entries). */
  id: string
  title: string
  messageCount: number
  status: string
  /** Template icon component for this entry's agent, if resolvable. */
  icon?: ReturnType<typeof templateIcon>
  /** True when this entry comes from agent discovery (not the local mirror). */
  discovered: boolean
  /** Agent id for discovered entries (used to open via load/resume). */
  agentId?: string
  /** Owning agent display name (e.g. "Codex CLI"), for discovered entries. */
  agentName?: string | null
  /** Cwd for discovered entries (used to open via load/resume). */
  cwd?: string
  /** Last activity timestamp (for grouping). */
  lastActivityAt: number
  /** Whether this entry can be opened (agent has load or resume capability). */
  canOpen: boolean
}

/**
 * Normalize a filesystem path for comparison: forward slashes, no trailing
 * slash, lowercased (Windows paths are case-insensitive; on POSIX this is a
 * harmless over-match for the rare mixed-case duplicate).
 */
function normalizeCwd(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** True when two cwd strings refer to the same directory after normalization. */
function cwdMatches(a: string, b: string): boolean {
  return normalizeCwd(a) === normalizeCwd(b)
}

/** Sidebar tab listing persisted + discovered chat sessions, grouped by recency with search. */
export function ChatHistoryTab(): React.JSX.Element {
  const sessionIndex = useAcpStore((s) => s.sessionIndex)
  const discoveredSessions = useAcpStore((s) => s.discoveredSessions)
  const agents = useAcpStore((s) => s.agents)
  const agentStatus = useAcpStore((s) => s.agentStatus)
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const configToLiveAgent = useAcpStore((s) => s.configToLiveAgent)
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const openDiscoveredSession = useAcpStore((s) => s.openDiscoveredSession)
  const discoverSessions = useAcpStore((s) => s.discoverSessions)
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

  // Helper: resolve display name + templateId for an agentId via the
  // configToLiveAgent + agentConfigs mapping (same path as useAgentIdentity).
  const resolveAgentIdentity = useCallback(
    (agentId: string): { name: string | null; templateId: string | null } => {
      const reuseKey = Object.keys(configToLiveAgent).find((k) => configToLiveAgent[k] === agentId)
      const configId = reuseKey ? configIdFromReuseKey(reuseKey) : undefined
      const config = configId ? agentConfigs.find((c) => c.id === configId) : undefined
      return { name: config?.name ?? null, templateId: config?.templateId ?? null }
    },
    [configToLiveAgent, agentConfigs]
  )

  // Trigger discovery for all connected agents with `list` capability when
  // the active cwd changes or agents come online.
  const agentIds = useMemo(() => Object.keys(agents), [agents])
  useEffect(() => {
    if (!activeCwd) return
    for (const agentId of agentIds) {
      const caps = agents[agentId]?.capabilities
      if (caps?.sessionCapabilities?.list) {
        void discoverSessions(agentId, activeCwd)
      }
    }
  }, [activeCwd, agentIds, agents, discoverSessions])

  // Hard isolation (ADR 0002): show only sessions whose `(projectId, cwd)`
  // match the active project + its current worktree/root.
  const scopedIndex = useMemo(() => {
    if (!activeProjectId || !activeCwd) return []
    return sessionIndex.filter((e) => e.projectId === activeProjectId && e.cwd === activeCwd)
  }, [sessionIndex, activeProjectId, activeCwd])

  // Build a unified sidebar list: local mirror + discovered sessions (deduped).
  const mergedEntries = useMemo(() => {
    const mirrorIds = new Set(scopedIndex.map((e) => e.id))
    const entries: SidebarEntry[] = scopedIndex.map((e) => {
      const { templateId } = resolveAgentIdentity(e.agentId)
      const icon = templateIcon(templateId ?? undefined)
      return {
        id: e.id,
        title: e.title,
        messageCount: e.messageCount,
        status: e.status,
        icon,
        discovered: false,
        lastActivityAt: e.lastActivityAt,
        canOpen: true
      }
    })

    // Add discovered sessions not already in the local mirror.
    for (const [agentId, sessions] of Object.entries(discoveredSessions)) {
      // Only surface discovered sessions for an agent that is still connected.
      // A disconnected agent can't service session/load|resume, so its entries
      // would render as un-clickable; drop them instead of showing dead rows.
      if (agentStatus[agentId] !== 'connected') continue
      const caps = agents[agentId]?.capabilities
      const canOpen = caps?.loadSession === true || caps?.sessionCapabilities?.resume != null
      const { name: agentName, templateId } = resolveAgentIdentity(agentId)
      const icon = templateIcon(templateId ?? undefined)

      for (const info of sessions) {
        // Dedupe: skip if already in the local mirror.
        if (mirrorIds.has(info.sessionId)) continue
        // Filter by active cwd. The backend already passes cwd to session/list,
        // so this is a defensive secondary filter for agents that ignore it.
        // Compare normalized (separators + case + trailing slash) so a Windows
        // path mismatch (E:\foo vs E:/foo/) can't wrongly hide a session.
        if (activeCwd && info.cwd && !cwdMatches(info.cwd, activeCwd)) continue

        entries.push({
          id: info.sessionId,
          title: info.title || `Session ${info.sessionId.slice(0, 8)}`,
          messageCount: 0,
          status: 'active',
          icon,
          discovered: true,
          agentId,
          agentName,
          cwd: info.cwd || activeCwd,
          lastActivityAt: info.updatedAt ? Date.parse(info.updatedAt) || Date.now() : Date.now(),
          canOpen
        })
      }
    }

    return entries
  }, [scopedIndex, discoveredSessions, agents, agentStatus, activeCwd, resolveAgentIdentity])

  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const filtered =
      query.trim().length === 0
        ? mergedEntries
        : mergedEntries.filter((e) => e.title.toLowerCase().includes(query.trim().toLowerCase()))
    return groupSessionsByRecency(filtered, Date.now())
  }, [mergedEntries, query])

  const handleOpen = useCallback(
    async (entry: SidebarEntry) => {
      try {
        if (entry.discovered && entry.agentId && entry.cwd) {
          await openDiscoveredSession(entry.agentId, entry.id, entry.cwd, activeProjectId)
        } else {
          await openHistorySession(entry.id)
        }
        addAgentChatTab(entry.id)
      } catch (err) {
        toast.error(`Failed to open chat: ${String(err)}`)
      }
    },
    [addAgentChatTab, openHistorySession, openDiscoveredSession, activeProjectId]
  )

  const handleDelete = useCallback(
    (id: string) => {
      void deleteHistorySession(id).catch((err) => {
        toast.error(`Failed to delete chat: ${String(err)}`)
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

      <div className="flex-1 overflow-y-auto py-1">
        {mergedEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-center text-xs text-muted-foreground opacity-70">
            No chats yet. Start one with the New Chat button.
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">No matches.</div>
        ) : (
          groups.map(({ group, entries }) => (
            <div key={group}>
              <div className="label-group px-3 py-1 text-muted-foreground/70">{group}</div>
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    'group flex w-full items-center gap-2 pr-2 hover:bg-sidebar-accent',
                    entry.status === 'closed' && 'opacity-70',
                    entry.discovered && !entry.canOpen && 'opacity-50'
                  )}
                >
                  <button
                    type="button"
                    disabled={entry.discovered && !entry.canOpen}
                    onClick={() => void handleOpen(entry)}
                    title={
                      entry.discovered && !entry.canOpen
                        ? 'Agent does not support loading or resuming sessions'
                        : entry.discovered && entry.agentName
                          ? `${entry.title} — ${entry.agentName} (resume from CLI history)`
                          : entry.title
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs disabled:cursor-not-allowed"
                  >
                    {entry.icon ? (
                      <entry.icon
                        width={12}
                        height={12}
                        className="shrink-0 text-muted-foreground"
                      />
                    ) : (
                      <Bot size={12} className="shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate flex-1 text-sidebar-foreground">{entry.title}</span>
                    {entry.discovered ? (
                      entry.agentName ? (
                        <span className="text-3xs text-muted-foreground/70 shrink-0">
                          {entry.agentName}
                        </span>
                      ) : null
                    ) : (
                      <span className="text-3xs text-muted-foreground">{entry.messageCount}</span>
                    )}
                  </button>
                  {!entry.discovered && (
                    <button
                      type="button"
                      aria-label="Delete chat"
                      title="Delete chat"
                      onClick={() => handleDelete(entry.id)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded-md hover:bg-background/50"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
