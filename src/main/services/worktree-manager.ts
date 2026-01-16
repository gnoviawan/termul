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
import { execSync } from 'node:child_process'
import type { ArchivedWorktree, WorktreeMetadata, WorktreeStatus } from '../../shared/types/ipc.types'

/**
 * Find Git executable path on the system
 * On Windows, the main process may not have PATH set correctly
 */

function findGitExecutable(): string | undefined {
  try {
    // Try to find git using 'where' command on Windows
    const gitPath = execSync('where git', { encoding: 'utf-8' }).trim().split('\n')[0]
    console.log('[WorktreeManager] Found Git at:', gitPath)
    return gitPath
  } catch {
    // Fallback to common Windows Git installation paths
    const commonPaths = [
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe'
    ]
    for (const path of commonPaths) {
      try {
        execSync(`"${path}" --version`, { encoding: 'utf-8' })
        console.log('[WorktreeManager] Found Git at common path:', path)
        return path
      } catch {
        // Continue to next path
      }
    }
    console.warn('[WorktreeManager] Could not find Git executable')
    return undefined
  }
}

// Cache the Git executable path
let GIT_EXECUTABLE: string | undefined = findGitExecutable()



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
 * Archive manifest structure
 */
interface ArchiveManifest {
  archives: ArchivedWorktree[]
  version: number
}

/**
 * Create archive manifest if it doesn't exist
 */
async function ensureArchiveManifest(projectRoot: string): Promise<ArchiveManifest> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const manifestPath = path.join(projectRoot, '.termul', 'archives', 'archive-manifest.json')

  try {
    const content = await fs.readFile(manifestPath, 'utf-8')
    return JSON.parse(content) as ArchiveManifest
  } catch {
    // Create new manifest if it doesn't exist
    const manifest: ArchiveManifest = {
      archives: [],
      version: 1
    }

    // Ensure archives directory exists
    await fs.mkdir(path.join(projectRoot, '.termul', 'archives'), { recursive: true })
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    return manifest
  }
}

/**
 * Save archive manifest
 */
async function saveArchiveManifest(projectRoot: string, manifest: ArchiveManifest): Promise<void> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const manifestPath = path.join(projectRoot, '.termul', 'archives', 'archive-manifest.json')
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
}

/**
 * Check for unpushed commits in a worktree
 */
