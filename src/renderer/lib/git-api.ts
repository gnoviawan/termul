import type {
  GitCommit,
  GitCommitContext,
  GitCommitDetail,
  GitCommitFileDiff,
  GitDiffStat,
  GitStashInfo,
  GitStatusDetail,
  ProjectIcon
} from '@shared/types/ipc.types'
import { invoke } from '@tauri-apps/api/core'
import { runInvokeCommand } from './acp-transport/tauri-verdicts'
import { entityKeyOf } from './ipc/http'
import { invokeIpc } from './ipc/tauri'
import { isTauriContext } from './tauri-runtime'
import { webServerGit } from './web-server-api'

// CAP-1 parity: every method branches on `isTauriContext()` between the
// desktop `invoke(...)` path and the same-origin `webServerGit.*` HTTP path.
// The `init` template (below) is the canonical pattern — replicate it for the
// other 19 methods. `webServerGit.*` throws on `!res.success` so callers see
// the same error shape the desktop `invoke` rejection produces.

/**
 * A ledgered desktop git command: the engine mints/journals the `commandId`
 * (same id on a resend, new id after a definite rejection) and the host
 * answers a resend from its ledger. `fresh` for commands whose request carries
 * content the entity key cannot name (patch, message).
 */
function ledgeredInvoke(
  command: string,
  entityKey: string,
  args: Record<string, unknown>,
  fresh = false
): Promise<void> {
  return runInvokeCommand<void>({
    kind: command,
    entityKey,
    fresh,
    send: (commandId) => invoke<void>(command, { ...args, commandId })
  })
}

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

  // Per-hunk stage/unstage (#257). `hunkPatch` is a single-hunk unified-diff
  // fragment; the backend applies it via `git apply --cached [--reverse]`.
  // Web/remote posts `/git/stage-hunk` | `/git/unstage-hunk`.
  stageHunk: (cwd: string, path: string, hunkPatch: string) =>
    isTauriContext()
      ? runInvokeCommand<void>({
          kind: 'git_stage_hunk',
          entityKey: entityKeyOf(cwd, path),
          fresh: true,
          send: (commandId) => invoke<void>('git_stage_hunk', { cwd, path, hunkPatch, commandId })
        })
      : webServerGit.stageHunk(cwd, path, hunkPatch),

  unstageHunk: (cwd: string, path: string, hunkPatch: string) =>
    isTauriContext()
      ? runInvokeCommand<void>({
          kind: 'git_unstage_hunk',
          entityKey: entityKeyOf(cwd, path),
          fresh: true,
          send: (commandId) => invoke<void>('git_unstage_hunk', { cwd, path, hunkPatch, commandId })
        })
      : webServerGit.unstageHunk(cwd, path, hunkPatch),

  discard: (cwd: string, path: string) =>
    isTauriContext()
      ? ledgeredInvoke('git_discard', entityKeyOf(cwd, path), { cwd, path })
      : webServerGit.discard(cwd, path),

  getLog: (cwd: string, limit?: number, all = false) =>
    isTauriContext()
      ? invoke<GitCommit[]>('git_get_log', { cwd, limit, all })
      : webServerGit.getLog(cwd, limit, all),

  getCommitDetail: async (cwd: string, hash: string): Promise<GitCommitDetail> => {
    if (isTauriContext()) {
      const res = await invokeIpc<GitCommitDetail>('git_get_commit_detail', { cwd, hash })
      if (!res.success) throw new Error(res.error)
      return res.data
    }
    return webServerGit.getCommitDetail(cwd, hash)
  },

  getCommitFileDiff: async (
    cwd: string,
    hash: string,
    path: string,
    oldPath?: string
  ): Promise<GitCommitFileDiff> => {
    if (isTauriContext()) {
      const res = await invokeIpc<GitCommitFileDiff>('git_get_commit_file_diff', {
        cwd,
        hash,
        path,
        oldPath: oldPath ?? null
      })
      if (!res.success) throw new Error(res.error)
      return res.data
    }
    return webServerGit.getCommitFileDiff(cwd, hash, path, oldPath)
  },

  /**
   * `expectedHead`: the full sha HEAD must be at (`''` for an unborn branch);
   * a moved HEAD refuses the commit with `precondition_failed`, nothing changes.
   */
  commit: (cwd: string, summary: string, description = '', amend = false, expectedHead?: string) =>
    isTauriContext()
      ? ledgeredInvoke(
          'git_commit',
          cwd,
          {
            cwd,
            summary,
            description,
            amend,
            ...(expectedHead !== undefined ? { expectedHead } : {})
          },
          true
        )
      : webServerGit.commit(cwd, summary, description, amend, expectedHead),

  push: (cwd: string) =>
    isTauriContext() ? invoke<void>('git_push', { cwd }) : webServerGit.push(cwd),

  getCommitContext: (cwd: string) =>
    isTauriContext()
      ? invoke<GitCommitContext>('git_get_commit_context', { cwd })
      : webServerGit.getCommitContext(cwd),

  /**
   * Resolve a project's icon (spec-project-icon). Desktop invokes
   * `project_icon_resolve` (returns `IpcResult<Option<ProjectIcon>>` — the
   * `invokeIpc` flavor); web/remote posts `/project/icon`. Both unwrap to
   * `ProjectIcon | null` — `null` means "render the monogram". Throws on
   * `success: false` like the other `webServerGit` methods so callers see one
   * error shape on either transport.
   */
  getProjectIcon: async (cwd: string): Promise<ProjectIcon | null> => {
    if (isTauriContext()) {
      const res = await invokeIpc<ProjectIcon | null>('project_icon_resolve', { cwd })
      if (!res.success) throw new Error(res.error)
      return res.data
    }
    return webServerGit.getProjectIcon(cwd)
  },

  /**
   * Working-tree `+added -removed` stat (tracked vs HEAD plus untracked files).
   * Desktop returns an `IpcResult` envelope; unwrap and throw on failure so
   * callers see the same error shape as the web branch.
   */
  getDiffStat: async (cwd: string): Promise<GitDiffStat> => {
    if (isTauriContext()) {
      const res = await invokeIpc<GitDiffStat>('git_get_diff_stat', { cwd })
      if (!res.success) throw new Error(res.error)
      return res.data
    }
    return webServerGit.getDiffStat(cwd)
  },

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
      ? ledgeredInvoke('git_create_branch', entityKeyOf(cwd, branch, startRef), {
          cwd,
          branch,
          startRef
        })
      : webServerGit.createBranch(cwd, branch, startRef),

  stashSave: (cwd: string, message?: string, includeUntracked?: boolean) =>
    isTauriContext()
      ? ledgeredInvoke('git_stash_save', cwd, { cwd, message, includeUntracked }, true)
      : webServerGit.stashSave(cwd, message, includeUntracked),

  stashList: (cwd: string) =>
    isTauriContext()
      ? invoke<GitStashInfo[]>('git_stash_list', { cwd })
      : webServerGit.stashList(cwd),

  stashApply: (cwd: string, index: number) =>
    isTauriContext()
      ? ledgeredInvoke('git_stash_apply', entityKeyOf(cwd, index), { cwd, index })
      : webServerGit.stashApply(cwd, index),

  stashPop: (cwd: string, index: number) =>
    isTauriContext()
      ? ledgeredInvoke('git_stash_pop', entityKeyOf(cwd, index), { cwd, index })
      : webServerGit.stashPop(cwd, index),

  stashDrop: (cwd: string, index: number) =>
    isTauriContext()
      ? ledgeredInvoke('git_stash_drop', entityKeyOf(cwd, index), { cwd, index })
      : webServerGit.stashDrop(cwd, index),

  branchList: (cwd: string) =>
    isTauriContext() ? invoke<string[]>('git_branch_list', { cwd }) : webServerGit.branchList(cwd),

  branchSwitch: (cwd: string, name: string) =>
    isTauriContext()
      ? invoke<void>('git_branch_switch', { cwd, name })
      : webServerGit.branchSwitch(cwd, name)
}
