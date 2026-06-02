/**
 * Worktree status types for status polling and badge display.
 */

export type WorktreeHealthStatus =
  | 'clean' // No issues
  | 'dirty' // Uncommitted changes
  | 'ahead' // Commits not pushed
  | 'behind' // Remote commits not pulled
  | 'conflicted' // Merge conflicts detected

export interface WorktreeStatus {
  worktreeId: string
  health: WorktreeHealthStatus
  /** Number of modified files (uncommitted) */
  modified: number
  /** Number of staged files */
  staged: number
  /** Number of untracked files */
  untracked: number
  /** Number of conflicts (if conflicted) */
  conflictCount: number
  /** Timestamp of last status check */
  lastChecked: number
  /** Timestamp of last user activity in this worktree */
  lastAccessed: number | null
  /** CI status placeholder for future integration */
  ciStatus: 'unknown' | 'passing' | 'failing' | 'running'
}

/**
 * Get human-readable label for a health status.
 */
export function getHealthLabel(status: WorktreeHealthStatus): string {
  switch (status) {
    case 'clean':
      return 'Clean'
    case 'dirty':
      return 'Dirty'
    case 'ahead':
      return 'Ahead'
    case 'behind':
      return 'Behind'
    case 'conflicted':
      return 'Conflicted'
  }
}

/**
 * Get color class suffix for a health status.
 * These are used for badge styling with both color and text for accessibility.
 */
export function getHealthColorClass(status: WorktreeHealthStatus): string {
  switch (status) {
    case 'clean':
      return 'bg-green-500'
    case 'dirty':
      return 'bg-yellow-500'
    case 'ahead':
      return 'bg-blue-500'
    case 'behind':
      return 'bg-orange-500'
    case 'conflicted':
      return 'bg-red-500'
  }
}

/**
 * Get icon/emoji for a health status (for color-blind accessibility).
 */
export function getHealthIcon(status: WorktreeHealthStatus): string {
  switch (status) {
    case 'clean':
      return '✅'
    case 'dirty':
      return '🟡'
    case 'ahead':
      return '🔵'
    case 'behind':
      return '🟠'
    case 'conflicted':
      return '🔴'
  }
}

/**
 * Get a relative time string from a timestamp.
 * Returns human-readable strings like "2 days ago", "3 weeks ago".
 */
export function getRelativeTime(timestamp: number | null): string {
  if (!timestamp) return ''

  const now = Date.now()
  const diffMs = now - timestamp
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)
  const diffWeek = Math.floor(diffDay / 7)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  if (diffWeek < 5) return `${diffWeek}w ago`
  return `${Math.floor(diffDay / 30)}mo ago`
}

/**
 * Check if a worktree is stale (not accessed in 30+ days).
 */
export function isWorktreeStale(lastAccessed: number | null): boolean {
  if (!lastAccessed) return false
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  return Date.now() - lastAccessed > thirtyDaysMs
}
