import type { DirectoryEntry } from '@shared/types/filesystem.types'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import {
  GIT_STATUS_LABEL,
  GIT_STATUS_LETTER,
  GIT_STATUS_TEXT_CLASS,
  type GitDisplayStatus
} from '@/lib/git-status-display'
import { cn } from '@/lib/utils'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useExplorerGitDecorationsContext } from './explorer-git-decorations'
import {
  InlineCreateRow,
  InlineNameInput,
  isRenameTarget,
  treeRowPaddingLeft,
  useExplorerInlineInput
} from './explorer-inline-input'
import { MaterialFileIcon } from './MaterialFileIcon'
import { normalizeTreePath, parentTreePath } from './tree-paths'

/**
 * Selection state of a row. `primary` is the only or last-clicked selected
 * row (keycap); `multi` is any other row of a multi-selection (quiet wash).
 */
export type TreeRowSelection = 'primary' | 'multi' | 'none'

const ROW_SELECTION_CLASS: Record<TreeRowSelection, string> = {
  primary: 'keycap text-foreground',
  multi: 'bg-foreground/[0.06] text-foreground',
  none: 'hover:bg-foreground/[0.03]'
}

interface FileTreeNodeProps {
  entry: DirectoryEntry
  depth: number
  isExpanded: boolean
  selection: TreeRowSelection
  isLoading: boolean
  /** The selection sits directly in this folder: its indent guide is brighter. */
  isGuideActive?: boolean
  /** Git status of a file row (letter + tint). */
  gitStatus?: GitDisplayStatus
  /** A folder row that holds changed paths (dot at the row end). */
  hasGitChanges?: boolean
  children?: DirectoryEntry[]
  onContextMenu: (e: React.MouseEvent, entry: DirectoryEntry) => void
  /** Row click: selection, folder toggle or file open. */
  onClick: (e: React.MouseEvent, entry: DirectoryEntry) => void
  /**
   * Builds the declarative `<ContextMenuContent>` for this node. When
   * provided, the row is wrapped in `<ContextMenu><ContextMenuTrigger
   * asChild>` so right-click opens the Radix menu at the pointer; the
   * `onContextMenu` prop still seeds selection + stops the global trigger.
   */
  renderContextMenu?: (entry: DirectoryEntry) => ReactNode
}

