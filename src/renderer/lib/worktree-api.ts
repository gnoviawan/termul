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
import { webServerWorktree } from './web-server-api'

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
 * expect. On web/remote mode (`!isTauriContext()`), the 7 launch-flow methods
 * (list/create/remove/branches/checkDirty/resolveBaseBranch/copyIncludeFiles)
 * branch to `webServerWorktree` (HTTP routes in `web/worktree_api.rs`) — CAP —
 * Web worktree parity. The 8 advanced ops (symlinks, parseGitignore, merge,
 * archive/restore, removeAllManaged) STAY `WEB_UNSUPPORTED` on web (deferred —
 * see deferred-work.md). Transport/parse failures on the HTTP path map to
 * `{ success: false, code: 'NETWORK_ERROR' }` (handled in `web-server-api.ts`).
 */
async function worktreeInvoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<IpcResult<T>> {
  if (!isTauriContext()) {
    // The 7 launch-flow methods branch to webServerWorktree in their own
    // facade methods (below). This fallback is only hit by the 8 advanced
    // ops that stay WEB_UNSUPPORTED on web.
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
    isTauriContext()
      ? invoke<IpcResult<WorktreeInfo[]>>('worktree_list', { projectPath })
      : webServerWorktree.list(projectPath),

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
  }): Promise<IpcResult<WorktreeInfo>> =>
    isTauriContext()
      ? invoke<IpcResult<WorktreeInfo>>('worktree_create', params)
      : webServerWorktree.create(params),

  /**
   * Remove a worktree. Uses --force if force=true.
   * Runs `git worktree prune` after removal.
   * `projectPath` is the repository root; git runs there so the worktree
   * metadata can be located.
   */
  remove: (projectPath: string, worktreePath: string, force: boolean): Promise<IpcResult<void>> =>
    isTauriContext()
      ? invoke<IpcResult<void>>('worktree_remove', { projectPath, worktreePath, force })
      : webServerWorktree.remove(projectPath, worktreePath, force),

  /**
   * List local and remote branches for a git repo.
   */
  branches: (projectPath: string): Promise<IpcResult<BranchInfo[]>> =>
    isTauriContext()
      ? invoke<IpcResult<BranchInfo[]>>('worktree_branches', { projectPath })
      : webServerWorktree.branches(projectPath),

  /**
   * Check dirty status for a worktree checkout.
   * Returns summary of uncommitted changes.
   */
  checkDirty: (worktreePath: string): Promise<IpcResult<DirtyStatus>> =>
    isTauriContext()
      ? invoke<IpcResult<DirtyStatus>>('worktree_check_dirty', { worktreePath })
      : webServerWorktree.checkDirty(worktreePath),

  /**
   * Remove all Termul-managed worktrees for a project.
   * Used during project cascade delete. Reports per-worktree results.
   * Accepts a typed Worktree array; serializes to JSON internally.
   *
   * **Web:** returns `WEB_UNSUPPORTED` (deferred — see deferred-work.md).
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
   *
   * **Web:** returns `WEB_UNSUPPORTED` (deferred — see deferred-work.md).
   */
  parseGitignore: (projectPath: string): Promise<IpcResult<GitignoreDir[]>> =>
    worktreeInvoke<GitignoreDir[]>('worktree_parse_gitignore', { projectPath }),

  /**
   * Create symlinks from project root directories into a worktree.
   * symlinkDirs is a JSON array of directory names to symlink.
   *
   * **Web:** returns `WEB_UNSUPPORTED` (deferred — see deferred-work.md).
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
   *
   * **Web:** returns `WEB_UNSUPPORTED` (deferred — see deferred-work.md).
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
   *
   * **Web:** returns `WEB_UNSUPPORTED` (deferred — see deferred-work.md).
   */
  archive: (projectPath: string, worktreePath: string): Promise<IpcResult<void>> =>
    worktreeInvoke<void>('worktree_archive', { projectPath, worktreePath }),

  /**
   * Restore an archived worktree back to its original location.
   *
   * **Web:** returns `WEB_UNSUPPORTED` (deferred — see deferred-work.md).
   */
  restore: (projectPath: string, archivePath: string): Promise<IpcResult<void>> =>
    worktreeInvoke<void>('worktree_restore', { projectPath, archivePath }),

  /**
   * Generate a merge preview for a worktree against a target branch.
   *
   * **Web:** returns `WEB_UNSUPPORTED` (deferred — see deferred-work.md).
   */
  mergePreview: (
    worktreePath: string,
    targetBranch: string
  ): Promise<IpcResult<MergePreviewInfo>> =>
    worktreeInvoke<MergePreviewInfo>('worktree_merge_preview', { worktreePath, targetBranch }),

  /**
   * Execute a merge from the worktree's current branch to target_branch.
   *
   * **Web:** returns `WEB_UNSUPPORTED` (deferred — see deferred-work.md).
   */
  mergeExecute: (worktreePath: string, targetBranch: string): Promise<IpcResult<string>> =>
    worktreeInvoke<string>('worktree_merge_execute', { worktreePath, targetBranch }),

  /**
   * Resolve the default base branch for a new chat worktree (CAP-2). Returns
   * the origin/HEAD default with a `main`/`master`/current fallback chain and
   * a detached-HEAD flag so the launcher can force a base pick.
   */
  resolveBaseBranch: (projectPath: string): Promise<IpcResult<BaseBranchInfo>> =>
    isTauriContext()
      ? invoke<IpcResult<BaseBranchInfo>>('worktree_resolve_base_branch', { projectPath })
      : webServerWorktree.resolveBaseBranch(projectPath),

  /**
   * Carry over untracked files listed in `.worktree-include` into a fresh
   * worktree (CAP-5). Symlink/path-escape/already-present defenses run per
   * file; the result reports `ran`/`copied`/`skipped` with per-file reasons.
   */
  copyIncludeFiles: (
    projectPath: string,
    worktreePath: string
  ): Promise<IpcResult<IncludeCopyResult>> =>
    isTauriContext()
      ? invoke<IpcResult<IncludeCopyResult>>('worktree_copy_include_files', {
          projectPath,
          worktreePath
        })
      : webServerWorktree.copyIncludeFiles(projectPath, worktreePath)
}
