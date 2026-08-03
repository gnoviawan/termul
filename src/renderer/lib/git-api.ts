import type {
  GitCommit,
  GitCommitContext,
  GitStashInfo,
  GitStatusDetail
} from '@shared/types/ipc.types'
import { invoke } from '@tauri-apps/api/core'
import { isTauriContext } from './tauri-runtime'
import { webServerGit } from './web-server-api'

// CAP-1 parity: every method branches on `isTauriContext()` between the
// desktop `invoke(...)` path and the same-origin `webServerGit.*` HTTP path.
// The `init` template (below) is the canonical pattern — replicate it for the
// other 19 methods. `webServerGit.*` throws on `!res.success` so callers see
// the same error shape the desktop `invoke` rejection produces.

export const gitApi = {
  getStatus: (cwd: string) =>
    isTauriContext()
      ? invoke<GitStatusDetail[]>('git_get_status', { cwd })
      : webServerGit.getStatus(cwd),

  getDiff: (cwd: string, path: string, staged = false) =>
    isTauriContext()
      ? invoke<string>('git_get_diff', { cwd, path, staged })
      : webServerGit.getDiff(cwd, path, staged),

  stage: (cwd: string, path: string) =>
    isTauriContext() ? invoke<void>('git_stage', { cwd, path }) : webServerGit.stage(cwd, path),

  unstage: (cwd: string, path: string) =>
    isTauriContext() ? invoke<void>('git_unstage', { cwd, path }) : webServerGit.unstage(cwd, path),

  discard: (cwd: string, path: string) =>
    isTauriContext() ? invoke<void>('git_discard', { cwd, path }) : webServerGit.discard(cwd, path),

  getLog: (cwd: string, limit?: number) =>
    isTauriContext()
      ? invoke<GitCommit[]>('git_get_log', { cwd, limit })
      : webServerGit.getLog(cwd, limit),

  commit: (cwd: string, summary: string, description = '', amend = false) =>
    isTauriContext()
      ? invoke<void>('git_commit', { cwd, summary, description, amend })
      : webServerGit.commit(cwd, summary, description, amend),

  push: (cwd: string) =>
    isTauriContext() ? invoke<void>('git_push', { cwd }) : webServerGit.push(cwd),

  getCommitContext: (cwd: string) =>
    isTauriContext()
      ? invoke<GitCommitContext>('git_get_commit_context', { cwd })
      : webServerGit.getCommitContext(cwd),

  // Web/remote mode: route through the same-origin server (Story: Web/remote
  // project creation). Desktop stays on invoke('git_init').
  init: (cwd: string) =>
    isTauriContext() ? invoke<void>('git_init', { cwd }) : webServerGit.init(cwd),

  checkoutBranch: (cwd: string, branch: string, isRemote = false) =>
    isTauriContext()
      ? invoke<void>('git_checkout_branch', { cwd, branch, isRemote })
      : webServerGit.checkoutBranch(cwd, branch, isRemote),

  createBranch: (cwd: string, branch: string, startRef?: string) =>
    isTauriContext()
      ? invoke<void>('git_create_branch', { cwd, branch, startRef })
      : webServerGit.createBranch(cwd, branch, startRef),

  stashSave: (cwd: string, message?: string, includeUntracked?: boolean) =>
    isTauriContext()
      ? invoke<void>('git_stash_save', { cwd, message, includeUntracked })
      : webServerGit.stashSave(cwd, message, includeUntracked),

  stashList: (cwd: string) =>
    isTauriContext()
      ? invoke<GitStashInfo[]>('git_stash_list', { cwd })
      : webServerGit.stashList(cwd),

  stashApply: (cwd: string, index: number) =>
    isTauriContext()
      ? invoke<void>('git_stash_apply', { cwd, index })
      : webServerGit.stashApply(cwd, index),

  stashPop: (cwd: string, index: number) =>
    isTauriContext()
      ? invoke<void>('git_stash_pop', { cwd, index })
      : webServerGit.stashPop(cwd, index),

  stashDrop: (cwd: string, index: number) =>
    isTauriContext()
      ? invoke<void>('git_stash_drop', { cwd, index })
      : webServerGit.stashDrop(cwd, index),

  branchList: (cwd: string) =>
    isTauriContext() ? invoke<string[]>('git_branch_list', { cwd }) : webServerGit.branchList(cwd),

  branchSwitch: (cwd: string, name: string) =>
    isTauriContext()
      ? invoke<void>('git_branch_switch', { cwd, name })
      : webServerGit.branchSwitch(cwd, name),

  branchCreate: (cwd: string, name: string) =>
    isTauriContext()
      ? invoke<void>('git_branch_create', { cwd, name })
      : webServerGit.branchCreate(cwd, name)
}
