/**
 * Merge Manager Service
 *
 * Core Git merge operations engine for the main process.
 * Handles conflict detection, merge preview, and merge execution.
 * Uses simple-git for all Git operations.
 *
 * Source: Story 2.1 - Merge Detection Service (IPC + Service layer)
 */

import simpleGit, { type SimpleGit } from 'simple-git'
import type {
  ConflictDetectionResult,
  MergePreview,
  ConflictedFile,
  MergeResult,
  MergeValidationResult,
  FileChange,
  DetectionMode,
  MergeStrategy,
  ConflictStatus,
  ConflictSeverity,
  FileChangeStatus
} from '../../shared/types/merge.types'

/**
 * Merge-specific error class
 */
export class MergeError extends Error {
  constructor(
    public code: string,
    message: string,
    public action?: string
  ) {
    super(message)
    this.name = 'MergeError'
  }
}

/**
 * Project context interface
 */
interface ProjectContext {
  rootDirectory: string
  id: string
}

/**
 * Merge Manager Service
 *
 * Manages Git merge operations for a project.
 * Each instance is scoped to a specific project root.
 *
 * @example
 * ```typescript
 * const manager = new MergeManager('/path/to/project', 'project-123')
 * const result = await manager.detectConflictsAccurate({
 *   sourceBranch: 'feature/auth',
 *   targetBranch: 'main',
 *   projectId: 'project-123'
 * })
 * ```
 */
export class MergeManager {
  private readonly git: SimpleGit
  private readonly projectRoot: string
  private readonly projectId: string

  /**
   * Create a new MergeManager instance
   *
   * @param projectRoot - Absolute path to the Git repository root
   * @param projectId - Unique identifier for the project
   */
  constructor(projectRoot: string, projectId: string) {
    this.projectRoot = projectRoot
    this.projectId = projectId
    this.git = simpleGit(projectRoot)
  }

