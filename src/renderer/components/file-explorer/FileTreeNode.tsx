import { ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getFileIcon } from './file-icon-map'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { useGitFileStatusStore } from '@/stores/git-file-status-store'
import type { GitFileStatus } from '@/lib/tauri-git-api'
import type { DirectoryEntry } from '@shared/types/filesystem.types'

/** Map git status to display color and label */
function gitStatusStyle(status: GitFileStatus): { color: string; label: string } {
  switch (status) {
    case 'modified':
      return { color: 'text-amber-500', label: 'M' }
    case 'added':
      return { color: 'text-emerald-500', label: 'A' }
    case 'deleted':
      return { color: 'text-red-500', label: 'D' }
    case 'untracked':
      return { color: 'text-emerald-400', label: 'U' }
    case 'renamed':
      return { color: 'text-blue-400', label: 'R' }
    case 'conflicted':
      return { color: 'text-orange-500', label: 'C' }
    default:
      return { color: 'text-muted-foreground', label: '?' }
  }
}

interface FileTreeNodeProps {
  entry: DirectoryEntry
  depth: number
  isExpanded: boolean
  isSelected: boolean
  isLoading: boolean
  children?: DirectoryEntry[]
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onContextMenu: (e: React.MouseEvent, entry: DirectoryEntry) => void
  onClick?: (e: React.MouseEvent, entry: DirectoryEntry) => void
}

export function FileTreeNode({
  entry,
  depth,
  isExpanded,
  isSelected,
  isLoading,
  children,
  onToggle,
  onSelect,
  onContextMenu,
  onClick
}: FileTreeNodeProps): React.JSX.Element {
  const isDir = entry.type === 'directory'
  const Icon = getFileIcon(entry.extension, isDir, isExpanded)
  const gitStatus = useGitFileStatusStore((state) => state.statusMap.get(entry.path))
  const { startFileDrag } = usePaneDnd()

  const handleClick = (e: React.MouseEvent): void => {
    // Pass click event if handler provided (for multi-select handling)
    if (onClick) {
      onClick(e, entry)
      return
    }

    if (isDir) {
      onToggle(entry.path)
    } else {
      onSelect(entry.path)
    }
  }

  const handleDragStart = (e: React.DragEvent): void => {
    if (isDir) {
      e.preventDefault()
      return
    }
    startFileDrag(entry.path, e)
  }

  return (
    <>
      <div
        className={cn(
          'flex items-center h-7 cursor-pointer text-sm hover:bg-secondary/50 transition-colors select-none',
          isSelected && 'bg-accent text-accent-foreground'
        )}
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
        draggable={!isDir}
        onDragStart={handleDragStart}
      >
        {isDir && (
          <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center mr-0.5">
            {isLoading ? (
              <Loader2 size={12} className="animate-spin text-muted-foreground" />
            ) : (
              <ChevronRight
                size={12}
                className={cn(
                  'text-muted-foreground transition-transform',
                  isExpanded && 'rotate-90'
                )}
              />
            )}
          </span>
        )}
        {!isDir && <span className="w-4 mr-0.5 flex-shrink-0" />}
        <Icon
          size={14}
          className={cn(
            'flex-shrink-0 mr-1.5',
            isDir ? 'text-blue-400' : 'text-muted-foreground',
            gitStatus && gitStatusStyle(gitStatus.status).color
          )}
        />
        <span
          className={cn(
            'truncate',
            gitStatus && gitStatusStyle(gitStatus.status).color
          )}
        >
          {entry.name}
        </span>
        {gitStatus && (() => {
          const style = gitStatusStyle(gitStatus.status)
          return (
            <span
              className={cn('ml-auto mr-2 text-[10px] font-bold leading-none opacity-60', style.color)}
              title={`${style.label}${gitStatus.isStaged ? ' (staged)' : ''}`}
            >
              {style.label}
            </span>
          )
        })()}
      </div>

      {isDir && isExpanded && children && (
        <>
          {children.map((child) => (
            <FileTreeNodeWrapper
              key={child.path}
              entry={child}
              depth={depth + 1}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
        </>
      )}
    </>
  )
}

// Wrapper that connects to the store for child state
import { useFileExplorerStore } from '@/stores/file-explorer-store'

interface FileTreeNodeWrapperProps {
  entry: DirectoryEntry
  depth: number
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onContextMenu: (e: React.MouseEvent, entry: DirectoryEntry) => void
  onClick?: (e: React.MouseEvent, entry: DirectoryEntry) => void
}

function FileTreeNodeWrapper({
  entry,
  depth,
  onToggle,
  onSelect,
  onContextMenu,
  onClick
}: FileTreeNodeWrapperProps): React.JSX.Element {
  const isExpanded = useFileExplorerStore((state) => state.expandedDirs.has(entry.path))
  const isSelected = useFileExplorerStore((state) => state.selectedPaths.has(entry.path))
  const isLoading = useFileExplorerStore((state) => state.loadingDirs.has(entry.path))
  const children = useFileExplorerStore((state) => state.directoryContents.get(entry.path))

  return (
    <FileTreeNode
      entry={entry}
      depth={depth}
      isExpanded={isExpanded}
      isSelected={isSelected}
      isLoading={isLoading}
      children={children}
      onToggle={onToggle}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      onClick={onClick}
    />
  )
}

export { FileTreeNodeWrapper }
