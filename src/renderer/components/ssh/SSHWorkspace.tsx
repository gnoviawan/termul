import { useCallback } from 'react'
import { Terminal, WifiOff } from 'lucide-react'
import { sshApi } from '@/lib/api'
import type { SSHProfile, SFTPEntry } from '@shared/types/ssh.types'
import { ConnectedTerminal } from '@/components/terminal/ConnectedTerminal'
import { useSSHEditorFile } from '@/stores/ssh-store'
import { useSSHConnection } from '@/hooks/use-ssh-connection'
import { SSHFileExplorer } from './SSHFileExplorer'
import { SSHFileEditor } from './SSHFileEditor'
import { toast } from 'sonner'

interface SSHWorkspaceProps {
  profile: SSHProfile
}

export function SSHWorkspace({ profile }: SSHWorkspaceProps): React.JSX.Element {
  const editingFile = useSSHEditorFile()

  const conn = useSSHConnection(profile)

  const handleMkdir = useCallback(async () => {
    if (!conn.connectionId) return
    const name = prompt('New folder name:')
    if (!name) return
    const newPath = conn.currentPath.endsWith('/') ? `${conn.currentPath}${name}` : `${conn.currentPath}/${name}`
    const r = await sshApi.sftpMkdir(conn.connectionId, newPath)
    if (r.success) { toast.success(`Created: ${name}`); conn.loadDirectory(conn.currentPath) }
    else toast.error(`Failed: ${r.error}`)
  }, [conn.connectionId, conn.currentPath, conn.loadDirectory])

  const handleCreateFile = useCallback(async () => {
    if (!conn.connectionId) return
    const name = prompt('New file name:')
    if (!name) return
    const newPath = conn.currentPath.endsWith('/') ? `${conn.currentPath}${name}` : `${conn.currentPath}/${name}`
    const r = await sshApi.sftpCreateFile(conn.connectionId, newPath)
    if (r.success) { toast.success(`Created: ${name}`); conn.loadDirectory(conn.currentPath) }
    else toast.error(`Failed: ${r.error}`)
  }, [conn.connectionId, conn.currentPath, conn.loadDirectory])

  const handleDelete = useCallback(async (entry: SFTPEntry) => {
    if (!conn.connectionId) return
    if (!confirm(`Delete ${entry.entryType} "${entry.name}"?`)) return
    const r = await sshApi.sftpDelete(conn.connectionId, entry.path)
    if (r.success) { toast.success(`Deleted: ${entry.name}`); conn.loadDirectory(conn.currentPath) }
    else toast.error(`Delete failed: ${r.error}`)
  }, [conn.connectionId, conn.currentPath, conn.loadDirectory])

  const handleRename = useCallback(async (entry: SFTPEntry) => {
    if (!conn.connectionId) return
    const newName = prompt(`Rename "${entry.name}" to:`, entry.name)
    if (!newName || newName === entry.name) return
    const pp = entry.path.substring(0, entry.path.lastIndexOf('/'))
    const r = await sshApi.sftpRename(conn.connectionId, entry.path, `${pp}/${newName}`)
    if (r.success) { toast.success(`Renamed: ${entry.name} → ${newName}`); conn.loadDirectory(conn.currentPath) }
    else toast.error(`Rename failed: ${r.error}`)
  }, [conn.connectionId, conn.currentPath, conn.loadDirectory])

  return (
    <div className="flex h-full w-full overflow-hidden rounded-xl bg-card">
      {/* Left: Remote File Explorer */}
      <SSHFileExplorer
        connectionId={conn.connectionId ?? ''}
        isConnected={conn.isConnected}
        sftpReady={conn.sftpReady}
        entries={conn.entries}
        currentPath={conn.currentPath}
        expandedDirs={conn.expandedDirs}
        childEntries={conn.childEntries}
        loadingDirs={conn.loadingDirs}
        isLoadingRoot={conn.isLoadingRoot}
        profileName={profile.name}
        onConnect={conn.handleConnect}
        onBrowseFiles={conn.handleBrowseFiles}
        onToggleDir={conn.toggleDirectory}
        onLoadDir={conn.loadDirectory}
        onMkdir={handleMkdir}
        onCreateFile={handleCreateFile}
        onDelete={handleDelete}
        onRename={handleRename}
      />

      {/* Right: Terminal + Editor area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="h-9 flex items-center justify-between px-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">SSH: {profile.name}</span>
            {conn.isConnected ? (
              <span className="flex items-center gap-1 text-[10px] text-green-500">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />Connected
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />Disconnected
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {conn.isConnected ? (
              <button onClick={conn.handleDisconnect}
                className="px-2 py-0.5 text-[10px] rounded border border-border hover:bg-destructive/10 hover:text-destructive flex items-center gap-1">
                <WifiOff className="h-3 w-3" />Disconnect
              </button>
            ) : (
              <button onClick={conn.handleConnect} disabled={conn.isConnecting}
                className="px-2 py-0.5 text-[10px] rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1 disabled:opacity-50">
                <Terminal className="h-3 w-3" />{conn.isConnecting ? 'Connecting...' : 'Connect'}
              </button>
            )}
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 flex min-h-0 relative">
          {editingFile ? (
            <SSHFileEditor connectionId={conn.connectionId ?? ''} />
          ) : conn.isConnected && conn.localTerminalPtyId ? (
            <div className="absolute inset-0 overflow-hidden">
              <ConnectedTerminal terminalId={conn.localTerminalPtyId} autoSpawn={false} isVisible={true} />
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
              <Terminal className="h-10 w-10 text-muted-foreground/20" />
              <div>
                <p className="text-sm text-muted-foreground">SSH Workspace</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Connect to start working with this server</p>
              </div>
              <button onClick={conn.handleConnect} disabled={conn.isConnecting}
                className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 disabled:opacity-50">
                <Terminal className="h-3.5 w-3.5" />{conn.isConnecting ? 'Connecting...' : 'Connect & Open Terminal'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
