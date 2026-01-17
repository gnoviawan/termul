/**
 * WorktreeList Component
 *
 * Renders list of worktrees with virtualization for performance.
 * Source: Story 1.5 - Task 2: Create WorktreeList Component
 */

import { useRef, useEffect } from 'react'
import { WorktreeItem } from './WorktreeItem'
import type { WorktreeMetadata } from '../../worktree.types'

export interface WorktreeListProps {
  worktrees: WorktreeMetadata[]
  selectedWorktreeId: string | null
  onWorktreeSelect: (worktreeId: string) => void
  isLoading?: boolean
  isEmpty?: boolean
  showFreshness?: boolean
  onWorktreeContextMenu?: (e: React.MouseEvent, worktree: WorktreeMetadata) => void
  isBulkSelectMode?: boolean
  selectedWorktrees?: Set<string>
  onToggleSelection?: (worktreeId: string) => void
  onOpenTerminal?: (worktreeId: string, worktreePath: string, branchName: string) => void
}

/**
 * WorktreeList - Displays list of worktrees with keyboard navigation
 */
export function WorktreeList({
  worktrees,
  selectedWorktreeId,
  onWorktreeSelect,
  isLoading = false,
  isEmpty = false,
  showFreshness = false,
  onWorktreeContextMenu,
  isBulkSelectMode = false,
  selectedWorktrees,
  onToggleSelection,
  onOpenTerminal
}: WorktreeListProps) {
  const listRef = useRef<HTMLUListElement>(null)
  const selectedIndex = worktrees.findIndex((w) => w.id === selectedWorktreeId)

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (worktrees.length === 0) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        const nextIndex = Math.min(selectedIndex + 1, worktrees.length - 1)
        if (nextIndex >= 0) {
          onWorktreeSelect(worktrees[nextIndex].id)
        }
        break

      case 'ArrowUp':
        e.preventDefault()
        const prevIndex = Math.max(selectedIndex - 1, 0)
        if (prevIndex >= 0 && prevIndex < worktrees.length) {
          onWorktreeSelect(worktrees[prevIndex].id)
        }
        break

      case 'Home':
        e.preventDefault()
        if (worktrees.length > 0) {
          onWorktreeSelect(worktrees[0].id)
        }
        break

      case 'End':
        e.preventDefault()
        if (worktrees.length > 0) {
          onWorktreeSelect(worktrees[worktrees.length - 1].id)
        }
        break

      case 'Enter':
      case ' ':
        if (selectedWorktreeId) {
          e.preventDefault()
          onWorktreeSelect(selectedWorktreeId)
        }
        break
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement
      selectedItem?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedIndex])

  // Empty state
  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
        <p className="text-sm text-muted-foreground">
          No worktrees yet. Create your first worktree to get started.
        </p>
      </div>
    )
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Worktrees"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="space-y-1"
    >
      {worktrees.map((worktree) => (
        <li key={worktree.id} role="presentation">
          <WorktreeItem
            worktree={worktree}
            isActive={worktree.id === selectedWorktreeId}
            onSelect={onWorktreeSelect}
            showFreshness={showFreshness}
            onContextMenu={onWorktreeContextMenu}
            isBulkSelectMode={isBulkSelectMode}
            isSelected={selectedWorktrees?.has(worktree.id) ?? false}
            onToggleSelection={onToggleSelection}
            onOpenTerminal={onOpenTerminal}
          />
        </li>
      ))}
    </ul>
  )
}
