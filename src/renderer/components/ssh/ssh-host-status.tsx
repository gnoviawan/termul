import type { SSHConnectionStatus } from '@shared/types/ssh.types'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

/** Row state for one SSH host. `idle` = no connection record or disconnected. */
export type SSHHostState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

export function resolveSSHHostState(
  status: SSHConnectionStatus | undefined,
  isConnecting: boolean
): SSHHostState {
  if (isConnecting || status === 'connecting') return 'connecting'
  if (status === 'connected') return 'connected'
  if (status === 'failed') return 'failed'
  if (status === 'reconnecting') return 'reconnecting'
  return 'idle'
}

/**
 * One place for each host state's look (docs/design/status.md): the word,
 * its ink, and the lamp dot. A `null` lamp is a 9px warning spinner.
 */
const HOST_STATE: Record<
  SSHHostState,
  { word: string; wordClass: string; lampClass: string | null }
> = {
  idle: { word: 'Idle', wordClass: 'text-muted-foreground', lampClass: 'bg-muted-foreground/50' },
  connecting: { word: 'Connecting', wordClass: 'text-muted-foreground', lampClass: null },
  connected: { word: 'Connected', wordClass: 'text-muted-foreground', lampClass: 'bg-success' },
  reconnecting: {
    word: 'Reconnecting',
    wordClass: 'text-muted-foreground',
    lampClass: 'bg-warning'
  },
  failed: { word: 'Failed', wordClass: 'text-destructive', lampClass: 'bg-destructive' }
}

/** 7px status lamp; connecting is a 9px warning spinner. */
export function SSHHostLamp({ state }: { state: SSHHostState }): React.JSX.Element {
  const { lampClass } = HOST_STATE[state]
  return (
    <span
      className="flex size-2.5 shrink-0 items-center justify-center"
      data-testid="ssh-host-lamp"
      data-state={state}
      aria-hidden="true"
    >
      {lampClass === null ? (
        <Spinner size={9} decorative className="text-warning" />
      ) : (
        <span className={cn('size-1.75 rounded-full', lampClass)} />
      )}
    </span>
  )
}

export function SSHHostStateWord({
  state,
  className
}: {
  state: SSHHostState
  className?: string
}): React.JSX.Element {
  const { word, wordClass } = HOST_STATE[state]
  return <span className={cn('text-3xs', wordClass, className)}>{word}</span>
}
