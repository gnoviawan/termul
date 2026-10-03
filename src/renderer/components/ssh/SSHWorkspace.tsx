import type { SSHProfile } from '@shared/types/ssh.types'
import { Terminal, WifiOff } from '@/components/icons'
import { ConnectedTerminal } from '@/components/terminal/ConnectedTerminal'
import { Button } from '@/components/ui/button'
import type { useSSHConnection } from '@/hooks/use-ssh-connection'
import { useSSHEditorFile } from '@/stores/ssh-store'
import { SSHFileEditor } from './SSHFileEditor'

interface SSHWorkspaceProps {
  profile: SSHProfile
  conn: ReturnType<typeof useSSHConnection>
}

export function SSHWorkspace({ profile, conn }: SSHWorkspaceProps): React.JSX.Element {
  const editingFile = useSSHEditorFile()

  return (
    <div className="flex h-full w-full overflow-hidden rounded-xl bg-card">
      {/* Right: Terminal + Editor area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="h-9 flex items-center justify-between px-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">SSH: {profile.name}</span>
            {conn.isConnected ? (
              <span className="flex items-center gap-1 text-3xs text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success-fill" />
                Connected
              </span>
            ) : conn.isConnectingStatus || conn.isConnecting ? (
              <span className="flex items-center gap-1 text-3xs text-warning">
                <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse" />
                Connecting
              </span>
            ) : (
              <span className="flex items-center gap-1 text-3xs text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                Disconnected
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {conn.isConnected || conn.localTerminalPtyId ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={conn.handleDisconnect}
                className="hover:bg-destructive/10 hover:text-destructive"
              >
                <WifiOff />
                Disconnect
              </Button>
            ) : (
              <Button
                type="button"
                size="xs"
                onClick={conn.handleConnect}
                disabled={conn.isConnecting}
              >
                <Terminal />
                {conn.isConnecting ? 'Connecting...' : 'Connect'}
              </Button>
            )}
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 flex min-h-0 relative">
          {editingFile && conn.connectionId ? (
            <SSHFileEditor connectionId={conn.connectionId} />
          ) : editingFile && !conn.connectionId ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
              <Terminal className="h-10 w-10 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">Reconnecting to load editor...</p>
              <Button
                type="button"
                size="sm"
                onClick={conn.handleConnect}
                disabled={conn.isConnecting}
              >
                <Terminal />
                {conn.isConnecting ? 'Connecting...' : 'Reconnect'}
              </Button>
            </div>
          ) : conn.localTerminalPtyId ? (
            <div className="absolute inset-0 overflow-hidden">
              <ConnectedTerminal
                terminalId={conn.localTerminalPtyId}
                autoSpawn={false}
                isVisible={true}
                onExit={conn.handleSSHProcessExit}
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
              <Terminal className="h-10 w-10 text-muted-foreground/20" />
              <div>
                <p className="text-sm text-muted-foreground">SSH Workspace</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Connect to start working with this server
                </p>
              </div>
              <Button type="button" onClick={conn.handleConnect} disabled={conn.isConnecting}>
                <Terminal />
                {conn.isConnecting ? 'Connecting...' : 'Connect & Open Terminal'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
