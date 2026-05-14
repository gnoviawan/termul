import { useState, useCallback, useEffect } from 'react'
import {
  Folder,
  File,
  Link2,
  Download,
  Upload,
  Trash2,
  FolderPlus,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SFTPEntry } from '@shared/types/ssh.types'
import { sshApi } from '@/lib/api'
import { dialogApi } from '@/lib/dialog-api'
import { toast } from 'sonner'

interface RemoteFileExplorerProps {
  connectionId: string
  initialPath?: string
}

interface TreeNode {
  entry: SFTPEntry
  children?: TreeNode[]
  isExpanded: boolean
  isLoading: boolean
}

export function RemoteFileExplorer({
  connectionId,
  initialPath = '/',
}: RemoteFileExplorerProps): React.JSX.Element {
  const [currentPath, setCurrentPath] = useState(initialPath)
  const [entries, setEntries] = useState<SFTPEntry[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [childEntries, setChildEntries] = useState<Map<string, SFTPEntry[]>>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDirectory = useCallback(
    async (path: string) => {
      setIsLoading(true)
      setError(null)

      const result = await sshApi.sftpListDir(connectionId, path)
      if (result.success) {
        setEntries(result.data)
        setCurrentPath(path)
      } else {
        setError(result.error ?? 'Failed to load directory')
        toast.error(`Failed to load: ${result.error}`)
      }
      setIsLoading(false)
    },
    [connectionId]
  )

  const toggleDirectory = useCallback(
    async (dirPath: string) => {
      if (expandedDirs.has(dirPath)) {
        setExpandedDirs((prev) => {
          const next = new Set(prev)
          next.delete(dirPath)
          return next
        })
        return
      }

      setLoadingDirs((prev) => new Set(prev).add(dirPath))

      const result = await sshApi.sftpListDir(connectionId, dirPath)
      if (result.success) {
        setChildEntries((prev) => new Map(prev).set(dirPath, result.data))
        setExpandedDirs((prev) => new Set(prev).add(dirPath))
      } else {
        toast.error(`Permission denied: ${dirPath}`)
      }

      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(dirPath)
        return next
      })
    },
    [connectionId, expandedDirs]
  )

  const handleDownload = async (entry: SFTPEntry) => {
    const saveResult = await dialogApi.selectFile({
      title: `Save ${entry.name}`,
      filters: [{ name: 'All Files', extensions: ['*'] }],
    })
    if (!saveResult.success) {
      if (saveResult.code !== 'CANCELLED') toast.error(`Save dialog failed: ${saveResult.error}`)
      return
    }
    const localPath = saveResult.data
    const result = await sshApi.sftpDownload(connectionId, entry.path, localPath)
    if (result.success) {
      toast.success(`Downloaded: ${entry.name}`)
    } else {
      toast.error(`Download failed: ${result.error}`)
    }
  }

  const handleDelete = async (entry: SFTPEntry) => {
    const result = await sshApi.sftpDelete(connectionId, entry.path)
    if (result.success) {
      toast.success(`Deleted: ${entry.name}`)
      loadDirectory(currentPath)
    } else {
      toast.error(`Delete failed: ${result.error}`)
    }
  }

  const handleMkdir = async () => {
    const name = prompt('Directory name:')
    if (!name) return

    const newPath = currentPath.endsWith('/')
      ? `${currentPath}${name}`
      : `${currentPath}/${name}`

    const result = await sshApi.sftpMkdir(connectionId, newPath)
    if (result.success) {
      toast.success(`Created: ${name}`)
      loadDirectory(currentPath)
    } else {
      toast.error(`Failed to create directory: ${result.error}`)
    }
  }

  // Load initial directory on mount
  useEffect(() => {
    void loadDirectory(initialPath)
  }, [initialPath, loadDirectory])

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  const getIcon = (entry: SFTPEntry) => {
    switch (entry.entryType) {
      case 'directory':
        return Folder
      case 'symlink':
        return Link2
      default:
        return File
    }
  }

  const renderEntry = (entry: SFTPEntry, depth: number = 0) => {
    const Icon = getIcon(entry)
    const isDir = entry.entryType === 'directory'
    const isExpanded = expandedDirs.has(entry.path)
    const isLoadingDir = loadingDirs.has(entry.path)
    const children = childEntries.get(entry.path) ?? []

    return (
      <div key={entry.path}>
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 hover:bg-accent/50 cursor-pointer group text-xs',
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            if (isDir) toggleDirectory(entry.path)
          }}
        >
          {/* Expand chevron */}
          {isDir && (
            <span className="flex-shrink-0 w-3.5">
              {isLoadingDir ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : isExpanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </span>
          )}
          {!isDir && <span className="w-3.5" />}

          {/* Icon */}
          <Icon className={cn('h-3.5 w-3.5 flex-shrink-0', isDir ? 'text-blue-400' : 'text-muted-foreground')} />

          {/* Name */}
          <span className="flex-1 truncate">{entry.name}</span>

          {/* Size */}
          {!isDir && (
            <span className="text-[10px] text-muted-foreground">{formatSize(entry.size)}</span>
          )}

          {/* Actions */}
          <div className="hidden group-hover:flex items-center gap-0.5">
            {!isDir && (
              <button
                onClick={(e) => { e.stopPropagation(); handleDownload(entry) }}
                className="p-0.5 rounded hover:bg-accent"
                title="Download"
              >
                <Download className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(entry) }}
              className="p-0.5 rounded hover:bg-destructive/20"
              title="Delete"
            >
              <Trash2 className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* Children */}
        {isDir && isExpanded && children.map((child) => renderEntry(child, depth + 1))}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
        <span className="text-xs text-muted-foreground truncate flex-1 font-mono">
          {currentPath}
        </span>
        <button
          onClick={handleMkdir}
          className="p-1 rounded hover:bg-accent text-muted-foreground"
          title="New folder"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => loadDirectory(currentPath)}
          className="p-1 rounded hover:bg-accent text-muted-foreground"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="p-4 text-center">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-xs text-muted-foreground">Empty directory</p>
          </div>
        ) : (
          <div className="py-1">{entries.map((entry) => renderEntry(entry))}</div>
        )}
      </div>
    </div>
  )
}
