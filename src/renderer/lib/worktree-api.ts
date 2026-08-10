import type {
  BranchInfo,
  DirtyStatus,
  GitignoreDir,
  IpcResult,
  RemoveResult,
  SymlinkResult,
  WorktreeInfo
} from '@shared/types/ipc.types'
import { invoke } from '@tauri-apps/api/core'
import type { Worktree } from '@/types/project'
import { isTauriContext } from './tauri-runtime'

export interface MergePreviewInfo {
  direction: string
  sourceBranch: string
  targetBranch: string
  conflictFiles: {
    path: string
    severity: string
    conflictCount: number
    isLockFile: boolean
    suggestions: {
      strategy: string
      confidence: string
      reason: string
      description: string
    }[]
  }[]
  changedFiles: string[]
  totalChanges: number
  detectionMode: string
  hasAutoResolvable: boolean
}

/**
 * Origin-aware default base branch + detached-HEAD guard (CAP-2). The launcher
 * uses `defaultBase` as the initial base-branch picker value; `isDetached`
 * forces an explicit pick before a worktree launch.
 */
export interface BaseBranchInfo {
  defaultBase: string
  currentBranch?: string
  isDetached: boolean
}

/**
 * Result of `.worktree-include` carry-over (CAP-5). `ran` is the number of
 * patterns that matched at least one file; `copied` is files actually copied;
 * `skipped` carries per-file reasons (symlink / path-escape / already-present).
 */
export interface IncludeSkipReason {
  path: string
  reason: string
}

export interface IncludeCopyResult {
  ran: number
  copied: number
  skipped: IncludeSkipReason[]
}

/**
 * Invoke a worktree Tauri command, returning the `IpcResult<T>` shape callers
 * expect. On web/remote mode (`!isTauriContext()`), returns an explicit
 * `WEB_UNSUPPORTED` result instead of letting the stubbed `invoke()` reject
 * with `tauriUnavailable` — worktree mutation is desktop-only until a
 * separate product/security decision.
 */
async function worktreeInvoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<IpcResult<T>> {
  if (!isTauriContext()) {
    return {
      success: false,
      error: 'Worktrees are not available in the web client',
      code: 'WEB_UNSUPPORTED'
    }
  }
  return invoke<IpcResult<T>>(command, args)
}

