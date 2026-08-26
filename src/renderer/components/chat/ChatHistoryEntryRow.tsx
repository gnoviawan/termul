import { Trash2 } from 'lucide-react'
import { formatRelativeTimeFromMs } from '@/lib/git-time'
import { cn } from '@/lib/utils'
import { useAgentIcon, useAgentTemplateId } from '@/stores/acp-store'
import { AgentGlyph } from './AgentGlyph'

export interface ChatHistorySidebarEntry {
  id: string
  title: string
  messageCount: number
  status: string
  discovered: boolean
  agentId?: string
  agentConfigId?: string
  agentName?: string | null
  cwd?: string
  lastActivityAt: number
  canOpen: boolean
}

/** Resolve the agent's bundled registry icon for a history/discovered entry. */
function ChatEntryIcon({
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

interface ChatHistoryEntryRowProps {
  entry: ChatHistorySidebarEntry
  onOpen: (entry: ChatHistorySidebarEntry) => void
  onDelete: (id: string) => void
}
/**
 * A single chat-history row for the sidebar `ChatHistoryTab`: agent icon, title,
 * and a compact relative last-activity time (replacing the old message count).
 */
export function ChatHistoryEntryRow({
  entry,
  onOpen,
  onDelete
}: ChatHistoryEntryRowProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-2 pr-2 hover:bg-sidebar-accent',
        entry.status === 'closed' && 'opacity-70',
        entry.discovered && !entry.canOpen && 'opacity-50'
      )}
    >
      <button
        type="button"
        disabled={entry.discovered && !entry.canOpen}
        onClick={() => onOpen(entry)}
        title={
          entry.discovered && !entry.canOpen
            ? 'Agent does not support loading or resuming sessions'
            : entry.discovered && entry.agentName
              ? `${entry.title} — ${entry.agentName} (resume from CLI history)`
              : entry.title
        }
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs disabled:cursor-not-allowed"
      >
        <ChatEntryIcon agentId={entry.agentId} agentConfigId={entry.agentConfigId} />
        <span className="truncate flex-1 text-sidebar-foreground">{entry.title}</span>
        {entry.discovered ? (
          entry.agentName ? (
            <span className="text-3xs text-muted-foreground/70 shrink-0">{entry.agentName}</span>
          ) : null
        ) : (
          <span className="text-3xs text-muted-foreground">
            {formatRelativeTimeFromMs(entry.lastActivityAt)}
          </span>
        )}
      </button>
      {!entry.discovered && (
        <button
          type="button"
          aria-label="Delete chat"
          title="Delete chat"
          onClick={() => onDelete(entry.id)}
          className={cn(
            'relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground',
            // 32px visual + 6px each side → 44×44 hit (match AttachFilesButton).
            "after:absolute after:-inset-1.5 after:content-['']",
            'opacity-100 transition-colors hover:bg-background/50 hover:text-foreground',
            'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100'
          )}
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  )
}
