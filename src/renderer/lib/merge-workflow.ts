/**
 * Merge workflow types and conflict detection logic.
 *
 * Provides types for merge workflows, conflict preview,
 * and merge step management.
 */

export type MergeDirection = 'worktree-to-main' | 'main-to-worktree'

export type ConflictSeverity = 'low' | 'medium' | 'high'

export type DetectionMode = 'fast' | 'accurate'

export interface ConflictFile {
  path: string
  severity: ConflictSeverity
  /** Number of conflicting sections */
  conflictCount: number
  /** Whether the conflict is in a lock file (low priority) */
  isLockFile: boolean
}

export interface MergePreview {
  direction: MergeDirection
  sourceBranch: string
  targetBranch: string
  /** Files that may conflict */
  conflictFiles: ConflictFile[]
  /** Files that will change without conflict */
  changedFiles: string[]
  /** Total file count */
  totalChanges: number
  /** Detection mode used */
  detectionMode: DetectionMode
}

export type MergeStep = 'preview' | 'resolve' | 'confirm' | 'executing' | 'complete' | 'failed'

export interface MergeWorkflowState {
  step: MergeStep
  preview: MergePreview | null
  error: string | null
}

/**
 * Create initial merge workflow state.
 */
export function createInitialMergeState(): MergeWorkflowState {
  return {
    step: 'preview',
    preview: null,
    error: null
  }
}

/**
 * Advance to the next step in the merge workflow.
 */
export function advanceMergeStep(current: MergeStep, hasConflicts: boolean): MergeStep {
  switch (current) {
    case 'preview':
      return hasConflicts ? 'resolve' : 'confirm'
    case 'resolve':
      return 'confirm'
    case 'confirm':
      return 'executing'
    case 'executing':
      return 'complete'
    default:
      return current
  }
}

/**
 * Determine severity of a conflict based on file type.
 */
export function getFileConflictSeverity(filePath: string): ConflictSeverity {
  // Lock files and generated files are low severity
  if (
    filePath.endsWith('.lock') ||
    filePath.includes('package-lock') ||
    filePath.includes('yarn.lock')
  ) {
    return 'low'
  }
  // Config files are medium severity
  if (filePath.endsWith('.json') || filePath.endsWith('.yaml') || filePath.endsWith('.toml')) {
    return 'medium'
  }
  // Source code files are high severity
  return 'high'
}
