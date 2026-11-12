import { memo } from 'react'
import { Check, ChevronRight, TerminalSquare } from '@/components/icons'
import type { BackgroundCommand } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { useToolCallRevealStore } from '@/stores/tool-call-reveal-store'
import { SubagentStatusIcon } from './SubagentRow'
import { BackgroundCommandElapsed } from './subagent-time'

/** "1 running · 2 ended": the non-zero counts. Running takes the warning tone. */
export function BackgroundCommandCountParts({
  running,
  ended
}: {
  running: number
  ended: number
}): React.JSX.Element {
  return (
    <>
      {running > 0 && <span className="text-warning">{running} running</span>}
      {running > 0 && ended > 0 && (
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
      )}
      {ended > 0 && <span className="text-muted-foreground">{ended} ended</span>}
    </>
  )
}

interface BackgroundCommandRowProps {
  sessionId: string
  command: BackgroundCommand
  /** Runs before the chat scrolls to the card (the pill closes its list). */
  onOpen?: () => void
}

/**
 * One command the agent left running: terminal icon with status dot, title,
 * the command line, status and elapsed time. Shows its tool call card in the
 * chat.
 */
function BackgroundCommandRowComponent({
  sessionId,
  command,
  onOpen
}: BackgroundCommandRowProps): React.JSX.Element {
  const running = command.state === 'running'
  return (
    <button
      type="button"
      data-background-command-row={command.toolCallId}
      onClick={() => {
        onOpen?.()
        useToolCallRevealStore.getState().reveal(sessionId, command.toolCallId)
      }}
      className="@container flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <span
        aria-hidden="true"
        className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted"
      >
        <TerminalSquare size={16} className="text-muted-foreground" />
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card',
            running ? 'bg-warning' : 'bg-muted-foreground'
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {command.title || command.command || 'Command'}
        </span>
        {command.command && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {command.command}
          </span>
        )}
      </span>
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 text-xs',
          running ? 'text-warning' : 'text-muted-foreground'
        )}
      >
        {running ? (
          <SubagentStatusIcon status="running" />
        ) : (
          <Check size={14} className="shrink-0" aria-hidden="true" />
        )}
        <span className="@max-[36rem]:sr-only">{running ? 'Running' : 'Ended'}</span>
      </span>
      <BackgroundCommandElapsed command={command} className="min-w-[5ch]" />
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  )
}

export const BackgroundCommandRow = memo(BackgroundCommandRowComponent)
