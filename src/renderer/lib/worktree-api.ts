import type { IpcResult } from '@shared/types/ipc.types'
import type {
  BaseBranchInfo,
  BranchInfo,
  DirtyStatus,
  GitignoreDir,
  IncludeCopyResult,
  MergePreviewInfo,
  RemoveResult,
  SymlinkResult,
  WorktreeInfo,
  WorktreeProgressEvent
} from '@shared/types/worktree.types'
import { invoke } from '@tauri-apps/api/core'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'
import type { Worktree } from '@/types/project'
import { invokeIpcCommand, mapTauriVerdict } from './acp-transport/tauri-verdicts'
import { entityKeyOf, runIpcCommand, worktreeCreateKey } from './ipc/http'
import { isTauriContext } from './tauri-runtime'
import { webServerWorktree } from './web-server-api'

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
    isTauriContext()
      ? invoke<IpcResult<WorktreeInfo[]>>('worktree_list', { projectPath })
      : webServerWorktree.list(projectPath),

  /**
   * Create a new worktree.
   * If isNewBranch is true, creates a new branch from the startRef (or HEAD).
   * If branch exists, checks it out in the new worktree.
   * targetPath defaults to `<project-path>/.termul/worktrees/<name>/` when not provided.
   *
   * When `progressId` is set, the backend streams git's stderr lines live:
   * Tauri emits `acp:worktree_progress` events (the progress store's listener
   * is registered before invoke so no early line is missed); web returns an
   * NDJSON stream on this same request and each frame is forwarded to
   * `onProgress`.
   */
  create: (params: {
    projectPath: string
    name: string
    branch: string
    isNewBranch: boolean
    startRef?: string
    targetPath?: string
    progressId?: string
    onProgress?: (event: WorktreeProgressEvent) => void
  }): Promise<IpcResult<WorktreeInfo>> => {
    if (isTauriContext()) {
      if (params.progressId) {
        useWorktreeProgressStore.getState().ensureTransportListener()
      }
      const { onProgress: _onProgress, ...invokeArgs } = params
      return invokeIpcCommand<WorktreeInfo>('worktree_create', invokeArgs, {
        kind: 'worktree_create',
        entityKey: worktreeCreateKey(params),
        invokeFailure: 'throw'
      })
    }
    const { onProgress, ...webParams } = params
    return webServerWorktree.create(webParams, onProgress)
  },

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
   * Rename a worktree's branch by hand (shell revamp story 16, CAP-5): `git
   * branch -m`, every session on the worktree is rewritten by the host (the
   * branch source becomes `user`) and `acp:worktree_branch_renamed` reaches
   * every client. The error code comes from the host (`INVALID_BRANCH_NAME`,
   * `BRANCH_EXISTS`, `BRANCH_CHANGED`, `FORBIDDEN`, `OUTSIDE_PROJECT_ROOT`).
   *
   * **Write gating:** this is a write route. Callers MUST gate any UI with
   * `useServerAdmitsRemoteWrites` / the S19 `WriteGate` so read-only servers
   * show the control disabled with the reason (CAP-15). This story ships no UI
   * consumer; the server refuses the write either way.
   */
  renameBranch: (
    worktreePath: string,
    oldBranch: string,
    newBranch: string
  ): Promise<IpcResult<void>> =>
    isTauriContext()
      ? runIpcCommand<void>({
          kind: 'worktree_rename_branch',
          entityKey: entityKeyOf(worktreePath, oldBranch, newBranch),
          send: (commandId) =>
            invoke<IpcResult<void>>('worktree_rename_branch', {
              worktreePath,
              oldBranch,
              newBranch,
              commandId
            }).catch((error) => {
              throw mapTauriVerdict(error)
            })
        })
      : webServerWorktree.renameBranch(worktreePath, oldBranch, newBranch),

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
   * **Web:** returns `WEB_UNSUPPORTED`.
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
    isTauriContext()
      ? invoke<IpcResult<GitignoreDir[]>>('worktree_parse_gitignore', { projectPath })
      : webServerWorktree.parseGitignore(projectPath),

  /**
   * Create symlinks from project root directories into a worktree.
   *
   * **Write:** a read-only server refuses it with `FORBIDDEN`.
   */
  createSymlinks: (
    projectPath: string,
    worktreePath: string,
    symlinkDirs: string[]
  ): Promise<IpcResult<SymlinkResult[]>> =>
    isTauriContext()
      ? invoke<IpcResult<SymlinkResult[]>>('worktree_create_symlinks', {
          projectPath,
          worktreePath,
          symlinkDirs: JSON.stringify(symlinkDirs)
        })
      : webServerWorktree.createSymlinks(projectPath, worktreePath, symlinkDirs),

  /**
   * Ensure symlinks exist for all directories in symlinkDirs.
   * Creates any missing symlinks. Does not remove or overwrite existing ones.
   *
   * **Write:** a read-only server refuses it with `FORBIDDEN`.
   */
  ensureSymlinks: (
    projectPath: string,
    worktreePath: string,
    symlinkDirs: string[]
  ): Promise<IpcResult<SymlinkResult[]>> =>
    isTauriContext()
      ? invoke<IpcResult<SymlinkResult[]>>('worktree_ensure_symlinks', {
          projectPath,
          worktreePath,
          symlinkDirs: JSON.stringify(symlinkDirs)
        })
      : webServerWorktree.ensureSymlinks(projectPath, worktreePath, symlinkDirs),

  /**
   * Archive a worktree by moving it to `.termul/archives/<name>-<timestamp>/`.
   * The worktree is recoverable until the 30-day retention expires.
   *
   * **Web:** returns `WEB_UNSUPPORTED`.
   */
  archive: (projectPath: string, worktreePath: string): Promise<IpcResult<void>> =>
    worktreeInvoke<void>('worktree_archive', { projectPath, worktreePath }),

  /**
   * Restore an archived worktree back to its original location.
   *
   * **Web:** returns `WEB_UNSUPPORTED`.
   */
  restore: (projectPath: string, archivePath: string): Promise<IpcResult<void>> =>
    worktreeInvoke<void>('worktree_restore', { projectPath, archivePath }),

  /**
   * Generate a merge preview for a worktree against a target branch.
   *
   * **Web:** returns `WEB_UNSUPPORTED`.
   */
  mergePreview: (
    worktreePath: string,
    targetBranch: string
  ): Promise<IpcResult<MergePreviewInfo>> =>
    worktreeInvoke<MergePreviewInfo>('worktree_merge_preview', { worktreePath, targetBranch }),

  /**
   * Execute a merge from the worktree's current branch to target_branch.
   *
   * **Web:** returns `WEB_UNSUPPORTED`.
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
