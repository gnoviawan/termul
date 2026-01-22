/**
 * Worktree feature type definitions
 *
 * Renderer-specific types for worktree state management and UI components.
 * Shared IPC types are defined in src/shared/types/ipc.types.ts
 */

/**
 * Worktree status from Git operations
 * Runtime-only data - NOT persisted to disk
 */
export interface WorktreeStatus {
  dirty: boolean
  ahead: number
  behind: number
  conflicted: boolean
  currentBranch: string
  updatedAt?: number // Timestamp for cache invalidation
}

/**
 * Worktree metadata persisted to disk
 */
export interface WorktreeMetadata {
  id: string
  projectId: string
  branchName: string
  worktreePath: string
  createdAt: string
  lastAccessedAt: string
  isArchived: boolean
  gitignoreProfile?: string
}

/**
 * Archived worktree metadata
 */
export interface ArchivedWorktree {
  originalPath: string
  archivePath: string
  archivedAt: string
  expiresAt: string
  branchName: string
  projectId: string
  unpushedCommits: boolean
  commitCount: number
}

/**
 * Configuration for creating a new worktree
 */
export interface CreateWorktreeConfig {
  branchName: string
  gitignoreSelections: string[]
  projectPath: string
}


/**
 * Options for deleting a worktree
 */
export interface DeleteWorktreeOptions {
  force?: boolean
  deleteBranch?: boolean
}

/**
 * Worktree status filter for UI
 */
export type WorktreeStatusFilter = 'all' | 'active' | 'archived' | 'dirty'
