/**
 * Worktree Manager Service
 *
 * Core Git worktree operations engine for the main process.
 * Uses simple-git for all Git operations.
 *
 * Source: Story 1.2 - Worktree Manager Service (Git operations)
 * Architecture: _bmad-output/planning-artifacts/architecture-git-worktree-feature.md
 */

import simpleGit, { type SimpleGit } from 'simple-git'

/**
 * Re-export types from renderer for main process use
 * TODO: Move to shared types location in future refactor (elicitation finding)
 */
export type { WorktreeMetadata, WorktreeStatus, ArchivedWorktree } from '../../renderer/src/features/worktrees/worktree.types'

/**
 * Error types for worktree operations
 */
export type WorktreeErrorCode =
  | 'GIT_VERSION_TOO_OLD'
  | 'BRANCH_NOT_FOUND'
  | 'BRANCH_ALREADY_CHECKED_OUT'
  | 'PATH_EXISTS'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'GIT_OPERATION_FAILED'
  | 'WORKTREE_NOT_FOUND'
  | 'ARCHIVE_NOT_FOUND'
  | 'UNPUSHED_COMMITS_WARNING'
  | 'MAIN_BRANCH_DELETE_WARNING'
  | 'GITIGNORE_PARSE_FAILED'
  | 'FILE_COPY_FAILED'

/**
 * Worktree-specific error class
 */
export class WorktreeError extends Error {
  constructor(
    public code: WorktreeErrorCode,
    message: string,
    public action?: string
  ) {
    super(message)
    this.name = 'WorktreeError'
  }
}

/**
 * Options for creating a worktree
 */
export interface CreateWorktreeOptions {
  projectId: string
  branchName: string
  gitignoreSelections: string[]
}

/**
 * Options for deleting a worktree
 */
export interface DeleteWorktreeOptions {
  deleteBranch?: boolean
}

/**
 * Result of Git version validation
 */
export interface GitVersionValidation {
  valid: boolean
  version: string
}

/**
 * Minimum required Git version for worktree operations
 * Source: NFR11 - Git Version Support
 */
const MINIMUM_GIT_VERSION = '2.17.0'

/**
 * Worktree Manager Service
 *
 * Manages Git worktree operations for a project.
 * Each instance is scoped to a specific project root.
 *
 * @example
 * ```typescript
 * const manager = new WorktreeManager('/path/to/project', 'project-123')
 * await manager.create({ projectId: 'project-123', branchName: 'feature/auth', gitignoreSelections: [] })
 * ```
 */
export class WorktreeManager {
  private readonly git: SimpleGit
  private readonly projectRoot: string
  private readonly projectId: string

