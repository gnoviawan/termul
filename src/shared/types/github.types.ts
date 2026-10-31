/**
 * GitHub issues & PRs contract (spec-github-integration).
 *
 * Every value here is produced by the host running the user's `gh` CLI.
 * Requests never carry a host or owner/repo: the host re-resolves the
 * repository from the project `cwd` and the `GithubRepoSlot`, so a client
 * cannot point `gh` (and the user's token) at an arbitrary host.
 */

/** Which of the project's repositories a request targets. */
export type GithubRepoSlot = 'origin' | 'upstream'

export interface GithubRepoRef {
  host: string
  owner: string
  name: string
}

/** `keyring`: gh's stored login (system keyring or gh's `hosts.yml`). `env`: `GH_TOKEN` and friends. */
export type GithubTokenSource = 'keyring' | 'env' | 'unknown'

/** `gh` availability and login for the project's host (CAP-1, CAP-9). */
export type GithubAuthStatus =
  | { state: 'cli_missing' }
  | { state: 'unauthenticated'; host: string; loginCommand: string }
  | {
      state: 'connected'
      host: string
      account: string
      scopes: string[]
      tokenSource: GithubTokenSource
      missingScopes: string[]
      /** Copyable commands that fix a scope gap or an env token hiding the keyring login. */
      fixCommands: string[]
    }

export type GithubRepoResolution =
  /** No remote, or a remote that is not a GitHub host `gh` knows. */
  | { kind: 'not_github' }
  | {
      kind: 'resolved'
      origin: GithubRepoRef
      /** The fork's parent, when `origin` is a fork. */
      upstream: GithubRepoRef | null
    }

export interface GithubContext {
  auth: GithubAuthStatus
  repo: GithubRepoResolution
}

export type GithubItemKind = 'issue' | 'pr'
export type GithubItemState = 'open' | 'closed' | 'merged' | 'draft'

export interface GithubLabel {
  name: string
  /** Six hex digits without `#`, as GitHub reports it. */
  color: string
}

export type GithubCheckRollup = 'success' | 'failure' | 'pending'

export interface GithubListItem {
  kind: GithubItemKind
  number: number
  title: string
  state: GithubItemState
  author: string
  labels: GithubLabel[]
  assignees: string[]
  commentCount: number
  /** ISO 8601. */
  updatedAt: string
  url: string
  /** PRs only; `null` when the PR has no checks. */
  checks: GithubCheckRollup | null
}

export interface GithubListFilter {
  repo: GithubRepoSlot
  kind: 'all' | GithubItemKind
  state: 'all' | GithubItemState
  assignedToMe: boolean
  reviewRequested: boolean
}

export interface GithubListRequest {
  cwd: string
  filter: GithubListFilter
  /** Bypass the host's read cache (user-initiated refresh, or after a write). */
  refresh?: boolean
}

export interface GithubListResult {
  repo: GithubRepoRef
  items: GithubListItem[]
  /** ISO 8601 time the host fetched these items (may be a cached read). */
  fetchedAt: string
}

export interface GithubItemRequest {
  cwd: string
  repo: GithubRepoSlot
  kind: GithubItemKind
  number: number
  refresh?: boolean
}

export interface GithubComment {
  id: string
  author: string
  body: string
  createdAt: string
  url: string
}

export interface GithubReviewThread {
  id: string
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: GithubComment[]
}

export type GithubMergeable = 'mergeable' | 'conflicting' | 'unknown'

export interface GithubPullDetail {
  headRefName: string
  headSha: string
  baseRefName: string
  isCrossRepository: boolean
  maintainerCanModify: boolean
  mergeable: GithubMergeable
  /** GitHub `mergeStateStatus` (CLEAN, BLOCKED, BEHIND, DIRTY, HAS_HOOKS, UNSTABLE, UNKNOWN, DRAFT). */
  mergeStateStatus: string
  autoMergeEnabled: boolean
  additions: number
  deletions: number
  changedFiles: number
  reviewThreads: GithubReviewThread[]
}

export interface GithubItemDetail {
  repo: GithubRepoRef
  item: GithubListItem
  body: string
  createdAt: string
  /** Issue/PR conversation comments, oldest first. */
  comments: GithubComment[]
  /** Present when `item.kind === 'pr'`. */
  pr: GithubPullDetail | null
  fetchedAt: string
}

export type GithubCheckStatus =
  | 'success'
  | 'failure'
  | 'pending'
  | 'skipped'
  | 'neutral'
  | 'cancelled'

export interface GithubCheck {
  name: string
  workflow: string | null
  status: GithubCheckStatus
  detailsUrl: string | null
  /** Actions job id, when the check is a GitHub Actions job (log tails need it). */
  jobId: number | null
}

export interface GithubChecksRequest {
  cwd: string
  repo: GithubRepoSlot
  number: number
  refresh?: boolean
}

export interface GithubChecksResult {
  headSha: string
  rollup: GithubCheckRollup | null
  checks: GithubCheck[]
  fetchedAt: string
}

export interface GithubCheckLogRequest {
  cwd: string
  repo: GithubRepoSlot
  jobId: number
}

export interface GithubCheckLog {
  jobId: number
  /** The last lines of the job log, at most 200 lines / 16 KB. */
  tail: string
  truncated: boolean
}

export type GithubMergeMethod = 'merge' | 'squash' | 'rebase'

export type GithubMergeAction =
  | { kind: 'merge'; method: GithubMergeMethod }
  | { kind: 'enable_auto_merge'; method: GithubMergeMethod }
  | { kind: 'disable_auto_merge' }

export interface GithubMergeRequest {
  cwd: string
  repo: GithubRepoSlot
  number: number
  action: GithubMergeAction
}

export interface GithubMergeResult {
  number: number
}

/** Where a new comment goes: the issue/PR conversation, or a reply in a PR review thread. */
export type GithubCommentTarget =
  | { kind: 'conversation' }
  | { kind: 'review_thread'; threadId: string }

export interface GithubCommentRequest {
  cwd: string
  repo: GithubRepoSlot
  kind: GithubItemKind
  number: number
  target: GithubCommentTarget
  /** Markdown, as typed by the user. */
  body: string
}

export interface GithubCommentResult {
  comment: GithubComment
}

/**
 * Point an agent worktree at a PR's head (Fix CI, Resolve comments). `cwd` is
 * the worktree the chat runs in; the host runs `gh pr checkout` there, which
 * handles fork remotes.
 */
export interface GithubCheckoutPrRequest {
  cwd: string
  repo: GithubRepoSlot
  number: number
}

export interface GithubCheckoutPrResult {
  headSha: string
  headRefName: string
  /** The exact command that pushes this worktree's commits to the PR head branch. */
  pushCommand: string
}

/**
 * `IpcResult` failure codes the GitHub host ops return beyond
 * `PATH_VALIDATION_FAILED` / transport codes.
 */
export const GITHUB_ERROR_CODES = [
  'GH_CLI_MISSING',
  'GH_UNAUTHENTICATED',
  'GH_NOT_GITHUB_REPO',
  'GH_NO_UPSTREAM',
  'GH_RATE_LIMITED',
  'GH_NOT_FOUND',
  'GH_NOT_MERGEABLE',
  /** A fork PR that does not allow maintainer edits: agents cannot push to it. */
  'GH_FORK_PUSH_BLOCKED',
  'GH_EMPTY_COMMENT',
  'GH_TIMEOUT',
  'GH_FAILED'
] as const
export type GithubErrorCode = (typeof GITHUB_ERROR_CODES)[number]
