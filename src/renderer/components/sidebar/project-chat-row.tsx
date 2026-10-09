import { ChatEntryIcon, type ChatHistorySidebarEntry } from '@/components/chat/ChatHistoryEntryRow'
import { Copy, FolderOpen, Terminal, Trash2 } from '@/components/icons'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Spinner } from '@/components/ui/spinner'
import { formatRelativeTimeFromMs } from '@/lib/git-time'
import { cn } from '@/lib/utils'

export type ProjectChatEntry = ChatHistorySidebarEntry

/** Live state of one chat row: a turn is in progress, the chat waits on you, or neither. */
export type ProjectChatLiveState = 'running' | 'needs-you' | 'idle'

export interface ProjectChatRowProps {
  entry: ProjectChatEntry
  isActive: boolean
  liveState: ProjectChatLiveState
  onOpen: (entry: ProjectChatEntry) => void
  onOpenTerminal: (entry: ProjectChatEntry) => Promise<void>
  onOpenInFileExplorer: (cwd: string) => Promise<void>
  onCopyPath: (cwd: string) => Promise<void>
  onDelete: (entry: ProjectChatEntry) => void
}

/** Right slot of a chat row: running spinner, needs-you, or relative last-activity time. */
function ChatRowTrail({
  liveState,
  lastActivityAt
}: {
  liveState: ProjectChatLiveState
  lastActivityAt: number
}): React.JSX.Element {
  switch (liveState) {
    case 'running':
      return (
        <span className="flex shrink-0 items-center text-primary">
          <Spinner size={12} label="Running" />
        </span>
      )
    case 'needs-you':
      return (
        <span className="flex shrink-0 items-center gap-1 text-3xs font-medium text-warning">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          Needs you
        </span>
      )
    case 'idle':
      return (
        <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
          {formatRelativeTimeFromMs(lastActivityAt)}
        </span>
      )
  }
}

/**
 * A single per-project chat row: agent icon, title, and a right slot
 * (running spinner, needs-you, or relative last-activity time), with a
 * context menu (open terminal / file explorer / copy path / delete).
 */
export function ProjectChatRow({
  entry,
  isActive,
  liveState,
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
            'group relative flex h-7 w-full items-center rounded-md pr-1 text-xs transition-colors duration-150 ease-out',
            isActive ? 'bg-foreground/[0.05] text-foreground' : 'hover:bg-foreground/[0.03]',
            entry.status === 'closed' && 'opacity-60'
          )}
          data-active={isActive ? 'true' : undefined}
        >
          {isActive && (
            <span
              aria-hidden="true"
              data-testid="project-chat-active-marker"
              className="absolute -left-1.25 top-1/2 h-4 w-0.75 -translate-y-1/2 rounded-full bg-foreground"
            />
          )}
          <button
            type="button"
            onClick={() => onOpen(entry)}
            title={entry.title}
            aria-current={isActive ? 'true' : undefined}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2.5 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChatEntryIcon
              agentId={entry.agentId}
              agentConfigId={entry.agentConfigId}
              agents={entry.agents}
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate transition-colors duration-150 ease-out',
                isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
              )}
            >
              {entry.title}
            </span>
            {entry.status === 'error' && (
              <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 text-3xs text-destructive">
                Failed
              </span>
            )}
            <ChatRowTrail liveState={liveState} lastActivityAt={entry.lastActivityAt} />
          </button>
          <button
            type="button"
            aria-label={`Open terminal for chat ${entry.title}`}
            title={hasCwd ? `Open terminal at ${entry.cwd}` : 'No working directory for this chat'}
            disabled={!hasCwd}
            onClick={(e) => {
              e.stopPropagation()
              void onOpenTerminal(entry)
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
