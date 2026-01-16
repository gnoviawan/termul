/**
 * FreshnessIndicator Component
 *
 * Displays relative time since last worktree access.
 * Shows visual cues for stale worktrees to help with cleanup decisions.
 * Source: Story 1.5 - Task 5: Create FreshnessIndicator Component
 */

import { memo } from 'react'
import { Clock, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FreshnessIndicatorProps {
  lastAccessedAt: string
  className?: string
  showIcon?: boolean
  variant?: 'text' | 'badge' | 'minimal'
}

/**
 * Calculate freshness label from last accessed timestamp
 */
function getFreshnessLabel(lastAccessedAt: string): string {
  const lastAccessed = new Date(lastAccessedAt)
  const now = new Date()
  const diffMs = now.getTime() - lastAccessed.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffMinutes = Math.floor(diffMs / (1000 * 60))

  if (diffMinutes < 1) return 'Just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return `${Math.floor(diffDays / 30)}mo ago`
}

/**
 * Get freshness level for visual styling
 */
function getFreshnessLevel(lastAccessedAt: string): 'recent' | 'stale' | 'very-stale' {
  const lastAccessed = new Date(lastAccessedAt)
  const now = new Date()
  const diffMs = now.getTime() - lastAccessed.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 3) return 'recent'
  if (diffDays < 14) return 'stale'
  return 'very-stale'
}

/**
 * Get full description for tooltip
 */
function getFullDescription(lastAccessedAt: string): string {
  const lastAccessed = new Date(lastAccessedAt)
  const freshnessLabel = getFreshnessLabel(lastAccessedAt)
  return `Last worked: ${freshnessLabel} (${lastAccessed.toLocaleDateString()})`
}

/**
 * FreshnessIndicator - Shows relative time with visual cues
 */
export const FreshnessIndicator = memo(({
  lastAccessedAt,
  className,
  showIcon = true,
  variant = 'text'
}: FreshnessIndicatorProps) => {
  const freshnessLabel = getFreshnessLabel(lastAccessedAt)
  const freshnessLevel = getFreshnessLevel(lastAccessedAt)
  const fullDescription = getFullDescription(lastAccessedAt)

  const levelStyles = {
    recent: 'text-muted-foreground',
    stale: 'text-muted-foreground/80',
    'very-stale': 'text-muted-foreground/60'
  }

  const icon = freshnessLevel === 'very-stale' ? AlertCircle : Clock

  if (variant === 'minimal') {
    return (
      <span
        className={cn('text-xs', levelStyles[freshnessLevel], className)}
        title={fullDescription}
      >
        {freshnessLabel}
      </span>
    )
  }

  if (variant === 'badge') {
    const badgeStyles = {
      recent: 'bg-green-500/10 text-green-600 dark:text-green-400',
      stale: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
      'very-stale': 'bg-red-500/10 text-red-600 dark:text-red-400'
    }

    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
          badgeStyles[freshnessLevel],
          className
        )}
        title={fullDescription}
      >
        {showIcon && <icon className="h-3 w-3" aria-hidden="true" />}
        <span>{freshnessLabel}</span>
      </span>
    )
  }

  // Default: text variant
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        levelStyles[freshnessLevel],
        className
      )}
      title={fullDescription}
    >
      {showIcon && <icon className="h-3 w-3" aria-hidden="true" />}
      <span className="sr-only">{fullDescription}</span>
      <span aria-hidden="true">{freshnessLabel}</span>
    </span>
  )
})

FreshnessIndicator.displayName = 'FreshnessIndicator'
