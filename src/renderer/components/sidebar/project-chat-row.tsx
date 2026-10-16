import type { ChatHistorySidebarEntry } from '@/components/chat/ChatHistoryEntryRow'
import { Spinner } from '@/components/ui/spinner'
import { formatRelativeTimeFromMs } from '@/lib/relative-time'

export type ProjectChatEntry = ChatHistorySidebarEntry

/**
 * Live state of one chat row: a turn is in progress, the chat waits on you, or
 * neither. `done` means a turn finished unseen.
 */
export type ProjectChatLiveState = 'running' | 'needs-you' | 'done' | 'idle'

/**
 * Right slot of a chat row: running spinner, needs-you pill, "New" mark, or
 * relative last-activity time ("Closed · 2d" for a closed chat). Blue stays
 * on the spinner only: it means live work (docs/design/colors.md).
 */
export function ChatRowTrail({
  liveState,
  lastActivityAt,
  closed = false
}: {
  liveState: ProjectChatLiveState
  lastActivityAt: number
  /** The chat is closed: the idle time reads "Closed · <time>". */
  closed?: boolean
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
        <span className="flex shrink-0 items-center gap-1 rounded-md bg-warning/10 px-1.5 text-3xs font-medium text-warning">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          Needs you
        </span>
      )
    case 'done':
      return (
        <span
          className="flex shrink-0 items-center gap-1 text-2xs font-medium text-foreground"
          title="New activity"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground" />
          New
        </span>
      )
    case 'idle': {
      const time = formatRelativeTimeFromMs(lastActivityAt)
      return (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {closed ? `Closed · ${time}` : time}
        </span>
      )
    }
  }
}