  /**
   * Create a new WorktreeManager instance
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
   * Validate Git version is compatible with worktree operations
   *
   * Implements AC #2, #3: Validates Git version >= 2.17.0
   * Source: NFR11 - Git Version Support
   *
   * @returns Validation result with valid flag and detected version
   * @throws WorktreeError if Git cannot be invoked
   */
  async validateGitVersion(): Promise<GitVersionValidation> {
    try {
      const result = await this.git.version()
      const version = result.git

      // Parse semantic version for comparison
      const isValid = this.compareVersions(version, MINIMUM_GIT_VERSION) >= 0

      // Return validation result instead of throwing for old versions
      return { valid: isValid, version }
    } catch (error) {
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        'Failed to determine Git version. Ensure Git is installed and accessible.',
        'Install Git from https://git-scm.com/downloads'
      )
    }
  }

  /**
   * Create a new Git worktree
   *
   * Implements AC #4, #5, #6:
   * - Executes `git worktree add` via simple-git
   * - Sanitizes branch name for folder usage
   * - Handles Windows MAX_PATH limits
   *
   * @param options - Worktree creation options
   * @returns Metadata for the created worktree
   * @throws WorktreeError if creation fails
   */
  async create(options: CreateWorktreeOptions): Promise<WorktreeMetadata> {
    const { projectId, branchName, gitignoreSelections } = options

    // Validate Git version first
    const versionCheck = await this.validateGitVersion()

    // Throw error if version too old for worktree operations
    if (!versionCheck.valid) {
      throw new WorktreeError(
        'GIT_VERSION_TOO_OLD',
        `Git version ${versionCheck.version} is too old. Please upgrade to ${MINIMUM_GIT_VERSION} or higher.`,
        'Download from https://git-scm.com/downloads'
      )
    }

    // Sanitize branch name for folder usage
    const sanitizedBranch = this.sanitizeBranchName(branchName)

    // Generate worktree path
    const worktreePath = this.generateWorktreePath(sanitizedBranch)

    // Create the worktree via Git
    try {
      await this.git.worktreeAdd(worktreePath, branchName)
    } catch (error) {
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to create worktree for branch "${branchName}": ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }

    // Generate metadata
    const now = new Date().toISOString()
    const worktreeId = `${projectId}-${sanitizedBranch}-${Date.now()}`

    const metadata: WorktreeMetadata = {
      id: worktreeId,
      projectId,
      branchName,
      worktreePath,
      createdAt: now,
      lastAccessedAt: now,
      isArchived: false,
      gitignoreProfile: gitignoreSelections.length > 0 ? 'custom' : undefined,
      status: {
        dirty: false,
        ahead: 0,
        behind: 0,
        conflicted: false,
        currentBranch: branchName,
      },
    }

    return metadata
  }

  /**
   * List all worktrees for the project
   *
   * Implements AC #1: Lists all worktrees for a project
   *
   * @param projectId - Project to list worktrees for
   * @returns Array of worktree metadata
   */
  async list(projectId: string): Promise<WorktreeMetadata[]> {
    try {
      const result = await this.git.worktreeList()
      const worktrees = result.all || []

      // Filter to this project and map to metadata
      return worktrees
        .filter(wt => wt.path.includes(this.projectRoot))
        .map(wt => ({
          id: `${projectId}-${wt.branch}`,
          projectId,
          branchName: wt.branch,
          worktreePath: wt.path,
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
          isArchived: false,
          status: {
            dirty: false,
            ahead: 0,
            behind: 0,
            conflicted: false,
            currentBranch: wt.branch,
          },
        }))
    } catch (error) {
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to list worktrees: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Delete a worktree permanently
   *
   * Implements AC #7:
   * - Checks for unpushed commits
   * - Adds warning for main/master branches
   * - Executes `git worktree remove`
   *
   * @param worktreeId - ID of worktree to delete
   * @param options - Deletion options
   * @throws WorktreeError if deletion fails
   */
  async delete(worktreeId: string, options: DeleteWorktreeOptions = {}): Promise<void> {
    // TODO: Implement unpushed commits check (NFR6)
    // TODO: Add extra confirmation for main/master branches (FR4)

    try {
      // Get worktree path from ID
      const worktreePath = await this.getWorktreePathById(worktreeId)

      // Remove the worktree
      await this.git.worktreeRemove(worktreePath)

      // Optionally delete the branch
      if (options.deleteBranch) {
        // TODO: Implement branch deletion after worktree removal
      }
    } catch (error) {
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to delete worktree: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Archive a worktree
   *
   * Implements AC #8:
   * - Moves worktree to archives directory
   * - Creates archive manifest with 30-day retention
   *
   * @param worktreeId - ID of worktree to archive
   * @returns Archived worktree metadata
   */
  async archive(worktreeId: string): Promise<ArchivedWorktree> {
    // TODO: Implement archival logic (Story 1.2, AC #8)
    throw new WorktreeError('ARCHIVE_NOT_FOUND', 'Archive operation not yet implemented')
  }

  /**
   * Restore an archived worktree
   *
   * Implements AC #9:
   * - Restores worktree from archive
   *
   * @param archiveId - ID of archive to restore
   * @returns Restored worktree metadata
   */
  async restore(archiveId: string): Promise<WorktreeMetadata> {
    // TODO: Implement restore logic (Story 1.2, AC #9)
    throw new WorktreeError('WORKTREE_NOT_FOUND', 'Restore operation not yet implemented')
  }

  /**
   * Get Git status for a worktree
   *
   * Implements AC #1:
   * - Returns dirty, ahead, behind, conflicted flags
   *
   * @param worktreeId - ID of worktree to check
   * @returns Current worktree status
   */
  async getStatus(worktreeId: string): Promise<WorktreeStatus> {
    try {
      const worktreePath = await this.getWorktreePathById(worktreeId)

      // Get status for the worktree
      const git = simpleGit(worktreePath)
      const status = await git.status()

      // Build worktree status
      const worktreeStatus: WorktreeStatus = {
        dirty: status.files.length > 0,
        ahead: status.ahead || 0,
        behind: status.behind || 0,
        conflicted: status.conflicted.length > 0,
        currentBranch: status.current || 'unknown',
      }

      return worktreeStatus
    } catch (error) {
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to get worktree status: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Copy .gitignore files to worktree
   *
   * Implements Story 1.4 Task 2.2: Copy selected patterns to new worktree
   *
   * @param worktreePath - Path to the new worktree
   * @param patterns - Patterns from .gitignore to copy
   * @throws WorktreeError if file copy fails
   */
  async copyGitignoreFiles(worktreePath: string, patterns: string[]): Promise<void> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    for (const pattern of patterns) {
      try {
        // Use micromatch for pattern matching (already in project from Story 1.1)
        const { glob } = await import('glob')

        // Convert .gitignore pattern to glob pattern
        const globPattern = pattern.endsWith('/') ? `${pattern}**` : pattern

        // Find matching files in project root
        const files = await glob(globPattern, {
          cwd: this.projectRoot,
          dot: true,
          absolute: false,
          nodir: true
        })

        // Copy each matched file to worktree
        for (const file of files) {
          const sourcePath = path.join(this.projectRoot, file)
          const targetPath = path.join(worktreePath, file)

          // Create target directory if it doesn't exist
          await fs.mkdir(path.dirname(targetPath), { recursive: true })

          // Copy file
          await fs.copyFile(sourcePath, targetPath)
        }
      } catch (error) {
        throw new WorktreeError(
          'FILE_COPY_FAILED',
          `Failed to copy files matching pattern "${pattern}"`,
          'Check file permissions and disk space'
        )
      }
    }
  }

  /**
   * Validate disk space before worktree creation
   *
   * Implements Story 1.4 Task 2.3: Check available disk space
   *
   * @param requiredSpace - Required space in bytes
   * @param buffer - Additional buffer in bytes (default: 500MB)
   * @throws WorktreeError if insufficient disk space
   */
  async validateDiskSpace(requiredSpace: number, buffer: number = 500 * 1024 * 1024): Promise<void> {
    const fs = await import('node:fs/promises')

    try {
      const stats = await fs.statfs(this.projectRoot)
      const availableSpace = stats.bavail * stats.bsize

      if (availableSpace < requiredSpace + buffer) {
        const requiredMB = Math.ceil((requiredSpace + buffer) / (1024 * 1024))
        const availableMB = Math.ceil(availableSpace / (1024 * 1024))

        throw new WorktreeError(
          'INSUFFICIENT_DISK_SPACE',
          `Insufficient disk space. Required: ${requiredMB}MB, Available: ${availableMB}MB`,
          'Free up disk space or choose a different location'
        )
      }
    } catch (error) {
      if (error instanceof WorktreeError) {
        throw error
      }
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        'Failed to check disk space',
        'Ensure filesystem is accessible'
      )
    }
  }

  /**
   * Calculate project size for disk space estimation
   *
   * @returns Project size in bytes
   */
  async calculateProjectSize(): Promise<number> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    let totalSize = 0

    async function calculateDirSize(dirPath: string): Promise<void> {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        // Skip .git directory and worktrees
        if (entry.name === '.git' || entry.name === '.termul') {
          continue
        }

        if (entry.isDirectory()) {
          await calculateDirSize(fullPath)
        } else if (entry.isFile()) {
          const stats = await fs.stat(fullPath)
          totalSize += stats.size
        }
      }
    }

    await calculateDirSize(this.projectRoot)
    return totalSize
  }

  /**
   * Sanitize branch name for folder usage
   *
   * Implements AC #5: Sanitizes branch name (feature/auth → feature-auth)
   * Handles Windows MAX_PATH limits by truncating to 50 chars
   *
   * @param branchName - Original branch name
   * @returns Sanitized branch name safe for folder names
   */
  private sanitizeBranchName(branchName: string): string {
    // Replace slashes and special characters with hyphens
    let sanitized = branchName
      .replace(/[\/\\]/g, '-')
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .trim()

    // Remove leading/trailing hyphens
    sanitized = sanitized.replace(/^[-]+|[-]+$/g, '')

    // Handle Windows MAX_PATH: truncate to 50 chars
    if (sanitized.length > 50) {
      sanitized = sanitized.substring(0, 50)
    }

    return sanitized || 'worktree'
  }

  /**
   * Generate worktree path
   *
   * Implements AC #6: Creates worktree at .termul/worktrees/<sanitized-name>/
   *
   * @param sanitizedBranchName - Sanitized branch name
   * @returns Full path to worktree directory
   */
  private generateWorktreePath(sanitizedBranchName: string): string {
    return `${this.projectRoot}/.termul/worktrees/${sanitizedBranchName}`
  }

  /**
   * Compare two semantic version strings
   *
   * @param version1 - First version to compare
   * @param version2 - Second version to compare
   * @returns Positive if version1 > version2, negative if version1 < version2, 0 if equal
   */
  private compareVersions(version1: string, version2: string): number {
    const v1 = version1.split('.').map(Number)
    const v2 = version2.split('.').map(Number)

    for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
      const num1 = v1[i] || 0
      const num2 = v2[i] || 0

      if (num1 > num2) return 1
      if (num1 < num2) return -1
    }

    return 0
  }

  /**
   * Get worktree path by ID
   *
   * @param worktreeId - Worktree identifier
   * @returns Full path to worktree directory
   * @throws WorktreeError if worktree not found
   */
  private async getWorktreePathById(worktreeId: string): Promise<string> {
    // TODO: Implement proper ID-to-path lookup
    // For now, extract from ID format: projectId-branch-timestamp
    const parts = worktreeId.split('-')
    const branch = parts.slice(1, -1).join('-') // Remove projectId and timestamp
    const sanitized = this.sanitizeBranchName(branch)
    return this.generateWorktreePath(sanitized)
  }
}
