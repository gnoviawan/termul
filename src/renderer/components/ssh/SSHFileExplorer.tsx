import type { SFTPEntry } from '@shared/types/ssh.types'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileEdit,
  FilePlus,
  Folder,
  FolderPlus,
  FolderTree,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff
} from 'lucide-react'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { sshApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSSHActions } from '@/stores/ssh-store'

interface SSHFileExplorerProps {
  connectionId: string
  isConnected: boolean
  sftpReady: boolean
  entries: SFTPEntry[]
  currentPath: string
  expandedDirs: Set<string>
  childEntries: Map<string, SFTPEntry[]>
  loadingDirs: Set<string>
  isLoadingRoot: boolean
  profileName: string
  onConnect: () => void
  onBrowseFiles: () => void
  onToggleDir: (path: string) => void
  onLoadDir: (path: string) => void
  onMkdir: () => void
  onCreateFile: () => void
  onDelete: (entry: SFTPEntry) => void
  onRename: (entry: SFTPEntry) => void
}

export function SSHFileExplorer({
  connectionId,
  isConnected,
  sftpReady,
  entries,
  currentPath,
  expandedDirs,
  childEntries,
  loadingDirs,
  isLoadingRoot,
  profileName,
  onConnect,
  onBrowseFiles,
  onToggleDir,
  onLoadDir,
  onMkdir,
  onCreateFile,
  onDelete,
  onRename
}: SSHFileExplorerProps): React.JSX.Element {
  const { setEditingFile: setStoreFile, setEditingContent: setStoreContent } = useSSHActions()

  const handleOpenFile = useCallback(
    async (entry: SFTPEntry) => {
      if (!connectionId) return
      try {
        const result = await sshApi.sftpReadFile(connectionId, entry.path)
        if (result.success) {
          setStoreFile({
            path: entry.path,
            content: result.data,
            name: entry.name,
            originalContent: result.data
          })
          setStoreContent(result.data)
        } else {
          toast.error(`Failed to open: ${result.error}`)
        }
      } catch (error) {
        toast.error(`Failed to open: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [connectionId, setStoreFile, setStoreContent]
  )

  const handleDelete = useCallback(
    (entry: SFTPEntry) => {
      onDelete(entry)
    },
    [onDelete]
  )

  const handleRename = useCallback(
    (entry: SFTPEntry) => {
      onRename(entry)
    },
    [onRename]
  )

  const formatSize = (b: number): string =>
    b < 1024
      ? `${b} B`
      : b < 1048576
        ? `${(b / 1024).toFixed(1)} KB`
        : b < 1073741824
          ? `${(b / 1048576).toFixed(1)} MB`
          : `${(b / 1073741824).toFixed(1)} GB`

  const renderEntry = (entry: SFTPEntry, depth = 0) => {
    const isDir = entry.entryType === 'directory'
    const isExp = expandedDirs.has(entry.path)
    const isLoading = loadingDirs.has(entry.path)
    const children = childEntries.get(entry.path) ?? []
    const Icon = isDir ? Folder : entry.entryType === 'symlink' ? Link2 : File
    return (
      <div key={entry.path}>
        <div
          className="group flex min-w-0 items-center gap-1 overflow-hidden px-2 py-0.5 text-xs hover:bg-accent/50 cursor-pointer"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => (isDir ? onToggleDir(entry.path) : handleOpenFile(entry))}
        >
          {isDir && (
            <span className="flex-shrink-0 w-3.5">
              {isLoading ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : isExp ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </span>
          )}
          {!isDir && <span className="w-3.5" />}
          <Icon
            className={cn(
              'h-3.5 w-3.5 flex-shrink-0',
              isDir ? 'text-blue-400' : 'text-muted-foreground'
            )}
          />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {!isDir && (
            <span className="hidden shrink-0 text-[10px] text-muted-foreground group-hover:inline">
              {formatSize(entry.size)}
            </span>
          )}
          <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
            {!isDir && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleOpenFile(entry)
                }}
                className="p-0.5 rounded hover:bg-accent"
                title="Edit"
              >
                <FileEdit className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleRename(entry)
              }}
              className="p-0.5 rounded hover:bg-accent"
              title="Rename"
            >
              <Pencil className="h-3 w-3 text-muted-foreground" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleDelete(entry)
              }}
              className="p-0.5 rounded hover:bg-destructive/20"
              title="Delete"
            >
              <Trash2 className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        </div>
        {isDir && isExp && children.map((c) => renderEntry(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col">
      <div className="h-9 flex items-center justify-between px-3 border-b border-border">
        <div className="flex items-center gap-1.5">
          <FolderTree className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium truncate">{profileName}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {isConnected ? (
            <>
              <button
                onClick={onMkdir}
                className="p-1 rounded hover:bg-accent text-muted-foreground"
                title="New folder"
              >
                <FolderPlus className="h-3 w-3" />
              </button>
              <button
                onClick={onCreateFile}
                className="p-1 rounded hover:bg-accent text-muted-foreground"
                title="New file"
              >
                <FilePlus className="h-3 w-3" />
              </button>
              <button
                onClick={() => onLoadDir(currentPath)}
                className="p-1 rounded hover:bg-accent text-muted-foreground"
                title="Refresh"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </>
          ) : (
            <button
              onClick={onConnect}
              className="p-1 rounded hover:bg-accent text-green-500"
              title="Connect"
            >
              <Wifi className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {isConnected && (
        <div className="px-3 py-1 border-b border-border">
          <span className="text-[10px] text-muted-foreground font-mono truncate block">
            {currentPath}
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!isConnected ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center gap-2">
            <WifiOff className="h-6 w-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">Not connected</p>
            <button
              onClick={onConnect}
              className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Connect
            </button>
          </div>
        ) : !sftpReady ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center gap-2">
            <FolderTree className="h-6 w-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">SFTP not started</p>
            <button
              onClick={onBrowseFiles}
              className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Browse Files
            </button>
          </div>
        ) : isLoadingRoot ? (
          <div className="flex items-center justify-center h-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Empty directory</p>
          </div>
        ) : (
          <div className="py-1">{entries.map((e) => renderEntry(e))}</div>
        )}
      </div>
    </div>
  )
}
