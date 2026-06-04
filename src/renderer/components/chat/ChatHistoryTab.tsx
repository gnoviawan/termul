import { MessageSquare, Search, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { groupSessionsByRecency } from '@/lib/acp-history-persistence'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

/** Sidebar tab listing persisted chat sessions, grouped by recency with search. */
export function ChatHistoryTab(): React.JSX.Element {
  const sessionIndex = useAcpStore((s) => s.sessionIndex)
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const deleteHistorySession = useAcpStore((s) => s.deleteHistorySession)
  const addAgentChatTab = useWorkspaceStore((s) => s.addAgentChatTab)

  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const filtered =
      query.trim().length === 0
        ? sessionIndex
        : sessionIndex.filter((e) => e.title.toLowerCase().includes(query.trim().toLowerCase()))
    return groupSessionsByRecency(filtered, Date.now())
  }, [sessionIndex, query])

  const handleOpen = useCallback(
    async (id: string) => {
      // Open the session first; only add the tab if it succeeds, so a failed
      // load doesn't leave a dead tab behind.
      try {
        await openHistorySession(id)
        addAgentChatTab(id)
      } catch (err) {
        toast.error(`Failed to open chat: ${String(err)}`)
      }
    },
    [addAgentChatTab, openHistorySession]
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
        {sessionIndex.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-center text-xs text-muted-foreground opacity-70">
            No chats yet. Start one with the New Chat button.
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">No matches.</div>
        ) : (
          groups.map(({ group, entries }) => (
            <div key={group}>
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                {group}
              </div>
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    'group flex w-full items-center gap-2 pr-2 hover:bg-sidebar-accent',
                    entry.status === 'closed' && 'opacity-70'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void handleOpen(entry.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs"
                  >
                    <MessageSquare size={12} className="shrink-0 text-muted-foreground" />
                    <span className="truncate flex-1 text-sidebar-foreground">{entry.title}</span>
                    <span className="text-[10px] text-muted-foreground">{entry.messageCount}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete chat"
                    title="Delete chat"
                    onClick={() => handleDelete(entry.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background/50"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
