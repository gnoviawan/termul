import type { SSHProfile } from '@shared/types/ssh.types'
import { RefreshCw, WifiOff } from '@/components/icons'
import { ConnectedTerminal } from '@/components/terminal/ConnectedTerminal'
import { Button } from '@/components/ui/button'
import { describeSessionEnd } from '@/lib/ssh-messages'
import { attachSSHTerminal, closeSSHSession, retrySSHSession } from '@/lib/ssh-sessions'
import { cn } from '@/lib/utils'
import { type SSHSession, useSSHEditorFile } from '@/stores/ssh-store'
import { SSHConnectionPanel } from './SSHConnectionPanel'
import { SSHFileEditor } from './SSHFileEditor'

interface SSHSessionViewProps {
  session: SSHSession
  profile: SSHProfile
  active: boolean
  onEditHost: (profile: SSHProfile) => void
}

/** Shown above the kept output once the shell has ended. */
function EndedBanner({ session, profile }: { session: SSHSession; profile: SSHProfile }) {
  if (!session.ended) return null
  const message = describeSessionEnd(session.ended, profile)
  const lost = session.ended.reason === 'lost'
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2',
        lost ? 'border-warning/30 bg-warning/10' : 'border-border bg-card'
      )}
      role="status"
      data-testid="ssh-session-ended"
    >
      <WifiOff
        size={14}
        className={cn('shrink-0', lost ? 'text-warning' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 text-xs">
        <span className={cn('font-medium', lost ? 'text-warning' : 'text-foreground')}>
          {message.title}.
        </span>{' '}
        <span className="text-muted-foreground">{message.body}</span>
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void closeSSHSession(session.id)}
        >
          Close
        </Button>
        <Button type="button" size="xs" onClick={() => retrySSHSession(session.id)}>
          <RefreshCw />
          Reconnect
        </Button>
      </div>
    </div>
  )
}

/** One session tab: its terminal, or the connection screen until it is ready. */
export function SSHSessionView({
  session,
  profile,
  active,
  onEditHost
}: SSHSessionViewProps): React.JSX.Element {
  const editingFile = useSSHEditorFile()
  const editing = active && editingFile !== null && editingFile.connectionId === session.attemptId
  const ptyId = session.ptyId

  if (!ptyId) {
    return <SSHConnectionPanel session={session} profile={profile} onEditHost={onEditHost} />
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <EndedBanner session={session} profile={profile} />
      {editing && (
        <div className="min-h-0 flex-1">
          <SSHFileEditor connectionId={session.attemptId} />
        </div>
      )}
      {/* The terminal stays mounted under the editor so output keeps flowing. */}
      <div className={cn('relative min-h-0 flex-1', editing && 'hidden')}>
        <div className="absolute inset-0 overflow-hidden">
          <ConnectedTerminal
            key={ptyId}
            terminalId={ptyId}
            autoSpawn={false}
            autoFocus={active}
            isVisible={active && !editing}
            onBoundToStoreTerminal={() => void attachSSHTerminal(session.id)}
          />
        </div>
      </div>
    </div>
  )
}
