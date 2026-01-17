/**
 * WorktreeItem Component
 *
 * Displays a single worktree with branch name, status dots, and action buttons.
 * Source: Story 1.5 - Task 1: Create WorktreeItem Component
 */

import { memo, useCallback, useMemo } from 'react'
import { MoreVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorktreeStatus } from '@/stores/worktree-store'
import type { WorktreeMetadata, WorktreeStatus } from '../../worktree.types'

export interface WorktreeItemProps {
  worktree: WorktreeMetadata
  isActive: boolean
  onSelect: (worktreeId: string) => void
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>, worktree: WorktreeMetadata) => void
  onOpenTerminal?: (worktreeId: string, worktreePath: string, branchName: string) => void
}

/**
 * StatusDots - Displays worktree status as simple colored dots
 */
interface StatusDotsProps {
  status: WorktreeStatus | undefined
}

function StatusDots({ status }: StatusDotsProps) {
  if (!status) return null

  // Generate status description for accessibility
  const getStatusLabel = (): string => {
    const states: string[] = []
    if (status.conflicted) states.push('conflicted')
    if (status.dirty) states.push('dirty')
    if (status.ahead > 0) states.push(`${status.ahead} ahead`)
    if (status.behind > 0) states.push(`${status.behind} behind`)

    return states.length > 0 ? states.join(', ') : 'clean'
  }

  // Memoize dots array to prevent unnecessary re-renders
  const dots = useMemo(() => {
    const newDots: React.ReactNode[] = []
    if (status.conflicted) newDots.push(<span key="conflict" className="w-1.5 h-1.5 rounded-full bg-red-500" aria-hidden="true" />)
    if (status.dirty) newDots.push(<span key="dirty" className="w-1.5 h-1.5 rounded-full bg-orange-400" aria-hidden="true" />)
    if (status.ahead > 0) newDots.push(<span key="ahead" className="w-1.5 h-1.5 rounded-full bg-yellow-500" aria-hidden="true" />)
    if (status.behind > 0) newDots.push(<span key="behind" className="w-1.5 h-1.5 rounded-full bg-cyan-500" aria-hidden="true" />)

    // Show green dot for clean status (no dirty, no conflicts, ahead=0, behind=0)
    if (newDots.length === 0) {
      newDots.push(<span key="clean" className="w-1.5 h-1.5 rounded-full bg-green-500" aria-hidden="true" />)
    }

    return newDots
  }, [status.conflicted, status.dirty, status.ahead, status.behind])

  return (
    <div
      role="group"
      aria-label={`Status: ${getStatusLabel()}`}
      className="flex gap-1"
    >
      {dots}
    </div>
  )
}

/**
 * WorktreeItem - Main component for displaying a worktree in the sidebar
 */
export const WorktreeItem = memo(({
  worktree,
  isActive,
  onSelect,
  onContextMenu,
  onOpenTerminal
}: WorktreeItemProps) => {
  const status = useWorktreeStatus(worktree.id)

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onContextMenu?.(e, worktree)
  }, [worktree, onContextMenu])

  const handleClick = useCallback(() => {
    onSelect(worktree.id)
    // Auto-open terminal when clicking worktree (Story 3.6)
    onOpenTerminal?.(worktree.id, worktree.worktreePath, worktree.branchName)
  }, [onSelect, onOpenTerminal, worktree.id, worktree.worktreePath, worktree.branchName])

  // Generate status description for accessibility
  const getStatusDescription = (): string => {
    if (!status) return 'unknown'

    const states: string[] = []
    if (status.dirty) states.push('dirty')
    if (status.ahead > 0) states.push(`${status.ahead} ahead`)
    if (status.behind > 0) states.push(`${status.behind} behind`)
    if (status.conflicted) states.push('conflicted')

    return states.length > 0 ? states.join(', ') : 'clean'
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleClick()
    }
  }

  const ariaLabel = `Worktree ${worktree.branchName}, status: ${getStatusDescription()}`

  return (
    <button
      type="button"
      role="button"
      aria-label={ariaLabel}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      className={cn(
        'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-left transition-colors',
        'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive && 'bg-accent'
      )}
    >
      {/* Branch name */}
      <span className="flex-1 min-w-0 truncate text-sm font-medium">
        {worktree.branchName}
      </span>

      {/* Status dots */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <StatusDots status={status} />
      </div>

      {/* Action menu button indicator */}
      <MoreVertical className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" aria-hidden="true" />
    </button>
  )
})

WorktreeItem.displayName = 'WorktreeItem'