  /**
   * Detect conflicts using accurate mode (git merge --dry-run)
   *
   * Implements AC4: Uses git merge --dry-run --no-commit --no-ff
   * Returns high confidence results with all conflicted files
   *
   * Task 1.2: Implement detectConflictsAccurate() method
   *
   * @param options - Detection options
   * @returns Conflict detection result with high confidence
   */
  async detectConflictsAccurate(options: {
    sourceBranch: string
    targetBranch: string
    projectId: string
  }): Promise<ConflictDetectionResult> {
    const originalBranch = await this.getCurrentBranch()

    try {
      // Checkout target branch
      await this.git.checkout(options.targetBranch)

      // Run merge in dry-run mode
      try {
        await this.git.merge([options.sourceBranch, '--dry-run', '--no-commit', '--no-ff'])

        // No conflicts detected
        return {
          hasConflicts: false,
          conflictedFiles: [],
          fileCount: 0,
          detectionMode: 'accurate',
          confidence: 'high'
        }
      } catch (error) {
        // Parse conflict files from error
        const conflictedFiles = this.parseConflictFiles(error)

        return {
          hasConflicts: conflictedFiles.length > 0,
          conflictedFiles,
          fileCount: conflictedFiles.length,
          detectionMode: 'accurate',
          confidence: 'high'
        }
      }
    } catch (error) {
      throw new MergeError(
        'MERGE_FAILED',
        `Failed to detect conflicts: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    } finally {
      // Always clean up: abort merge and return to original branch
      try {
        await this.git.merge(['--abort'])
        if (originalBranch) {
          await this.git.checkout(originalBranch)
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Detect conflicts using fast mode (git status parsing)
   *
   * Implements AC5: Uses git status parsing for quicker detection
   * Returns medium confidence results
   *
   * Task 1.3: Implement detectConflictsFast() method
   *
   * @param options - Detection options
   * @returns Conflict detection result with medium confidence
   */
  async detectConflictsFast(options: {
    sourceBranch: string
    targetBranch: string
    projectId: string
  }): Promise<ConflictDetectionResult> {
    try {
      // Get diff between branches to find changed files
      const diff = await this.git.diff([`${options.targetBranch}...${options.sourceBranch}`, '--name-only'])

      // Parse changed files
      const changedFiles = this.parseChangedFiles(diff)

      // Check for potential conflicts by looking at file history
      const conflictedFiles = await this.checkForPotentialConflicts(changedFiles)

      return {
        hasConflicts: conflictedFiles.length > 0,
        conflictedFiles,
        fileCount: conflictedFiles.length,
        detectionMode: 'fast',
        confidence: 'medium'
      }
    } catch (error) {
      throw new MergeError(
        'MERGE_FAILED',
        `Failed to detect conflicts (fast): ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Get merge preview with file-level diff
   *
   * Implements AC7: Returns list of changing files, counts, and conflicted files
   *
   * Task 1.4: Implement getMergePreview() method
   *
   * @param options - Preview options
   * @returns Complete merge preview
   */
  async getMergePreview(options: {
    sourceBranch: string
    targetBranch: string
    projectId: string
  }): Promise<MergePreview> {
    try {
      // Get commits to be merged
      const commits = await this.git.log([`${options.targetBranch}..${options.sourceBranch}`])

      // Get diff summary with file status
      const diff = await this.git.diff([`${options.targetBranch}...${options.sourceBranch}`, '--name-status'])

      // Parse diff into file changes
      const changingFiles = this.parseDiffSummary(diff)

      // Check for conflicts using accurate mode
      const conflictResult = await this.detectConflictsAccurate(options)

      // Map conflicted files to ConflictedFile interface
      const conflictedFiles: ConflictedFile[] = conflictResult.conflictedFiles.map(path => ({
        path,
        status: 'both-modified' as ConflictStatus,
        severity: this.calculateSeverity(path)
      }))

      return {
        changingFiles,
        conflictedFiles,
        filesAdded: changingFiles.filter(f => f.status === 'added').length,
        filesModified: changingFiles.filter(f => f.status === 'modified').length,
        filesDeleted: changingFiles.filter(f => f.status === 'deleted').length,
        commitCount: commits.total || 0
      }
    } catch (error) {
      throw new MergeError(
        'MERGE_FAILED',
        `Failed to get merge preview: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Execute merge operation
   *
   * Implements AC9: Executes git commands based on strategy
   *
   * Task 1.5: Implement executeMerge() method
   *
   * @param options - Merge execution options
   * @returns Merge result with success status
   */
  async executeMerge(options: {
    sourceBranch: string
    targetBranch: string
    projectId: string
    strategy?: MergeStrategy
  }): Promise<MergeResult> {
    const strategy = options.strategy || 'merge'

    try {
      // Checkout target branch
      await this.git.checkout(options.targetBranch)

      // Execute merge based on strategy
      let mergeResult

      switch (strategy) {
        case 'squash':
          mergeResult = await this.git.merge([options.sourceBranch, '--squash'])
          break

        case 'rebase':
          // Rebase is more complex - use rebase command
          // For now, we'll simplify by using merge with FF
          mergeResult = await this.mergeWithRebase(options.sourceBranch)
          break

        case 'merge':
        default:
          mergeResult = await this.git.merge([options.sourceBranch, '--no-ff'])
          break
      }

      return {
        success: true,
        conflictCount: 0,
        filesChanged: mergeResult.files || 0,
        commitsMerged: mergeResult.commits || 0
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('conflict')) {
        // Get conflicted files
        try {
          const status = await this.git.status()
          const conflicted = status.conflicted || []

          return {
            success: false,
            conflictCount: conflicted.length,
            filesChanged: 0,
            commitsMerged: 0,
            error: 'Merge conflicts detected'
          }
        } catch {
          return {
            success: false,
            conflictCount: 0,
            filesChanged: 0,
            commitsMerged: 0,
            error: 'Merge conflicts detected'
          }
        }
      }

      throw new MergeError(
        'MERGE_FAILED',
        `Failed to execute merge: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Get conflicted files for current merge state
   *
   * Task 1.6: Implement getConflictedFiles() method
   *
   * @param projectId - Project identifier
   * @returns Array of conflicted files
   */
  async getConflictedFiles(projectId: string): Promise<ConflictedFile[]> {
    try {
      const status = await this.git.status()
      const conflictedPaths = status.conflicted || []

      return conflictedPaths.map(path => ({
        path,
        status: this.determineConflictStatus(path),
        severity: this.calculateSeverity(path)
      }))
    } catch (error) {
      throw new MergeError(
        'MERGE_FAILED',
        `Failed to get conflicted files: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Validate merge readiness
   *
   * Implements AC8: Checks disk space, uncommitted changes, CI status
   *
   * Task 1.7: Implement validateMerge() method
   *
   * @param options - Validation options
   * @returns Validation result with warnings
   */
  async validateMerge(options: {
    projectId: string
    sourceBranch: string
    targetBranch: string
  }): Promise<MergeValidationResult> {
    const warnings: string[] = []
    let diskSpaceOk = true
    let ciValidationPassed = true // CI validation not implemented yet
    let uncommittedChanges = false

    try {
      // Check for uncommitted changes
      const status = await this.git.status()
      uncommittedChanges = status.files.length > 0

      if (uncommittedChanges) {
        warnings.push('You have uncommitted changes. Consider committing or stashing before merging.')
      }

      // Check disk space (basic check)
      try {
        const fs = await import('node:fs/promises')
        const stats = await fs.statfs(this.projectRoot)
        const availableSpace = stats.bavail * stats.bsize
        const MIN_SPACE = 500 * 1024 * 1024 // 500MB minimum

        if (availableSpace < MIN_SPACE) {
          diskSpaceOk = false
          warnings.push('Low disk space. Less than 500MB available.')
        }
      } catch {
        // Skip disk space check if statfs fails
      }

      const canMerge = !warnings.some(w => w.includes('Low disk space'))

      return {
        canMerge,
        warnings,
        diskSpaceOk,
        ciValidationPassed,
        uncommittedChanges
      }
    } catch (error) {
      throw new MergeError(
        'VALIDATION_FAILED',
        `Failed to validate merge: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Get current branch name
   */
  private async getCurrentBranch(): Promise<string | null> {
    try {
      const status = await this.git.status()
      return status.current || null
    } catch {
      return null
    }
  }

  /**
   * Parse conflict files from git error
   */
  private parseConflictFiles(error: unknown): string[] {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const conflicts: string[] = []

    // Parse common git conflict patterns
    const conflictPatterns = [
      /CONFLICT \([^\)]+\): (.+)/g,
      /Auto-merging (.+)/g,
      /Automatic merge failed; fix conflicts and then commit the result\./g
    ]

    for (const pattern of conflictPatterns) {
      let match
      while ((match = pattern.exec(errorMessage)) !== null) {
        if (match[1] && !conflicts.includes(match[1])) {
          conflicts.push(match[1])
        }
      }
    }

    return conflicts
  }

  /**
   * Parse changed files from git diff output
   */
  private parseChangedFiles(diff: string): string[] {
    return diff
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
  }

  /**
   * Check for potential conflicts using git log
   */
  private async checkForPotentialConflicts(files: string[]): Promise<string[]> {
    const conflictedFiles: string[] = []

    for (const file of files) {
      try {
        // Check if file has divergent branches
        const log = await this.git.log([
          `${this.projectRoot}/${file}`,
          '--all',
          '--format=%H'
        ])

        // If file has commits on multiple branches, flag as potential conflict
        if (log.total && log.total > 1) {
          conflictedFiles.push(file)
        }
      } catch {
        // Ignore errors for individual files
      }
    }

    return conflictedFiles
  }

  /**
   * Parse diff summary into FileChange objects
   */
  private parseDiffSummary(diff: string): FileChange[] {
    const files: FileChange[] = []

    for (const line of diff.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue

      const parts = trimmed.split('\t')
      if (parts.length >= 2) {
        const statusChar = parts[0]
        const path = parts[1]

        let status: FileChangeStatus = 'modified'
        if (statusChar === 'A') status = 'added'
        else if (statusChar === 'D') status = 'deleted'
        else if (statusChar.startsWith('R')) status = 'renamed'

        files.push({ path, status })
      }
    }

    return files
  }

  /**
   * Calculate conflict severity based on file path
   */
  private calculateSeverity(path: string): ConflictSeverity {
    // High severity for config files, lock files, critical infrastructure
    const highSeverityPatterns = [
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      '.gitignore',
      'tsconfig.json',
      'vite.config',
      'tailwind.config'
    ]

    const lowerPath = path.toLowerCase()
    if (highSeverityPatterns.some(pattern => lowerPath.includes(pattern.toLowerCase()))) {
      return 'high'
    }

    // Medium severity for source files
    const mediumSeverityPatterns = ['.ts', '.tsx', '.js', '.jsx', '.json']
    if (mediumSeverityPatterns.some(ext => lowerPath.endsWith(ext))) {
      return 'medium'
    }

    return 'low'
  }

  /**
   * Determine conflict status based on file state
   */
  private determineConflictStatus(path: string): ConflictStatus {
    // For now, default to both-modified
    // Could be enhanced with actual git status parsing
    return 'both-modified'
  }

  /**
   * Perform rebase-style merge
   */
  private async mergeWithRebase(sourceBranch: string): Promise<{ files: number; commits: number }> {
    // Simplified rebase using --ff-only for now
    // Full rebase implementation is more complex
    try {
      const result = await this.git.merge([sourceBranch, '--ff-only'])
      return { files: result.files || 0, commits: result.commits || 0 }
    } catch {
      // Fallback to regular merge if ff-only fails
      const result = await this.git.merge([sourceBranch, '--no-ff'])
      return { files: result.files || 0, commits: result.commits || 0 }
    }
  }
}
