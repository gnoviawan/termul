/**
 * Merge Types
 *
 * Type definitions for merge operations and conflict detection.
 * Source: Story 2.1 - Merge Detection Service (IPC + Service layer)
 */

/**
 * Detection mode for conflict detection
 * - accurate: Uses git merge --dry-run (slower but comprehensive)
 * - fast: Uses git status parsing (quicker but may miss edge cases)
 */
export type DetectionMode = 'accurate' | 'fast'

/**
 * Merge strategy options
 */
export type MergeStrategy = 'merge' | 'squash' | 'rebase'

/**
 * Conflict status for a file
 */
export type ConflictStatus = 'both-modified' | 'deleted-by-them' | 'deleted-by-us'

/**
 * Severity level for conflicts
 */
export type ConflictSeverity = 'high' | 'medium' | 'low'

/**
 * Confidence level for conflict detection
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low'

/**
 * File change status in merge
 */
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'

/**
 * Result of conflict detection operation
 */
export interface ConflictDetectionResult {
  hasConflicts: boolean
  conflictedFiles: string[]
  fileCount: number
  detectionMode: DetectionMode
  confidence: ConfidenceLevel
}

/**
 * Individual file change in merge
 */
export interface FileChange {
  path: string
  status: FileChangeStatus
}

/**
 * Individual conflicted file
 */
export interface ConflictedFile {
  path: string
  status: ConflictStatus
  severity: ConflictSeverity
}

/**
 * Complete merge preview with all changes
 */
export interface MergePreview {
  changingFiles: FileChange[]
  conflictedFiles: ConflictedFile[]
  filesAdded: number
  filesModified: number
  filesDeleted: number
  commitCount: number
}

/**
 * Result of merge execution
 */
export interface MergeResult {
  success: boolean
  conflictCount: number
  filesChanged: number
  commitsMerged: number
  error?: string
}

/**
 * Merge validation result
 */
export interface MergeValidationResult {
  canMerge: boolean
  warnings: string[]
  diskSpaceOk: boolean
  ciValidationPassed: boolean
  uncommittedChanges: boolean
}

/**
 * User preferences for merge operations
 */
export interface MergePreference {
  detectionMode: DetectionMode
  strategy?: MergeStrategy
}

// ============================================================================
// DTOs for IPC Communication
// ============================================================================

/**
 * DTO for conflict detection request
 */
export interface DetectConflictsDto {
  projectId: string
  sourceBranch: string
  targetBranch: string
  mode: DetectionMode
}

/**
 * DTO for merge preview request
 */
export interface MergePreviewDto {
  projectId: string
  sourceBranch: string
  targetBranch: string
}

/**
 * DTO for execute merge request
 */
export interface ExecuteMergeDto {
  projectId: string
  sourceBranch: string
  targetBranch: string
  strategy?: MergeStrategy
}

/**
 * DTO for merge validation request
 */
export interface ValidateMergeDto {
  projectId: string
  sourceBranch: string
  targetBranch: string
}

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Merge operation error codes
 */
export const MergeErrorCode = {
  GIT_NOT_FOUND: 'GIT_NOT_FOUND',
  REPOSITORY_NOT_FOUND: 'REPOSITORY_NOT_FOUND',
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  MERGE_CONFLICTS: 'MERGE_CONFLICTS',
  MERGE_FAILED: 'MERGE_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INSUFFICIENT_DISK_SPACE: 'INSUFFICIENT_DISK_SPACE',
  UNCOMMITTED_CHANGES: 'UNCOMMITTED_CHANGES'
} as const

export type MergeErrorCodeType = (typeof MergeErrorCode)[keyof typeof MergeErrorCode]
