/**
 * WorktreeItem Component
 *
 * Displays a single worktree with branch name, status badges, and action buttons.
 * Source: Story 1.5 - Task 1: Create WorktreeItem Component
 */

import { memo, useState, useCallback } from 'react'
import { Circle, ArrowUp, ArrowDown, AlertTriangle, MoreVertical, Clock, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorktreeStatus } from '@/stores/worktree-store'
import { FreshnessIndicator } from './FreshnessIndicator'
import type { WorktreeMetadata } from '../../worktree.types'

export interface WorktreeItemProps {
  worktree: WorktreeMetadata
  isActive: boolean
  onSelect: (worktreeId: string) => void
  showFreshness?: boolean
  onContextMenu?: (e: React.MouseEvent, worktree: WorktreeMetadata) => void
  isBulkSelectMode?: boolean
  isSelected?: boolean
  onToggleSelection?: (worktreeId: string) => void
  onOpenTerminal?: (worktreeId: string, worktreePath: string, branchName: string) => void
}

/**
 * StatusBadge - Displays individual status indicator with icon and optional count
 */
interface StatusBadgeProps {
  type: 'dirty' | 'ahead' | 'behind' | 'conflicted'
  count?: number
  className?: string
}

function StatusBadge({ type, count, className }: StatusBadgeProps) {
  const baseStyles = 'flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium'

  const variants = {
    dirty: {
      className: 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
      icon: Circle,
      label: 'dirty',
      ariaLabel: 'Has uncommitted changes',
    },
    ahead: {
      className: 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
      icon: ArrowUp,
      label: count ? `${count} ahead` : 'ahead',
      ariaLabel: `${count} commits ahead of remote`,
    },
    behind: {
      className: 'bg-gray-500/20 text-gray-600 dark:text-gray-400',
      icon: ArrowDown,
      label: count ? `${count} behind` : 'behind',
      ariaLabel: `${count} commits behind remote`,
    },
    conflicted: {
      className: 'bg-red-500/20 text-red-600 dark:text-red-400',
      icon: AlertTriangle,
      label: 'conflicted',
      ariaLabel: 'Has merge conflicts',
    },
  }

  const variant = variants[type]
  const Icon = variant.icon

  return (
    <span
      className={cn(baseStyles, variant.className, className)}
      aria-label={variant.ariaLabel}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {count !== undefined && count > 0 && (
        <span className="sr-only">{variant.label}</span>
      )}
      {count !== undefined && count > 0 && (
        <span aria-hidden="true">{count}</span>
      )}
    </span>
  )
}

/**
 * WorktreeItem - Main component for displaying a worktree in the sidebar
 */
export const WorktreeItem = memo(({
  worktree,
  isActive,
  onSelect,
  showFreshness = false,
  onContextMenu,
  isBulkSelectMode = false,
  isSelected = false,
  onToggleSelection,
  onOpenTerminal
}: WorktreeItemProps) => {
  const status = useWorktreeStatus(worktree.id)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    onContextMenu?.(e, worktree)
  }, [worktree, onContextMenu])

  const handleClick = useCallback(() => {
    if (isBulkSelectMode && onToggleSelection) {
      onToggleSelection(worktree.id)
    } else {
      onSelect(worktree.id)
      // Auto-open terminal when clicking worktree (Story 3.6)
      onOpenTerminal?.(worktree.id, worktree.worktreePath, worktree.branchName)
    }
  }, [isBulkSelectMode, onToggleSelection, onSelect, onOpenTerminal, worktree.id, worktree.worktreePath, worktree.branchName])

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
        isActive && !isBulkSelectMode && 'bg-accent',
        isSelected && isBulkSelectMode && 'bg-purple-500/10 border border-purple-500/20'
      )}
    >
      {/* Checkbox for bulk selection */}
      {isBulkSelectMode && (
        <div className="flex-shrink-0">
          <div className={cn(
            'w-4 h-4 rounded border flex items-center justify-center transition-colors',
            isSelected
              ? 'bg-purple-500 border-purple-500'
              : 'border-border bg-background'
          )}>
            {isSelected && <Check className="w-3 h-3 text-white" />}
          </div>
        </div>
      )}

      {/* Branch name and freshness */}
      <div className="flex-1 min-w-0 flex flex-col">
        <span className="truncate text-sm font-medium">
          {worktree.branchName}
        </span>
        {showFreshness && (
          <FreshnessIndicator
            lastAccessedAt={worktree.lastAccessedAt}
            className="text-[10px]"
            showIcon={false}
            variant="minimal"
          />
        )}
      </div>

      {/* Status badges */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {status?.conflicted && <StatusBadge type="conflicted" />}
        {status?.dirty && <StatusBadge type="dirty" />}
        {status && status.ahead > 0 && <StatusBadge type="ahead" count={status.ahead} />}
        {status && status.behind > 0 && <StatusBadge type="behind" count={status.behind} />}
      </div>

      {/* Action menu button indicator */}
      {!isBulkSelectMode && (
        <MoreVertical className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" aria-hidden="true" />
      )}
    </button>
  )
})

WorktreeItem.displayName = 'WorktreeItem'