export function FileTreeNode({
  entry,
  depth,
  isExpanded,
  selection,
  isLoading,
  isGuideActive = false,
  gitStatus,
  hasGitChanges = false,
  children,
  onContextMenu,
  onClick,
  renderContextMenu
}: FileTreeNodeProps): React.JSX.Element {
  const isDir = entry.type === 'directory'
  const isIgnored = entry.ignored === true
  const suppressTreeAnimations = useFileExplorerStore((state) => state.suppressTreeAnimations)
  const finalizeDirectoryCollapse = useFileExplorerStore((state) => state.finalizeDirectoryCollapse)
  const { startFileDrag } = usePaneDnd()
  const { inlineInput } = useExplorerInlineInput()
  const isRenaming = isRenameTarget(inlineInput, entry.path)
  const [showTooltip, setShowTooltip] = useState(false)
  const tooltipTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current !== null) {
        window.clearTimeout(tooltipTimerRef.current)
      }
    }
  }, [])

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

  const fileStatus = isDir ? undefined : gitStatus
  const nameToneClass = isIgnored
    ? 'text-muted-foreground/60'
    : fileStatus
      ? GIT_STATUS_TEXT_CLASS[fileStatus]
      : undefined

  const renderChild = (child: DirectoryEntry): React.JSX.Element => (
    <FileTreeNodeWrapper
      key={child.path}
      entry={child}
      depth={depth + 1}
      onContextMenu={onContextMenu}
      onClick={onClick}
      renderContextMenu={renderContextMenu}
    />
  )

  // Children of an expanded folder: a 1px indent guide aligned with this
  // row's chevron centre, then an in-place create row (if any), then the
  // child rows.
  const childList = (
    <div className="relative">
      <span
        aria-hidden
        data-testid="tree-indent-guide"
        className={cn(
          'pointer-events-none absolute inset-y-0 w-px transition-colors duration-150 ease-out',
          isGuideActive ? 'bg-muted-foreground/40' : 'bg-border'
        )}
        style={{ left: treeRowPaddingLeft(depth) + 7 }}
      />
      <InlineCreateRow parentPath={entry.path} depth={depth + 1} />
      {children?.map(renderChild)}
    </div>
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-path={entry.path}
            data-selected={selection !== 'none' || undefined}
            className={cn(
              'group relative flex h-7 min-w-0 cursor-pointer select-none items-center rounded-md pr-1 text-xs transition-colors duration-150 ease-out',
              FOCUS_RING_CLASS,
              ROW_SELECTION_CLASS[selection]
            )}
            title={isIgnored ? `${entry.name} (git-ignored)` : undefined}
            style={{ paddingLeft: treeRowPaddingLeft(depth) }}
            onClick={(e) => onClick(e, entry)}
            onContextMenu={(e) => onContextMenu(e, entry)}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            draggable={!isDir && !isRenaming}
            onDragStart={handleDragStart}
          >
            <div className="flex min-w-0 flex-1 items-center overflow-hidden">
              <span className="mr-0.5 flex size-3.5 flex-shrink-0 items-center justify-center text-muted-foreground/70">
                {isDir &&
                  (isLoading ? (
                    <Spinner size={11} decorative className="text-muted-foreground" />
                  ) : isExpanded ? (
                    <ChevronDown size={11} />
                  ) : (
                    <ChevronRight size={11} />
                  ))}
              </span>
              <MaterialFileIcon
                name={entry.name}
                extension={entry.extension}
                isDirectory={isDir}
                isExpanded={isExpanded}
                depth={depth}
                size={14}
                className={cn(isIgnored && 'opacity-60', isRenaming && 'mr-1')}
              />
              {isRenaming ? (
                <InlineNameInput />
              ) : (
                <span className={cn('min-w-0 flex-1 truncate pl-1', nameToneClass)}>
                  {entry.name}
                </span>
              )}
            </div>

            {!isRenaming && fileStatus && (
              <span
                className={cn(
                  'ml-1 w-4 shrink-0 text-center font-mono text-2xs font-semibold',
                  GIT_STATUS_TEXT_CLASS[fileStatus]
                )}
                title={GIT_STATUS_LABEL[fileStatus]}
              >
                <span aria-hidden>{GIT_STATUS_LETTER[fileStatus]}</span>
                <span className="sr-only">{GIT_STATUS_LABEL[fileStatus]}</span>
              </span>
            )}
            {!isRenaming && isDir && hasGitChanges && (
              <span className="ml-1 flex w-4 shrink-0 justify-center">
                <span
                  className="size-[5px] rounded-full bg-diff-modified"
                  title="Contains changes"
                  role="img"
                  aria-label="Contains changes"
                />
              </span>
            )}

            {showTooltip && !isRenaming && (
              <div className="pointer-events-none absolute left-2 top-[calc(100%+2px)] z-50 max-w-[420px] rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
                {entry.name}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        {renderContextMenu?.(entry)}
      </ContextMenu>

      {isDir &&
        (suppressTreeAnimations ? (
          isExpanded && childList
        ) : (
          <CollapseExpandMotion
            open={isExpanded}
            onExitComplete={() => finalizeDirectoryCollapse(entry.path)}
          >
            {childList}
          </CollapseExpandMotion>
        ))}
    </>
  )
}

type FileTreeNodeWrapperProps = Pick<
  FileTreeNodeProps,
  'entry' | 'depth' | 'onContextMenu' | 'onClick' | 'renderContextMenu'
>

function FileTreeNodeWrapper({
  entry,
  depth,
  onContextMenu,
  onClick,
  renderContextMenu
}: FileTreeNodeWrapperProps): React.JSX.Element {
  const isExpanded = useFileExplorerStore((state) => state.expandedDirs.has(entry.path))
  const selection = useFileExplorerStore((state): TreeRowSelection => {
    if (!state.selectedPaths.has(entry.path)) return 'none'
    return state.selectedPaths.size <= 1 || state.lastClickedPath === entry.path
      ? 'primary'
      : 'multi'
  })
  const isLoading = useFileExplorerStore((state) => state.loadingDirs.has(entry.path))
  const children = useFileExplorerStore((state) => state.directoryContents.get(entry.path))
  const isDir = entry.type === 'directory'
  // The guide of the folder that directly holds a selected row is brighter.
  const isGuideActive = useFileExplorerStore((state) => {
    if (!isDir || !state.expandedDirs.has(entry.path) || state.selectedPaths.size === 0) {
      return false
    }
    const dir = normalizeTreePath(entry.path)
    for (const selected of state.selectedPaths) {
      if (parentTreePath(selected) === dir) return true
    }
    return false
  })
  const git = useExplorerGitDecorationsContext()

  return (
    <FileTreeNode
      entry={entry}
      depth={depth}
      isExpanded={isExpanded}
      selection={selection}
      isLoading={isLoading}
      isGuideActive={isGuideActive}
      gitStatus={isDir ? undefined : git.getFileStatus(entry.path)}
      hasGitChanges={isDir ? git.isDirDirty(entry.path) : false}
      // biome-ignore lint/correctness/noChildrenProp: `children` is a typed directory-data prop, not React children
      children={children}
      onContextMenu={onContextMenu}
      onClick={onClick}
      renderContextMenu={renderContextMenu}
    />
  )
}

export { FileTreeNodeWrapper }