async function checkUnpushedCommits(worktreePath: string): Promise<{ hasUnpushed: boolean; count: number }> {
  const simpleGit = await import('simple-git')
  const git = simpleGit.default(worktreePath)

  try {
    const status = await git.status()
    const unpushedCount = status.ahead || 0

    return {
      hasUnpushed: unpushedCount > 0,
      count: unpushedCount
    }
  } catch {
    return { hasUnpushed: false, count: 0 }
  }
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

    // Try to use explicit Git path, but fall back to default if not found
    const gitConfig: any = {
      baseDir: projectRoot,
      timeout: { block: 10000 }
    }

    // Only set explicit git path if we found one successfully
    if (GIT_EXECUTABLE) {
      gitConfig.git = GIT_EXECUTABLE
      console.log('[WorktreeManager] Using explicit Git path:', GIT_EXECUTABLE)
    } else {
      console.log('[WorktreeManager] Using system PATH to find Git')
    }

    this.git = simpleGit(gitConfig)
    console.log('[WorktreeManager] Initialized with projectRoot:', projectRoot)
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
      console.log('[WorktreeManager] validateGitVersion - projectRoot:', this.projectRoot)
      const result = await this.git.version()
      console.log('[WorktreeManager] Raw version() result:', result)

      // simple-git v3.x returns { major, minor, patch, agent, installed }
      // simple-git v2.x returns { git: "version string" }
      let version = ''


      if ((result as any).major !== undefined) {
        // Newer format (v3.x)
        const { major, minor, patch } = result as { major: number; minor: number; patch: number }
        version = `${major}.${minor}.${patch}`
      } else if ((result as any).git) {
        // Older format (v2.x)
        version = (result as any).git
      } else if ((result as any).version) {
        version = (result as any).version
      } else if ((result as any).stdout) {
        version = (result as any).stdout
      } else if (typeof result === 'string') {
        version = result
      }

      console.log('[WorktreeManager] Extracted version:', version)

      if (!version) {
        throw new Error('Could not extract version from git --version output')
      }

      // Clean up version string (remove 'git version ' prefix if present)
      const cleanVersion = version.replace(/^git version\s+/i, '').trim()
      console.log('[WorktreeManager] Cleaned version:', cleanVersion)

      // Parse semantic version for comparison
      const isValid = this.compareVersions(cleanVersion, MINIMUM_GIT_VERSION) >= 0
      console.log('[WorktreeManager] Version check - valid:', isValid, 'detected:', cleanVersion, 'required:', MINIMUM_GIT_VERSION)

      // Return validation result instead of throwing for old versions
      return { valid: isValid, version: cleanVersion }
    } catch (error) {
      console.error('[WorktreeManager] validateGitVersion error:', error)
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

    console.log('[WorktreeManager] create - projectRoot:', this.projectRoot, 'projectId:', projectId, 'branchName:', branchName)

    // Validate Git version first
    const versionCheck = await this.validateGitVersion()
    console.log('[WorktreeManager] create - versionCheck:', versionCheck)

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
      // simple-git v3.x doesn't have worktree methods, use raw() with git worktree add
      // Use -b flag to create new branch if it doesn't exist
      const createResult = await this.git.raw(['worktree', 'add', '-b', branchName, worktreePath])
      console.log('[WorktreeManager] worktree add result:', createResult)
    } catch (error) {
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to create worktree for branch "${branchName}": ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }

    // Generate metadata
    const now = new Date().toISOString()
    const worktreeId = `${projectId}-${sanitizedBranch}`

    const metadata: WorktreeMetadata = {
      id: worktreeId,
      projectId,
      branchName,
      worktreePath,
      createdAt: now,
      lastAccessedAt: now,
      isArchived: false,
      gitignoreProfile: gitignoreSelections.length > 0 ? 'custom' : undefined
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
      // simple-git v3.x doesn't have worktree methods, use raw() with git worktree list
      // Output format: "worktree /path/to/worktree branch_name"
      const rawOutput = await this.git.raw(['worktree', 'list', '--porcelain'])

      // Parse porcelain output (more reliable than parsing default format)
      const lines = rawOutput.split('\n')
      const worktrees: Array<{ path: string; branch: string }> = []
      let currentPath: string | null = null

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (line.startsWith('worktree ')) {
          currentPath = line.substring('worktree '.length).trim()
          continue
        }

        if (line.startsWith('branch ') && currentPath) {
          const branchRef = line.substring('branch '.length).trim()
          const branch = branchRef.replace('refs/heads/', '')
          worktrees.push({ path: currentPath, branch })
          currentPath = null
          continue
        }

        if (!line) {
          currentPath = null
        }
      }

       // Filter to this project and map to metadata
       const nowIso = new Date().toISOString()
       const normalizedProjectRoot = this.projectRoot.replace(/\\/g, '/').toLowerCase()

       const projectWorktrees = worktrees.filter((wt) => {
         const normalizedPath = wt.path.replace(/\\/g, '/').toLowerCase()
         return normalizedPath.startsWith(normalizedProjectRoot)
       })

       return projectWorktrees.map(wt => {
         const sanitizedBranch = this.sanitizeBranchName(wt.branch)
         return {
           id: `${projectId}-${sanitizedBranch}`,
           projectId,
           branchName: wt.branch,
           worktreePath: wt.path,
           createdAt: nowIso,
           lastAccessedAt: nowIso,
           isArchived: false
         }
       })

       console.log('[WorktreeManager] list projectRoot:', this.projectRoot, 'total:', worktrees.length, 'filtered:', projectWorktrees.length)

       return projectWorktrees.map(wt => {
         const sanitizedBranch = this.sanitizeBranchName(wt.branch)
         return {
           id: `${projectId}-${sanitizedBranch}`,
           projectId,
           branchName: wt.branch,
           worktreePath: wt.path,
           createdAt: nowIso,
           lastAccessedAt: nowIso,
           isArchived: false
         }
       })
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

      // simple-git v3.x doesn't have worktreeRemove(), use raw() with git worktree remove
      await this.git.raw(['worktree', 'remove', worktreePath])

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
   * Story 1.6 - Task 1.3: Implement archive operation
   *
   * @param worktreeId - ID of worktree to archive
   * @returns Archived worktree metadata
   */
  async archive(worktreeId: string): Promise<ArchivedWorktree> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    try {
      // Get worktree path from ID
      const worktreePath = await this.getWorktreePathById(worktreeId)

      // Check if worktree exists
      try {
        await fs.access(worktreePath)
      } catch {
        throw new WorktreeError('WORKTREE_NOT_FOUND', `Worktree not found at path: ${worktreePath}`)
      }

      // Get worktree metadata
      const worktrees = await this.list(this.projectId)
      const worktree = worktrees.find(w => w.id === worktreeId)

      if (!worktree) {
        throw new WorktreeError('WORKTREE_NOT_FOUND', `Worktree with ID ${worktreeId} not found`)
      }

      // Check for unpushed commits
      const unpushedInfo = await checkUnpushedCommits(worktreePath)

      // Generate archive path: .termul/archives/<sanitized-branch-name>-<timestamp>/
      const timestamp = Date.now()
      const sanitizedBranch = this.sanitizeBranchName(worktree.branchName)
      const archiveDirName = `${sanitizedBranch}-${timestamp}`
      const archivePath = path.join(this.projectRoot, '.termul', 'archives', archiveDirName)

      // Ensure archives directory exists
      await fs.mkdir(path.join(this.projectRoot, '.termul', 'archives'), { recursive: true })

      // Move worktree to archive path
      await fs.rename(worktreePath, archivePath)

      // Calculate expiration date (30 days from now)
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + 30)

      // Create archived worktree metadata
      const archivedWorktree: ArchivedWorktree = {
        originalPath: worktreePath,
        archivePath,
        archivedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        branchName: worktree.branchName,
        projectId: this.projectId,
        unpushedCommits: unpushedInfo.hasUnpushed,
        commitCount: unpushedInfo.count
      }

      // Update archive manifest
      const manifest = await ensureArchiveManifest(this.projectRoot)
      manifest.archives.push(archivedWorktree)
      await saveArchiveManifest(this.projectRoot, manifest)

      return archivedWorktree
    } catch (error) {
      if (error instanceof WorktreeError) {
        throw error
      }
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to archive worktree: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Restore an archived worktree
   *
   * Implements AC #9:
   * - Restores worktree from archive
   *
   * Story 1.6 - Task 2.3: Implement restore functionality
   *
   * @param archiveId - ID of archive to restore (branch name from archive)
   * @returns Restored worktree metadata
   */
  async restore(archiveId: string): Promise<WorktreeMetadata> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    try {
      // Load archive manifest
      const manifest = await ensureArchiveManifest(this.projectRoot)
      const archive = manifest.archives.find(a => a.branchName === archiveId || a.archivePath.endsWith(archiveId))

      if (!archive) {
        throw new WorktreeError('ARCHIVE_NOT_FOUND', `Archive ${archiveId} not found`)
      }

      // Check if archive is expired
      const expiresAt = new Date(archive.expiresAt)
      const now = new Date()

      if (now > expiresAt) {
        throw new WorktreeError('ARCHIVE_NOT_FOUND', `Archive ${archiveId} has expired and was cleaned up`)
      }

      // Check if original path already exists
      try {
        await fs.access(archive.originalPath)
        throw new WorktreeError('PATH_EXISTS', `Cannot restore: worktree already exists at ${archive.originalPath}`)
      } catch {
        // Path doesn't exist, which is good
      }

      // Move archive back to original location
      await fs.rename(archive.archivePath, archive.originalPath)

      // Remove from manifest
      const updatedManifest = {
        ...manifest,
        archives: manifest.archives.filter(a => a !== archive)
      }
      await saveArchiveManifest(this.projectRoot, updatedManifest)

      // Return worktree metadata
      const nowIso = new Date().toISOString()
     const sanitizedBranch = this.sanitizeBranchName(archive.branchName)
     const worktreeMetadata: WorktreeMetadata = {
        id: `${this.projectId}-${sanitizedBranch}`,
        projectId: this.projectId,
        branchName: archive.branchName,
        worktreePath: archive.originalPath,
        createdAt: archive.archivedAt,
        lastAccessedAt: nowIso,
        isArchived: false
      }


      return worktreeMetadata
    } catch (error) {
      if (error instanceof WorktreeError) {
        throw error
      }
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to restore worktree: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * List all archived worktrees for a project
   *
   * Story 1.6 - Task 2.1: Create ArchiveManagementPanel component
   *
   * @returns Array of archived worktree metadata
   */
  async listArchived(): Promise<ArchivedWorktree[]> {
    try {
      const manifest = await ensureArchiveManifest(this.projectRoot)

      // Filter out expired archives
      const now = new Date()
      const validArchives = manifest.archives.filter(archive => {
        const expiresAt = new Date(archive.expiresAt)
        return expiresAt > now
      })

      return validArchives
    } catch (error) {
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to list archived worktrees: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Delete an archive permanently
   *
   * Story 1.6 - Task 2: Archive Management UI
   *
   * @param archiveId - ID of archive to delete (branch name)
   */
  async deleteArchive(archiveId: string): Promise<void> {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    try {
      // Load archive manifest
      const manifest = await ensureArchiveManifest(this.projectRoot)
      const archive = manifest.archives.find(a => a.branchName === archiveId || a.archivePath.endsWith(archiveId))

      if (!archive) {
        throw new WorktreeError('ARCHIVE_NOT_FOUND', `Archive ${archiveId} not found`)
      }

      // Delete archive directory
      await fs.rm(archive.archivePath, { recursive: true, force: true })

      // Remove from manifest
      const updatedManifest = {
        ...manifest,
        archives: manifest.archives.filter(a => a !== archive)
      }
      await saveArchiveManifest(this.projectRoot, updatedManifest)
    } catch (error) {
      if (error instanceof WorktreeError) {
        throw error
      }
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to delete archive: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Cleanup expired archives
   *
   * Story 1.6 - Task 2.4: Add auto-cleanup for archives older than 30 days
   *
   * @returns Number of archives cleaned up
   */
  async cleanupExpiredArchives(): Promise<number> {
    const fs = await import('node:fs/promises')

    try {
      const manifest = await ensureArchiveManifest(this.projectRoot)
      const now = new Date()

      const expiredArchives = manifest.archives.filter(archive => {
        const expiresAt = new Date(archive.expiresAt)
        return expiresAt <= now
      })

      // Delete expired archive directories
      for (const archive of expiredArchives) {
        await fs.rm(archive.archivePath, { recursive: true, force: true })
      }

      // Update manifest to remove expired archives
      if (expiredArchives.length > 0) {
        const updatedManifest = {
          ...manifest,
          archives: manifest.archives.filter(archive => {
            const expiresAt = new Date(archive.expiresAt)
            return expiresAt > now
          })
        }
        await saveArchiveManifest(this.projectRoot, updatedManifest)
      }

      return expiredArchives.length
    } catch (error) {
      throw new WorktreeError(
        'GIT_OPERATION_FAILED',
        `Failed to cleanup expired archives: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
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
        // @ts-expect-error glob types are unavailable in node tsconfig
        const { glob } = await import('glob') as { glob: (pattern: string, options: { cwd: string; dot: boolean; absolute: boolean; nodir: boolean }) => Promise<string[]> }

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
    // For now, extract from ID format: projectId-branch
    const parts = worktreeId.split('-')
    const branch = parts.slice(1).join('-')
    const sanitized = this.sanitizeBranchName(branch)
    return this.generateWorktreePath(sanitized)
  }

}
