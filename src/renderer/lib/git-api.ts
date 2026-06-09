import type {
  GitCommit,
  GitCommitContext,
  GitStashInfo,
  GitStatusDetail
} from '@shared/types/ipc.types'
import { invoke } from '@tauri-apps/api/core'

export const gitApi = {
  getStatus: (cwd: string) => invoke<GitStatusDetail[]>('git_get_status', { cwd }),

  getDiff: (cwd: string, path: string, staged = false) =>
    invoke<string>('git_get_diff', { cwd, path, staged }),

  stage: (cwd: string, path: string) => invoke<void>('git_stage', { cwd, path }),

  unstage: (cwd: string, path: string) => invoke<void>('git_unstage', { cwd, path }),

  discard: (cwd: string, path: string) => invoke<void>('git_discard', { cwd, path }),

  getLog: (cwd: string, limit?: number) => invoke<GitCommit[]>('git_get_log', { cwd, limit }),

  commit: (cwd: string, summary: string, description = '', amend = false) =>
    invoke<void>('git_commit', { cwd, summary, description, amend }),

  push: (cwd: string) => invoke<void>('git_push', { cwd }),

  getCommitContext: (cwd: string) => invoke<GitCommitContext>('git_get_commit_context', { cwd }),

  init: (cwd: string) => invoke<void>('git_init', { cwd }),

  stashSave: (cwd: string, message?: string, includeUntracked?: boolean) =>
    invoke<void>('git_stash_save', { cwd, message, includeUntracked }),

  stashList: (cwd: string) => invoke<GitStashInfo[]>('git_stash_list', { cwd }),

  stashApply: (cwd: string, index: number) => invoke<void>('git_stash_apply', { cwd, index }),

  stashPop: (cwd: string, index: number) => invoke<void>('git_stash_pop', { cwd, index }),

  stashDrop: (cwd: string, index: number) => invoke<void>('git_stash_drop', { cwd, index }),

  branchList: (cwd: string) => invoke<string[]>('git_branch_list', { cwd }),

  branchSwitch: (cwd: string, name: string) => invoke<void>('git_branch_switch', { cwd, name }),

  branchCreate: (cwd: string, name: string) => invoke<void>('git_branch_create', { cwd, name })
}
