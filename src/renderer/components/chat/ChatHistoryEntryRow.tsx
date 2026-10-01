import { useMemo } from 'react'
import { Trash2 } from '@/components/icons'
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
  /**
   * Ordered agent-config ids this conversation ran with (story 5 /
   * spec-in-chat-agent-switch CAP-8): first = original, last = current.
   * Pass-through of `SessionIndexEntry.agents` (story 3's additive cache);
   * absent — or fewer than 2 distinct ids — on unswitched chats, which keep
   * the single `agentConfigId` icon exactly as before.
   */
  agents?: string[]
  cwd?: string
  lastActivityAt: number
  canOpen: boolean
}

/**
 * Maximum icons rendered in the multi-agent sequence before the `+N` collapse.
 * Beyond the cap, the leading (original) and trailing (current) icons render
 * with a `+N` count for the collapsed middle — 3 keeps a multi-switch chain
 * inside the existing 11-min-height row (spec Design Notes).
 */
const AGENTS_SEQUENCE_CAP = 3

/**
 * Resolve one agent-config id's icon through the AgentGlyph chokepoint
 * (`icon` → `acp:<templateId>` → Bot fallback). A fixed-count child (one
 * instance per rendered id) so the per-config `useAgentTemplateId` /
 * `useAgentIcon` hook pair stays statically countable (spec Design Notes).
 */
function ChatEntryAgentIcon({ agentConfigId }: { agentConfigId: string }): React.JSX.Element {
  const templateId = useAgentTemplateId(null, agentConfigId)
  const icon = useAgentIcon(null, agentConfigId)
  return (
    <AgentGlyph templateId={templateId} icon={icon} size={12} className="text-muted-foreground" />
  )
}

/** Ordered config ids to render: the capped window keeping first + last. */
function cappedAgentSequence(agents: readonly string[]): { ids: string[]; overflow: number } {
  // Defensive consecutive dedup: story 3's cache is consecutive-deduped when
  // written, but an older/hand-edited index entry is not worth crashing over.
  const distinct: string[] = []
  for (const id of agents) {
    if (distinct[distinct.length - 1] !== id) distinct.push(id)
  }
  if (distinct.length <= AGENTS_SEQUENCE_CAP) return { ids: distinct, overflow: 0 }
  // Overflow: keep the leading (original) and trailing (current) icons,
  // collapse the middle into the `+N` count.
  const ids = [distinct[0], ...distinct.slice(-(AGENTS_SEQUENCE_CAP - 1))]
  return { ids, overflow: distinct.length - AGENTS_SEQUENCE_CAP }
}

/**
 * The multi-agent icon sequence (original → current) for a switched chat.
 * Pure presentation over the capped id window; per-id resolution lives in
 * `ChatEntryAgentIcon` (one fixed hook pair per rendered icon).
 */
function ChatEntryAgentsIcon({
  ids,
  overflow
}: {
  ids: readonly string[]
  overflow: number
}): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1"
      role="img"
      aria-label={`Conversation agents, ${ids.length + overflow} total`}
      title={`Conversation ran with ${ids.length + overflow} agents`}
    >
      {/* The leading (original) icon, then the collapsed middle as +N, then
          the trailing (current) icons — the collapsed count sits between
          them per the "collapse the middle" design. */}
      {ids.length > 0 && <ChatEntryAgentIcon key={`${ids[0]}-0`} agentConfigId={ids[0]} />}
      {overflow > 0 && (
        <span className="text-3xs leading-none text-muted-foreground">+{overflow}</span>
      )}
      {ids.slice(1).map((configId, index) => (
        // Index-keyed (offset by the leading icon): a switch-back chain
        // (a → b → a) legitimately repeats a config id — the sequence MEANING
        // is the ordered chain, so the id alone is not unique. Per-agent
        // config resolution lives inside ChatEntryAgentIcon, so a remount
        // re-resolves identically.
        <ChatEntryAgentIcon key={`${configId}-${index + 1}`} agentConfigId={configId} />
      ))}
    </span>
  )
}

/** One agent icon resolved by `agentId`/`agentConfigId` (the pre-story-5 slot). */
function ChatEntrySingleIcon({
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

/**
 * The row's icon slot: the ordered agent sequence when the entry carries a
 * multi-entry `agents` cache (story 3), otherwise exactly today's single
 * agent icon (byte-identical DOM for unswitched rows). Hook-free dispatcher
 * — hooks live in the two child components so their call order is static.
 */
export function ChatEntryIcon({
  agentId,
  agentConfigId,
  agents
}: {
  agentId?: string
  agentConfigId?: string
  agents?: string[]
}): React.JSX.Element {
  // The sidebar re-renders every row on each sessionIndex flush; memoize the
  // capped window so cappedAgentSequence's allocations are not re-created.
  const sequence = useMemo(() => (agents ? cappedAgentSequence(agents) : null), [agents])
  if (sequence && sequence.ids.length >= 2) {
    return <ChatEntryAgentsIcon ids={sequence.ids} overflow={sequence.overflow} />
  }
  return <ChatEntrySingleIcon agentId={agentId} agentConfigId={agentConfigId} />
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
        <ChatEntryIcon
          agentId={entry.agentId}
          agentConfigId={entry.agentConfigId}
          agents={entry.agents}
        />
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
