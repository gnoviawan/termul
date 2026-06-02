import type { SSHProfile } from '@shared/types/ssh.types'
import { Terminal, WifiOff } from 'lucide-react'
import { ConnectedTerminal } from '@/components/terminal/ConnectedTerminal'
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
              <span className="flex items-center gap-1 text-[10px] text-green-500">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                Connected
              </span>
            ) : conn.isConnectingStatus || conn.isConnecting ? (
              <span className="flex items-center gap-1 text-[10px] text-yellow-500">
                <span className="h-1.5 w-1.5 rounded-full bg-yellow-500 animate-pulse" />
                Connecting
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                Disconnected
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {conn.isConnected || conn.localTerminalPtyId ? (
              <button
                onClick={conn.handleDisconnect}
                className="px-2 py-0.5 text-[10px] rounded border border-border hover:bg-destructive/10 hover:text-destructive flex items-center gap-1"
              >
                <WifiOff className="h-3 w-3" />
                Disconnect
              </button>
            ) : (
              <button
                onClick={conn.handleConnect}
                disabled={conn.isConnecting}
                className="px-2 py-0.5 text-[10px] rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1 disabled:opacity-50"
              >
                <Terminal className="h-3 w-3" />
                {conn.isConnecting ? 'Connecting...' : 'Connect'}
              </button>
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
              <button
                onClick={conn.handleConnect}
                disabled={conn.isConnecting}
                className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 disabled:opacity-50"
              >
                <Terminal className="h-3.5 w-3.5" />
                {conn.isConnecting ? 'Connecting...' : 'Reconnect'}
              </button>
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
              <button
                onClick={conn.handleConnect}
                disabled={conn.isConnecting}
                className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 disabled:opacity-50"
              >
                <Terminal className="h-3.5 w-3.5" />
                {conn.isConnecting ? 'Connecting...' : 'Connect & Open Terminal'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
