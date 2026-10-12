import { ChatEntryIcon } from '@/components/chat/ChatHistoryEntryRow'
import { Columns2, Copy, FolderOpen, GitBranch, Terminal, Trash2 } from '@/components/icons'
import {
  ChatRowTrail,
  type ProjectChatEntry,
  type ProjectChatLiveState
} from '@/components/sidebar/project-chat-row'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAgentChatStatusSignals } from '@/components/workspace/tabs/agent-chat-status'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { cn } from '@/lib/utils'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { findPaneById, useWorkspaceStore } from '@/stores/workspace-store'
import { type ChatCardData, modelLineOf } from './chat-cards'
import type { ChatCardActions } from './use-chat-card-actions'

const STATUS_WORD: Record<ProjectChatLiveState, string | null> = {
  'needs-you': 'Needs you',
  running: 'Running',
  done: 'New activity',
  idle: null
}

export interface ChatCardProps {
  card: ChatCardData
  /** Position in the filtered list; keyboard navigation and virtual measuring key on it. */
  index: number
  isActive: boolean
  actions: Omit<ChatCardActions, 'onDelete'>
  onRequestDelete: (entry: ProjectChatEntry) => void
}

/**
 * One chat in the Side panel Chats list: agent icon, model and the single
 * status slot on line 1, the title on line 2, the branch on line 3. The status
 * comes from the same signals and unread store as the chat tab, so the two
 * always agree.
 */
export function ChatCard({
  card,
  index,
  isActive,
  actions,
  onRequestDelete
}: ChatCardProps): React.JSX.Element {
  const { entry, branch } = card
  const { startChatDrag } = usePaneDnd()
  const signals = useAgentChatStatusSignals(entry.id)
  const unread = useAgentChatUnreadStore((s) => Boolean(s.unread[entry.id]))
  // A pane's only tab cannot be split off that same pane, so the menu item
  // would do nothing: disable it and say why.
  const soleTabOfActivePane = useWorkspaceStore((s) => {
    const pane = findPaneById(s.root, s.activePaneId)
    if (pane?.type !== 'leaf' || pane.tabs.length !== 1) return false
    const only = pane.tabs[0]
    return only?.type === 'agent-chat' && only.sessionId === entry.id
  })

  const liveState: ProjectChatLiveState = signals.needsAttention
    ? 'needs-you'
    : signals.turnBusy
      ? 'running'
      : signals.liveSession && unread
        ? 'done'
        : 'idle'
  const statusWord = STATUS_WORD[liveState]

  const liveModels = signals.session?.models
  const liveModel = liveModels
    ? (liveModels.availableModels.find((m) => m.modelId === liveModels.currentModelId)?.name ??
      liveModels.currentModelId)
    : null
  const modelLine = liveModel || modelLineOf(card)

  const hasCwd = Boolean(entry.cwd)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          draggable
          onDragStart={(e) => startChatDrag(entry.id, e)}
          className={cn(
            'group relative flex w-full items-center rounded-md pr-1 transition-colors duration-150 ease-out',
            isActive ? 'bg-foreground/[0.05]' : 'hover:bg-foreground/[0.03]',
            entry.status === 'closed' && 'opacity-60'
          )}
          data-active={isActive ? 'true' : undefined}
        >
          {isActive && (
            <span
              aria-hidden="true"
              data-testid="chat-card-active-marker"
              className="absolute -left-1.25 top-1/2 h-4 w-0.75 -translate-y-1/2 rounded-full bg-foreground"
            />
          )}
          <button
            type="button"
            data-chat-card-index={index}
            onClick={() => actions.onOpen(entry)}
            title={entry.title}
            aria-label={statusWord ? `${entry.title}, ${statusWord}` : entry.title}
            aria-current={isActive ? 'true' : undefined}
            className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md py-1.5 pl-2.5 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
              <ChatEntryIcon
                agentId={entry.agentId}
                agentConfigId={entry.agentConfigId}
                agents={entry.agents}
              />
              <span className="min-w-0 flex-1 truncate">{modelLine}</span>
              {entry.status === 'error' && (
                <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 text-3xs text-destructive">
                  Failed
                </span>
              )}
              <ChatRowTrail liveState={liveState} lastActivityAt={entry.lastActivityAt} />
            </span>
            <span className="truncate text-xs font-medium text-foreground">{entry.title}</span>
            <span className="flex min-h-4 min-w-0 items-center gap-1 text-2xs text-muted-foreground">
              {branch !== '' && <GitBranch size={12} aria-hidden="true" className="shrink-0" />}
              <span className="min-w-0 truncate">{branch}</span>
            </span>
          </button>
          <button
            type="button"
            aria-label={`Open terminal for chat ${entry.title}`}
            title={hasCwd ? `Open terminal at ${entry.cwd}` : 'No working directory for this chat'}
            disabled={!hasCwd}
            onClick={(e) => {
              e.stopPropagation()
              void actions.onOpenTerminal(entry)
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className={cn(
              'relative inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground',
              "after:absolute after:-inset-1.5 after:content-['']",
              'transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100',
              !hasCwd && 'cursor-not-allowed'
            )}
          >
            <Terminal size={12} aria-hidden="true" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem
          disabled={soleTabOfActivePane}
          onSelect={() => actions.onOpenInSplit(entry)}
        >
          <Columns2 className="mr-2 h-4 w-4" /> Open in split
          {soleTabOfActivePane && (
            <span className="sr-only"> (unavailable: this is the only tab in the active pane)</span>
          )}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasCwd} onSelect={() => void actions.onOpenTerminal(entry)}>
          <Terminal className="mr-2 h-4 w-4" /> Open Terminal Here
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasCwd}
          onSelect={() => {
            if (entry.cwd) void actions.onOpenInFileExplorer(entry.cwd)
          }}
        >
          <FolderOpen className="mr-2 h-4 w-4" /> Open in File Explorer
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasCwd}
          onSelect={() => {
            if (entry.cwd) void actions.onCopyPath(entry.cwd)
          }}
        >
          <Copy className="mr-2 h-4 w-4" /> Copy Path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onRequestDelete(entry)}>
          <Trash2 className="mr-2 h-4 w-4" /> Delete Chat
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