export const worktreeApi = {
  /**
   * List all worktrees for a git repo at the given path.
   * Filters out bare worktrees and detached-HEAD worktrees.
   */
  list: (projectPath: string): Promise<IpcResult<WorktreeInfo[]>> =>
    worktreeInvoke<WorktreeInfo[]>('worktree_list', { projectPath }),

  /**
   * Create a new worktree.
   * If isNewBranch is true, creates a new branch from the startRef (or HEAD).
   * If branch exists, checks it out in the new worktree.
   * targetPath defaults to `<project-path>/.termul/worktrees/<name>/` when not provided.
   */
  create: (params: {
    projectPath: string
    name: string
    branch: string
    isNewBranch: boolean
    startRef?: string
    targetPath?: string
  }): Promise<IpcResult<WorktreeInfo>> => worktreeInvoke<WorktreeInfo>('worktree_create', params),

  /**
   * Remove a worktree. Uses --force if force=true.
   * Runs `git worktree prune` after removal.
   * `projectPath` is the repository root; git runs there so the worktree
   * metadata can be located.
   */
  remove: (projectPath: string, worktreePath: string, force: boolean): Promise<IpcResult<void>> =>
    worktreeInvoke<void>('worktree_remove', { projectPath, worktreePath, force }),

  /**
   * List local and remote branches for a git repo.
   */
  branches: (projectPath: string): Promise<IpcResult<BranchInfo[]>> =>
    worktreeInvoke<BranchInfo[]>('worktree_branches', { projectPath }),

  /**
   * Check dirty status for a worktree checkout.
   * Returns summary of uncommitted changes.
   */
  checkDirty: (worktreePath: string): Promise<IpcResult<DirtyStatus>> =>
    worktreeInvoke<DirtyStatus>('worktree_check_dirty', { worktreePath }),

  /**
   * Remove all Termul-managed worktrees for a project.
   * Used during project cascade delete. Reports per-worktree results.
   * Accepts a typed Worktree array; serializes to JSON internally.
   */
  removeAllManaged: (
    projectPath: string,
    worktrees: Worktree[]
  ): Promise<IpcResult<RemoveResult[]>> =>
    worktreeInvoke<RemoveResult[]>('worktree_remove_all_managed', {
      projectPath,
      worktreesJson: JSON.stringify(worktrees)
    }),

  /**
   * Parse .gitignore and return directory entries that could be symlinked.
   * Each entry includes whether the directory exists in the project root.
   */
  parseGitignore: (projectPath: string): Promise<IpcResult<GitignoreDir[]>> =>
    worktreeInvoke<GitignoreDir[]>('worktree_parse_gitignore', { projectPath }),

  /**
   * Create symlinks from project root directories into a worktree.
   * symlinkDirs is a JSON array of directory names to symlink.
   */
  createSymlinks: (
    projectPath: string,
    worktreePath: string,
    symlinkDirs: string[]
  ): Promise<IpcResult<SymlinkResult[]>> =>
    worktreeInvoke<SymlinkResult[]>('worktree_create_symlinks', {
      projectPath,
      worktreePath,
      symlinkDirs: JSON.stringify(symlinkDirs)
    }),

  /**
   * Ensure symlinks exist for all directories in symlinkDirs.
   * Creates any missing symlinks. Does not remove or overwrite existing ones.
   */
  ensureSymlinks: (
    projectPath: string,
    worktreePath: string,
    symlinkDirs: string[]
  ): Promise<IpcResult<SymlinkResult[]>> =>
    worktreeInvoke<SymlinkResult[]>('worktree_ensure_symlinks', {
      projectPath,
      worktreePath,
      symlinkDirs: JSON.stringify(symlinkDirs)
    }),

  /**
   * Archive a worktree by moving it to `.termul/archives/<name>-<timestamp>/`.
   * The worktree is recoverable until the 30-day retention expires.
   */
  archive: (projectPath: string, worktreePath: string): Promise<IpcResult<void>> =>
    worktreeInvoke<void>('worktree_archive', { projectPath, worktreePath }),

  /**
   * Restore an archived worktree back to its original location.
   */
  restore: (projectPath: string, archivePath: string): Promise<IpcResult<void>> =>
    worktreeInvoke<void>('worktree_restore', { projectPath, archivePath }),

  /**
   * Generate a merge preview for a worktree against a target branch.
   */
  mergePreview: (
    worktreePath: string,
    targetBranch: string
  ): Promise<IpcResult<MergePreviewInfo>> =>
    worktreeInvoke<MergePreviewInfo>('worktree_merge_preview', { worktreePath, targetBranch }),

  /**
   * Execute a merge from the worktree's current branch to target_branch.
   */
  mergeExecute: (worktreePath: string, targetBranch: string): Promise<IpcResult<string>> =>
    worktreeInvoke<string>('worktree_merge_execute', { worktreePath, targetBranch }),

  /**
   * Resolve the default base branch for a new chat worktree (CAP-2). Returns
   * the origin/HEAD default with a `main`/`master`/current fallback chain and
   * a detached-HEAD flag so the launcher can force a base pick.
   */
  resolveBaseBranch: (projectPath: string): Promise<IpcResult<BaseBranchInfo>> =>
    worktreeInvoke<BaseBranchInfo>('worktree_resolve_base_branch', { projectPath }),

  /**
   * Carry over untracked files listed in `.worktree-include` into a fresh
   * worktree (CAP-5). Symlink/path-escape/already-present defenses run per
   * file; the result reports `ran`/`copied`/`skipped` with per-file reasons.
   */
  copyIncludeFiles: (
    projectPath: string,
    worktreePath: string
  ): Promise<IpcResult<IncludeCopyResult>> =>
    worktreeInvoke<IncludeCopyResult>('worktree_copy_include_files', {
      projectPath,
      worktreePath
    })
}
