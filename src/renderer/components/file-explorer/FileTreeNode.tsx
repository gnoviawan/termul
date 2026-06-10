import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { cn } from '@/lib/utils'
import { getFileIcon } from './file-icon-map'

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
  const isIgnored = entry.ignored === true
  const Icon = getFileIcon(entry.extension, isDir, isExpanded)
  const { startFileDrag } = usePaneDnd()
  const [showTooltip, setShowTooltip] = useState(false)
  const tooltipTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current !== null) {
        window.clearTimeout(tooltipTimerRef.current)
      }
    }
  }, [])

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

  const handleMouseEnter = (): void => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current)
    }

    tooltipTimerRef.current = window.setTimeout(() => {
      setShowTooltip(true)
    }, 900)
  }

  const handleMouseLeave = (): void => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = null
    }
    setShowTooltip(false)
  }

  return (
    <>
      <div
        className={cn(
          'group relative flex min-w-0 items-center h-7 cursor-pointer text-sm hover:bg-secondary/50 transition-colors select-none',
          isIgnored && 'opacity-50',
          isSelected && 'bg-accent text-accent-foreground'
        )}
        title={isIgnored ? `${entry.name} (git-ignored)` : undefined}
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        draggable={!isDir}
        onDragStart={handleDragStart}
      >
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">
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
              isDir ? 'text-blue-400' : 'text-muted-foreground'
            )}
          />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </div>

        {showTooltip && (
          <div className="pointer-events-none absolute left-2 top-[calc(100%+2px)] z-50 max-w-[420px] rounded border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg">
            {entry.name}
          </div>
        )}
      </div>

      {isDir &&
        isExpanded &&
        children?.map((child) => (
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
      // biome-ignore lint/correctness/noChildrenProp: `children` is a typed directory-data prop, not React children
      children={children}
      onToggle={onToggle}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      onClick={onClick}
    />
  )
}

export { FileTreeNodeWrapper }
