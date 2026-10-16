import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { SSHSession } from '@/stores/ssh-store'

/**
 * Display state of a host or a session tab. `idle` = no session;
 * `attention` = a connect waits for the user (host key, password).
 */
export type SSHHostState =
  | 'idle'
  | 'connecting'
  | 'attention'
  | 'connected'
  | 'disconnected'
  | 'failed'

export function sessionHostState(session: Pick<SSHSession, 'status'>): SSHHostState {
  switch (session.status) {
    case 'connecting':
      return 'connecting'
    case 'awaitingInput':
      return 'attention'
    case 'connected':
      return 'connected'
    case 'disconnected':
      return 'disconnected'
    case 'failed':
      return 'failed'
  }
}

/** A host's state from its session tabs (the most actionable one wins). */
export function resolveSSHHostState(sessions: Pick<SSHSession, 'status'>[]): SSHHostState {
  const states = sessions.map(sessionHostState)
  const order: SSHHostState[] = ['attention', 'connected', 'connecting', 'failed', 'disconnected']
  return order.find((state) => states.includes(state)) ?? 'idle'
}

/**
 * One place for each state's look (docs/design/status.md): the word, its
 * ink, and the lamp dot. A `null` lamp is a 9px warning spinner.
 */
const HOST_STATE: Record<
  SSHHostState,
  { word: string; wordClass: string; lampClass: string | null }
> = {
  idle: { word: 'Idle', wordClass: 'text-muted-foreground', lampClass: 'bg-muted-foreground/50' },
  connecting: { word: 'Connecting', wordClass: 'text-muted-foreground', lampClass: null },
  attention: { word: 'Needs input', wordClass: 'text-warning', lampClass: 'bg-warning' },
  connected: { word: 'Connected', wordClass: 'text-muted-foreground', lampClass: 'bg-success' },
  disconnected: {
    word: 'Disconnected',
    wordClass: 'text-muted-foreground',
    lampClass: 'bg-muted-foreground/50'
  },
  failed: { word: 'Failed', wordClass: 'text-destructive', lampClass: 'bg-destructive' }
}

export function hostStateWord(state: SSHHostState): string {
  return HOST_STATE[state].word
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

/**
 * The state word for a host row. An idle host shows nothing (the lamp says
 * enough); a connected host with several tabs shows their count instead.
 */
export function SSHHostStateWord({
  state,
  sessionCount = 0,
  className
}: {
  state: SSHHostState
  sessionCount?: number
  className?: string
}): React.JSX.Element | null {
  if (state === 'idle') return null
  const { word, wordClass } = HOST_STATE[state]
  const label = state === 'connected' && sessionCount > 1 ? `${sessionCount} sessions` : word
  return <span className={cn('text-2xs tabular-nums', wordClass, className)}>{label}</span>
}
