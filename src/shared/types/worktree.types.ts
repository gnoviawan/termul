export interface WorktreeInfo {
  name: string
  branch: string
  path: string
  headCommit: string
  /**
   * Web `/worktree/list` only: the worktree is outside the registered project
   * folder (listed but not actionable, AD-9). Absent on desktop.
   */
  outsideProjectRoot?: boolean
}

export interface BranchInfo {
  name: string
  isRemote: boolean
  isCurrent: boolean
  upstream?: string | null
  hasOtherWorktree: boolean
}

export interface DirtyStatus {
  modified: number
  staged: number
  untracked: number
  hasChanges: boolean
}

export interface RemoveResult {
  worktreePath: string
  success: boolean
  error?: string | null
}

export interface GitignoreDir {
  dirName: string
  exists: boolean
}

export interface SymlinkResult {
  path: string
  target: string
  status: 'created' | 'skipped' | 'failed'
  reason?: string
}

/** Live line emitted while `git worktree add` runs. `line` is a git
 * stderr line; sentinels `preparing`/`done`/`termul:error: <msg>` carry
 * phase boundaries. The error sentinel is `termul:`-namespaced because real
 * git stderr lines can legitimately start with `error:`/`fatal:` mid-run —
 * those are ordinary log lines, never the terminator. `progressId` is the
 * renderer-generated correlation id so concurrent launches and cross-window
 * events cannot cross-talk. On web the create response is an NDJSON stream
 * that terminates via its `result` frame (an `IpcResult`), not a
 * `done`/`termul:error:` line. */
export interface WorktreeProgressEvent {
  progressId: string
  line: string
}

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
