/**
 * Worktree feature types
 *
 * Defines data structures for Git worktree management, including:
 * - Active worktree metadata
 * - Git status tracking
 * - Archived worktree information
 */

/**
 * Metadata for an active Git worktree
 * Stored in: <project-root>/.termul/worktrees.json
 */
export interface WorktreeMetadata {
  /** Unique identifier for this worktree */
  id: string

  /** Project this worktree belongs to */
  projectId: string

  /** Original Git branch name (e.g., "feature/auth") */
  branchName: string

  /** Filesystem path to the worktree directory */
  worktreePath: string

  /** ISO timestamp when worktree was created */
  createdAt: string

  /** ISO timestamp of last access/activity */
  lastAccessedAt: string

  /** Whether this worktree is archived (soft delete) */
  isArchived: boolean

  /** Optional .gitignore pattern profile name */
  gitignoreProfile?: string

  /** Current Git status of the worktree */
  status: WorktreeStatus
}

/**
 * Git status information for a worktree
 */
export type WorktreeStatus = {
  /** Whether working directory has uncommitted changes */
  dirty: boolean

  /** Number of commits ahead of upstream */
  ahead: number

  /** Number of commits behind upstream */
  behind: number

  /** Whether merge/rebase conflicts exist */
  conflicted: boolean

  /** Name of the currently checked-out branch */
  currentBranch: string
}

/**
 * Metadata for an archived worktree
 * Archives are stored in: .termul/archives/
 * Retention period: 30 days
 */
export interface ArchivedWorktree {
  /** Original path to the worktree before archiving */
  originalPath: string

  /** Path where the archive is stored */
  archivePath: string

  /** ISO timestamp when worktree was archived */
  archivedAt: string

  /** ISO timestamp when archive expires (for cleanup) */
  expiresAt: string

  /** Branch name this worktree was tracking */
  branchName: string

  /** Project this worktree belonged to */
  projectId: string

  /** Whether worktree had unpushed commits when archived */
  unpushedCommits: boolean

  /** Number of commits in the worktree when archived */
  commitCount: number
}
