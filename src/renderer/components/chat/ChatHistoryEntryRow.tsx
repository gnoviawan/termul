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
  const dimmed = entry.status === 'closed' || (entry.discovered && !entry.canOpen)
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-2 pr-2 hover:bg-sidebar-accent',
        dimmed && 'text-disabled-foreground'
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
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs disabled:cursor-not-allowed @[400px]:min-h-10"
      >
        <ChatEntryIcon agentId={entry.agentId} agentConfigId={entry.agentConfigId} />
        <span
          className={cn(
            'flex-1 truncate',
            dimmed ? 'text-disabled-foreground' : 'text-sidebar-foreground'
          )}
        >
          {entry.title}
        </span>
        {entry.status === 'error' && (
          <span className="shrink-0 rounded-sm bg-destructive/15 px-1 py-px text-3xs font-medium text-destructive">
            Failed
          </span>
        )}
        {entry.discovered ? (
          entry.agentName ? (
            <span className="text-2xs text-muted-foreground shrink-0">{entry.agentName}</span>
          ) : null
        ) : (
          <span
            className={cn(
              'shrink-0 text-2xs tabular-nums',
              dimmed ? 'text-disabled-foreground' : 'text-muted-foreground'
            )}
          >
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
            'relative inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground @[400px]:size-10',
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
