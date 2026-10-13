// IPC Result pattern from architecture.md
import type { AcpCatalog } from './acp-catalog.types'

// ============================================================================
// Domain-command carriers (AD-5): `X-Command-Id` header of the ledgered HTTP
// routes, the codes the host answers a ledgered command with, and the
// precondition shapes of `fs write` / `git commit`. Mirrors
// `src-tauri/src/web/command_ledger/{http,terminal}.rs` and
// `web/fs_api/precondition.rs`.
// ============================================================================

/** Request header carrying the `commandId` of a ledgered HTTP route. */
export const COMMAND_ID_HEADER = 'X-Command-Id'

/**
 * `IpcBody.code` / `IpcResult.code` (and `/terminal/ws` reply codes) of a
 * ledger verdict. SCREAMING_SNAKE on the HTTP, Tauri-IpcResult and terminal
 * carriers (the `/ws` carrier uses snake_case `WS_ERROR_CODES`).
 */
export const COMMAND_RESULT_CODES = {
  /** The `commandId` is missing (ledgered route) or not 1-128 of `[A-Za-z0-9_-]`. */
  INVALID_COMMAND_ID: 'INVALID_COMMAND_ID',
  /** The `commandId` was already used for a different request. */
  COMMAND_CONFLICT: 'COMMAND_CONFLICT',
  /** A resend whose outcome the host no longer knows; it was NOT run again. */
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  /** A stale `expected` hash (fs write) or `expectedHead` (git commit); nothing changed. */
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  /**
   * Client-local: the host answered `{ success: true, receipt: "in_progress" }`
   * (the first run of this id is still going). Neither accepted nor rejected.
   */
  COMMAND_IN_PROGRESS: 'COMMAND_IN_PROGRESS'
} as const

export type CommandResultCode = (typeof COMMAND_RESULT_CODES)[keyof typeof COMMAND_RESULT_CODES]

/** `IpcBody.receipt` of a resend while the first run is still going. */
export const IN_PROGRESS_RECEIPT = 'in_progress'

/**
 * Local engine code (lower snake_case, like the `/ws` codes) a stale
 * precondition maps to: the host refused, nothing changed. A definite
 * rejection — the caller re-reads and decides; a retry is a new intent.
 */
export const PRECONDITION_FAILED_CODE = 'precondition_failed'

/**
 * `expected` precondition of `POST /fs/write`: the sha256 hex (lower case) of
 * the bytes being replaced (`contentHash` of `GET /fs/read`), or `"absent"`
 * when the file must not exist yet.
 */
export type FsWriteExpected = 'absent' | { sha256: string }

/**
 * A file read. The web host adds `contentHash` (lower-case sha256 hex of the
 * file's bytes): send it back as the `expected` precondition of the next write.
 * Absent on desktop reads (`plugin-fs`), which carry no precondition.
 */
export type HashedFileContent = FileContent & { contentHash?: string }

/**
 * `code` values a ledgered command can fail with beyond its own domain codes
 * are listed below (`COMMAND_RESULT_CODES`). A host reply
 * `{ success: true, receipt: "in_progress" }` (first run of a resent id still
 * going) is surfaced as the failure `COMMAND_IN_PROGRESS`: neither accepted nor
 * rejected, so the caller keeps the command pending.
 */
export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: string }

// Terminal spawn options
export interface TerminalSpawnOptions {
  shell?: string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  // ADR-004.2: terminal-native agent launch.
  // When `program` is set, the PTY runs that executable directly (with `args`
  // as discrete argv entries) instead of resolving a login shell. The prompt is
  // always a single element of `args` — never shell-interpolated. When `program`
  // is omitted, spawn behavior is byte-for-byte identical to the shell path.
  /** Absolute path or PATH-resolvable executable to run instead of a shell. */
  program?: string
  /** argv tail; each element is passed as a discrete, unescaped argument. */
  args?: string[]
  /** Descriptive marker for the session type. Defaults to 'shell'. */
  kind?: 'shell' | 'agent'
  /**
   * Project-scoping id. The web/remote terminal server (terminal_ws.rs)
   * requires a non-empty projectId on every spawn (project-scoped security);
   * desktop treats it as optional (SpawnOptions.project_id is Option<String>
   * with #[serde(default)]). Renderers populate it at project-scoped call sites.
   */
  projectId?: string
  // Index signature to satisfy Tauri's InvokeArgs constraint
  [key: string]: unknown
}

// Terminal info returned after spawn
export interface TerminalInfo {
  id: string
  shell: string
  cwd: string
}

/**
 * CAP-3 spawn response: terminal info PLUS the issued claim credential.
 * Same flattened camelCase shape on both transports (desktop `terminal_spawn`
 * IpcResult data and web `spawn` reply data). Spawn is the ONLY issuance path.
 * Mirrors the Rust `SpawnedTerminal` serde shape exactly (id/shell/cwd/pid/
 * cols/rows/claim — pinned by the Rust serde shape tests).
 */
export interface SpawnedTerminal extends TerminalInfo {
  pid: number
  cols: number
  rows: number
  /** Unguessable host-issued lease credential (64 hex chars). Present only in
   * the spawn/rotate responses — never echoed by any other operation. */
  claim: string
}
/** Latest terminal lifecycle/metadata state. Serialized on the attach/replay
 * frames so a client that attaches after the single change-only event emit
 * can seed its store (closing the "detached for a branch that isn't" gap).
 * Runtime-neutral contract shared by both transports. */
export interface TerminalStateSnapshot {
  cwd: string | null
  gitBranch: string | null
  gitStatus: GitStatus | null
  exitCode: number | null
  exited: boolean
}

/**
 * CAP-3 attach response — byte-identical camelCase shape on both transports
 * (desktop `terminal_attach` IpcResult data; web `attach` reply data).
 * Carries the replay cursor (`latestSeq`) + `gap` flag + the terminal's
 * last-known state `snapshot`. NEVER carries a claim: attach consumes the
 * credential, it never issues one.
 */
export interface TerminalAttachResult {
  id: string
  shell: string
  cwd: string
  pid: number
  cols: number
  rows: number
  latestSeq: number
  gap: boolean
  /**
   * The cursor did not belong to this terminal's log (another epoch, or ahead
   * of the head): the replay starts from the retained log's first chunk and the
   * client must discard what it rendered.
   */
  reset: boolean
  /** Epoch of this spawn's output log; the next cursor is `(logEpoch, latestSeq)`. */
  logEpoch: string
  snapshot: TerminalStateSnapshot
}

/** CAP-3 rotate response: the fresh credential. */
export interface RotatedClaim {
  claim: string
}

// IPC channel definitions
export type TerminalIpcChannels = {
  'terminal:spawn': (options: TerminalSpawnOptions) => IpcResult<SpawnedTerminal>
  'terminal:attach': (
    terminalId: string,
    claim: string,
    lastSeq: number,
    logEpoch?: string
  ) => IpcResult<TerminalAttachResult>
  'terminal:rotate_claim': (terminalId: string, claim: string) => IpcResult<RotatedClaim>
  'terminal:revoke_claim': (terminalId: string, claim: string) => IpcResult<void>
  'terminal:write': (terminalId: string, data: string) => IpcResult<void>
  'terminal:resize': (terminalId: string, cols: number, rows: number) => IpcResult<void>
  'terminal:kill': (terminalId: string) => IpcResult<void>
}

// CAP-6 / Story 8: ACP catalog IPC channels. Mirrors the two `/ws` requests
// (`list_acp_catalog` / `set_catalog_opt_in`) and the two HTTP routes
// (`GET /acp/catalog` / `POST /acp/catalog/opt-in`) — both carriers return
// the SAME `IpcResult<...>` shape byte-for-byte. The catalog is
// credential-free, path-free, read-only host introspection. The opt-in is a
// single boolean that gates CDN registry augmentation.
export type AcpCatalogIpcChannels = {
  'acp:catalog:list': (refresh?: boolean) => IpcResult<AcpCatalog>
  'acp:catalog:set_opt_in': (enabled: boolean) => IpcResult<void>
}

// CAP-6 / Story 9: ACP install IPC channel. Mirrors the `/ws` request
// `install_acp_agent` and the HTTP route `POST /acp/install` — both carriers
// return the SAME `IpcResult<InstallOutcome>` shape byte-for-byte. The request
// is `{ agentId }` only; the host resolves everything from the trusted catalog.
import type { InstallOutcome } from './acp-install.types'
export type AcpInstallIpcChannels = {
  'acp:install:install_agent': (request: { agentId: string }) => IpcResult<InstallOutcome>
}

// Event types for main -> renderer communication
// Terminal data callback — receives binary data as Uint8Array (via Tauri Channel)
// Previously received string via event emitter; migrated to binary Channel API in ADR-002.2
export type TerminalDataCallback = (terminalId: string, data: Uint8Array) => void
export type TerminalExitCallback = (terminalId: string, exitCode: number, signal?: number) => void
/**
 * #850: fired when a terminal's lease is dropped after a server rejection
 * (the re-attach loop's generic UNAUTHORIZED — the server-restart
 * signature: PTYs and claims die with the process). The terminal is
 * unattachable from this client until a fresh shell is spawned; the UI
 * shows a dead-session state with a Restart button instead of silently
 * swallowing input. `reason` is a coarse, display-safe category.
 */
export type TerminalSessionLostCallback = (
  terminalId: string,
  reason: 'server-restarted' | 'claim-rejected'
) => void
export type TerminalCwdChangedCallback = (terminalId: string, cwd: string) => void
export type TerminalGitBranchChangedCallback = (terminalId: string, branch: string | null) => void
export type TerminalGitStatusChangedCallback = (
  terminalId: string,
  status: GitStatus | null
) => void
export type TerminalExitCodeChangedCallback = (terminalId: string, exitCode: number) => void

// Git status interface
export interface GitStatus {
  modified: number
  staged: number
  untracked: number
  ahead: number
  behind: number
  hasChanges: boolean
}

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'staged'

export interface GitStatusDetail {
  path: string
  status: GitFileStatus
  staged: boolean
}

/** Working-tree line stat (tracked vs HEAD plus untracked files). */
export interface GitDiffStat {
  added: number
  removed: number
}

// A single commit row for the history/graph view.
export interface GitCommit {
  /** Full 40-char commit hash. */
  hash: string
  /** Abbreviated commit hash. */
  shortHash: string
  /** Parent full hashes, first-parent first. Empty for the root commit. */
  parents: string[]
  /** Ref decorations (branches, tags, HEAD) attached to this commit. */
  refs: string[]
  /** Author name. */
  author: string
  /** Author date in ISO 8601 strict format. */
  date: string
  /** Commit subject (first line of the message). */
  subject: string
}

/**
 * Resolved project icon (spec-project-icon). Runtime-neutral contract shared
 * by both transports: `project_icon_resolve` (Tauri `IpcResult` data) and
 * `POST /project/icon` (web `IpcBody` data) return this shape byte-for-byte,
 * pinned by the Rust serde camelCase shape test.
 *
 * `dataUri` is a `data:<mime>;base64,…` payload so the existing CSP
 * (`img-src 'self' asset: data:`) needs no change — no remote URL ever reaches
 * the renderer. `null` (rather than an error) means "render the monogram" —
 * every resolver failure is best-effort.
 */
export interface ProjectIcon {
  /** `data:` URI carrying the icon bytes — safe for `<img src>` under the CSP. */
  dataUri: string
  /** Sniffed MIME type (`image/png`, `image/svg+xml`, `image/x-icon`, …). */
  mime: string
  /** Where the icon came from: a well-known file in the repo, or the forge. */
  source: 'file' | 'remote'
  /**
   * Renderer-side epoch ms when the icon was resolved. Stamped by
   * `use-project-icon` (never sent by the backend) so the hook can skip
   * re-resolving icons fresher than 24 h; persisted with the project record.
   */
  fetchedAt?: number
}

// Context for the commit footer (branch, upstream, ahead/behind, last commit).
export interface GitCommitContext {
  branch: string | null
  hasUpstream: boolean
  ahead: number
  behind: number
  stagedCount: number
  hasHead: boolean
  lastSubject: string
  lastBody: string
}

export interface GitStashInfo {
  index: number
  name: string
  message: string
}

export interface GitApi {
  getStatus: (cwd: string) => Promise<GitStatusDetail[]>
  getDiff: (cwd: string, path: string, staged?: boolean) => Promise<string>
  getDiffStat: (cwd: string) => Promise<GitDiffStat>
  stage: (cwd: string, path: string) => Promise<void>
  unstage: (cwd: string, path: string) => Promise<void>
  discard: (cwd: string, path: string) => Promise<void>
  getLog: (cwd: string, limit?: number) => Promise<GitCommit[]>
  /** `expectedHead`: the full sha HEAD must be at (`''` for an unborn branch); a moved HEAD refuses the commit (`precondition_failed`). */
  commit: (
    cwd: string,
    summary: string,
    description?: string,
    amend?: boolean,
    expectedHead?: string
  ) => Promise<void>
  push: (cwd: string) => Promise<void>
  getCommitContext: (cwd: string) => Promise<GitCommitContext>
  init: (cwd: string) => Promise<void>
  checkoutBranch: (cwd: string, branch: string, isRemote?: boolean) => Promise<void>
  createBranch: (cwd: string, branch: string, startRef?: string) => Promise<void>
  stashSave: (cwd: string, message?: string, includeUntracked?: boolean) => Promise<void>
  stashList: (cwd: string) => Promise<GitStashInfo[]>
  stashApply: (cwd: string, index: number) => Promise<void>
  stashPop: (cwd: string, index: number) => Promise<void>
  stashDrop: (cwd: string, index: number) => Promise<void>
  branchList: (cwd: string) => Promise<string[]>
  branchSwitch: (cwd: string, name: string) => Promise<void>
  branchCreate: (cwd: string, name: string) => Promise<void>
}

// Terminal API exposed via preload
export interface TerminalApi {
  spawn: (options?: TerminalSpawnOptions) => Promise<IpcResult<SpawnedTerminal>>
  /**
   * CAP-3: attach to a terminal's output stream with terminalId + claim +
   * lastSeq (+ the `logEpoch` the cursor was issued under; a nonzero cursor
   * without one is refused as untrusted and replays everything with `reset`).
   * Verification is the gate — any failure (unknown terminal,
   * missing/wrong/revoked credential) resolves to the same generic
   * UNAUTHORIZED error with no terminal metadata or output.
   */
  attach: (
    terminalId: string,
    claim: string,
    lastSeq: number,
    logEpoch?: string
  ) => Promise<IpcResult<TerminalAttachResult>>
  /** CAP-3: possession-based rotation — old credential invalidated atomically. */
  rotateClaim: (terminalId: string, claim: string) => Promise<IpcResult<RotatedClaim>>
  /** CAP-3: revoke the credential; the PTY keeps running. */
  revokeClaim: (terminalId: string, claim: string) => Promise<IpcResult<void>>
  write: (terminalId: string, data: string) => Promise<IpcResult<void>>
  resize: (terminalId: string, cols: number, rows: number) => Promise<IpcResult<void>>
  kill: (terminalId: string) => Promise<IpcResult<void>>
  onData: (callback: TerminalDataCallback) => () => void
  onExit: (callback: TerminalExitCallback) => () => void
  onCwdChanged: (callback: TerminalCwdChangedCallback) => () => void
  getCwd: (terminalId: string) => Promise<IpcResult<string | null>>
  onGitBranchChanged: (callback: TerminalGitBranchChangedCallback) => () => void
  getGitBranch: (terminalId: string) => Promise<IpcResult<string | null>>
  onGitStatusChanged: (callback: TerminalGitStatusChangedCallback) => () => void
  getGitStatus: (terminalId: string) => Promise<IpcResult<GitStatus | null>>
  onExitCodeChanged: (callback: TerminalExitCodeChangedCallback) => () => void
  getExitCode: (terminalId: string) => Promise<IpcResult<number | null>>
  /**
   * Story 5 (preserved-PTY reattach): enumerate the server-preserved
   * terminals of a project on an AUTHED connection, each with metadata and
   * a freshly issued claim (the pre-reload claim is invalidated by the
   * re-issue). Web transport only — the desktop API never implements this
   * (desktop restore owns its PTYs in-process); callers must treat an
   * unimplemented/failed result as "nothing preserved" and fall back to
   * spawn.
   */
  listPreserved?: (projectId: string) => Promise<IpcResult<PreservedTerminalEntry[]>>
}

/** One preserved terminal as returned by the web `list_preserved` op. */
export interface PreservedTerminalEntry {
  id: string
  shell: string
  cwd: string
  pid: number
  cols: number
  rows: number
  /**
   * Fresh claim credential issued for this listing (in-memory only).
   * #851: a LIVE attachment on another connection no longer empties the
   * claim — the server issues a SHARED claim (`issue_shared` appends a
   * digest without revoking the holder's) so this client attaches to the
   * SAME PTY. Absent only when shared issuance was refused (revoked
   * record); the entry is then metadata-only and the caller must fall
   * back to spawn.
   */
  claim?: string
  /**
   * #851: `true` when another web connection currently holds a live
   * output forwarder for this terminal — the renderer labels these as
   * shared sessions instead of silently duplicating the shell.
   */
  hasLiveAttachment?: boolean
}

// Error codes
export const IpcErrorCodes = {
  TERMINAL_NOT_FOUND: 'TERMINAL_NOT_FOUND',
  SPAWN_FAILED: 'SPAWN_FAILED',
  WRITE_FAILED: 'WRITE_FAILED',
  RESIZE_FAILED: 'RESIZE_FAILED',
  KILL_FAILED: 'KILL_FAILED',
  DIALOG_CANCELED: 'DIALOG_CANCELED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  BINARY_FILE: 'BINARY_FILE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  WATCH_FAILED: 'WATCH_FAILED',
  PATH_INVALID: 'PATH_INVALID',
  FILE_EXISTS: 'FILE_EXISTS',
  DELETE_FAILED: 'DELETE_FAILED',
  RENAME_FAILED: 'RENAME_FAILED',
  // Worktree error codes
  WORKTREE_NOT_FOUND: 'WORKTREE_NOT_FOUND',
  WORKTREE_EXISTS: 'WORKTREE_EXISTS',
  WORKTREE_CREATE_FAILED: 'WORKTREE_CREATE_FAILED',
  WORKTREE_REMOVE_FAILED: 'WORKTREE_REMOVE_FAILED',
  BRANCH_ALREADY_HAS_WORKTREE: 'BRANCH_ALREADY_HAS_WORKTREE',
  NOT_A_GIT_REPO: 'NOT_A_GIT_REPO',
  GIT_NOT_FOUND: 'GIT_NOT_FOUND',
  PATH_TOO_LONG: 'PATH_TOO_LONG',
  // Session persistence error codes
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_INVALID: 'SESSION_INVALID',
  SESSION_STORE_ERROR: 'SESSION_STORE_ERROR',
  // Data migration error codes
  MIGRATION_VERSION_INVALID: 'MIGRATION_VERSION_INVALID',
  MIGRATION_HISTORY_CORRUPT: 'MIGRATION_HISTORY_CORRUPT',
  MIGRATION_EXECUTION_FAILED: 'MIGRATION_EXECUTION_FAILED',
  MIGRATION_ALREADY_RUNNING: 'MIGRATION_ALREADY_RUNNING',
  MIGRATION_NOT_FOUND: 'MIGRATION_NOT_FOUND',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED'
} as const

export type IpcErrorCode = (typeof IpcErrorCodes)[keyof typeof IpcErrorCodes]

// ============================================================================
// Worktree Types
// ============================================================================

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

// Dialog API for file/directory selection
export interface DialogApi {
  selectDirectory: () => Promise<IpcResult<string>>
  selectFile: (options?: {
    filters?: Array<{ name: string; extensions: string[] }>
    title?: string
  }) => Promise<IpcResult<string>>
}

// Shell detection types
export interface ShellInfo {
  path: string
  name: string
  displayName: string
}

export interface DetectedShells {
  default: ShellInfo | null
  available: ShellInfo[]
}

// Shell API for renderer
export interface ShellApi {
  getAvailableShells: () => Promise<IpcResult<DetectedShells>>
}

// Optional precondition/idempotency options for `PersistenceApi.write`.
export interface PersistenceWriteOpts {
  // Compare-and-set precondition (shared/cas keys): the logical value the key
  // must currently hold; `null` means the key must be absent.
  expected?: unknown
  // Idempotency id; a resend of the same write reuses it so the host can
  // recognise its own applied write.
  commandId?: string
  // The caller re-reads and resends a write that lost a compare-and-set race.
  // Such a conflict is not reported on the error bus; set it on every attempt
  // except the last one, so only the final failure reaches the user.
  retrying?: boolean
}

// A read that also reports the host's per-key revision stamp.
export interface StampedValue<T> {
  value: T
  // 0 = key absent (desktop plugin-store has no revisions and always reports 0).
  revision: number
  clientInstanceId: string | null
}

// Codes of failed store writes that the user must hear about: the value was
// not saved and the writer cannot fix it alone.
export const PERSISTENCE_ERROR_CODES = [
  'STORE_VALUE_TOO_LARGE',
  'STORE_PARTITION_FULL',
  'STORE_NOT_HYDRATED',
  'STORE_WRITE_FAILED',
  'STORE_BASE_REQUIRED',
  'STORE_CAS_FAILED'
] as const

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number]

// One failed write, by logical key.
export interface PersistenceErrorEvent {
  key: string
  code: PersistenceErrorCode
  message: string
}

export type PersistenceErrorListener = (event: PersistenceErrorEvent) => void

// What a store key holds, as a watch reports it (the stored envelope is unwrapped).
export interface PersistenceKeyChange<T = unknown> {
  // `false` when the key is absent (never written, or deleted).
  exists: boolean
  data?: T
}

// Persistence API for renderer
export interface PersistenceApi {
  read: <T>(key: string) => Promise<IpcResult<T>>
  readStamped: <T>(key: string) => Promise<IpcResult<StampedValue<T>>>
  write: <T>(key: string, data: T, opts?: PersistenceWriteOpts) => Promise<IpcResult<void>>
  writeDebounced: <T>(key: string, data: T) => Promise<IpcResult<void>>
  flushPendingWrites: () => Promise<IpcResult<void>>
  delete: (key: string) => Promise<IpcResult<void>>
  // Subscribe to failed writes (any caller, debounced or not). Returns the
  // unsubscribe function. The desktop plugin-store never emits.
  onPersistenceError: (listener: PersistenceErrorListener) => () => void
  // Web only: report each change another device or tab makes to a key (by
  // logical key), once this page has read it. Echoes of this page's own writes
  // are not reported. Returns the unsubscribe function. Absent on the desktop.
  watchShared?: (key: string, listener: (change: PersistenceKeyChange) => void) => () => void
}

// System API for renderer
export interface SystemApi {
  getHomeDirectory: () => Promise<IpcResult<string>>
  onPowerResume: (callback: () => void) => () => void
}

// Keyboard shortcut callback for main -> renderer communication
export type KeyboardShortcutCallback = (
  shortcut:
    | 'nextTerminal'
    | 'prevTerminal'
    | 'zoomIn'
    | 'zoomOut'
    | 'zoomReset'
    | 'sidebarToggle'
    | 'colorThemePicker'
) => void

// Keyboard API for renderer
export interface KeyboardApi {
  onShortcut: (callback: KeyboardShortcutCallback) => () => void
}

// Window maximize state callback for main -> renderer communication
export type WindowMaximizeChangedCallback = (isMaximized: boolean) => void

// App close coordination types
export type AppCloseResponse = 'close' | 'cancel'
export type AppCloseRequestedCallback = () => Promise<boolean>

// Window API for renderer
export interface WindowApi {
  minimize: () => void
  toggleMaximize: () => Promise<IpcResult<boolean>>
  close: () => void
  onMaximizeChange: (callback: WindowMaximizeChangedCallback) => () => void
  onCloseRequested: (callback: AppCloseRequestedCallback) => () => void
  respondToClose: (response: AppCloseResponse) => void
}

// Clipboard API for renderer
export interface ClipboardApi {
  readText: () => Promise<IpcResult<string>>
  writeText: (text: string) => Promise<IpcResult<void>>
  hasImage: () => Promise<IpcResult<boolean>>
}

// Visibility API for renderer to notify main process of visibility changes
export interface VisibilityApi {
  setVisibilityState: (isVisible: boolean) => Promise<IpcResult<void>>
}

/** Network bind scope for the embedded remote terminal server. */
export type RemoteBindMode = 'localhost' | 'all'

// Remote terminal server status (mirrors Rust remote::RemoteStatus)
export interface RemoteStatus {
  running: boolean
  url: string | null
  port: number | null
  /** `localhost` or `all` while running. */
  bindMode: RemoteBindMode | null
  /** `127.0.0.1` or `0.0.0.0` while running. */
  bindHost: string | null
  /** Ephemeral `https://*.trycloudflare.com` tunnel URL (QR-encoded). */
  tunnelUrl: string | null
}

// Remote terminal server control API
export interface RemoteServerApi {
  start: (options?: { bindMode?: RemoteBindMode }) => Promise<IpcResult<RemoteStatus>>
  stop: () => Promise<IpcResult<RemoteStatus>>
  status: () => Promise<IpcResult<RemoteStatus>>
}

// Filesystem types re-exported for convenience
import type {
  DirectoryEntry,
  FileChangeEvent,
  FileContent,
  FileInfo,
  FileSearchResponse,
  SearchFileHit
} from './filesystem.types'

export type FileChangeCallback = (event: FileChangeEvent) => void

// Filesystem API for renderer
export type SearchStreamErrorCode =
  | 'QUERY_TOO_LONG'
  | 'PATH_VALIDATION_FAILED'
  | 'RG_SPAWN_FAILED'
  | 'RG_STDOUT_CAPTURE_FAILED'
  | 'RG_STREAM_FAILED'
  | (string & {})

/** Per-path failure detail for `grantFsScope`. */
export interface FsScopeGrantFailure {
  path: string
  error: string
}

/** Summary of a `grantFsScope` call: granted paths and per-path failures. */
export interface FsScopeGrantSummary {
  granted: string[]
  failed: FsScopeGrantFailure[]
}

export interface FilesystemApi {
  /**
   * Re-grant runtime fs scope for restored project roots/worktrees. The
   * dialog plugin's pick-time grant is lost on restart; restored roots on
   * non-allowlisted drives fail with "forbidden path" without this. Web mode
   * is a no-op (fs goes through the server's own permission model).
   */
  grantFsScope: (paths: string[]) => Promise<IpcResult<FsScopeGrantSummary>>
  readDirectory: (dirPath: string) => Promise<IpcResult<DirectoryEntry[]>>
  readFile: (filePath: string) => Promise<IpcResult<HashedFileContent>>
  getFileInfo: (filePath: string) => Promise<IpcResult<FileInfo>>
  searchContent: (
    scopeRoot: string,
    rootPath: string,
    query: string
  ) => Promise<IpcResult<FileSearchResponse>>
  searchContentStreamStart: (
    searchId: string,
    scopeRoot: string,
    rootPath: string,
    query: string
  ) => Promise<IpcResult<void>>
  searchContentStreamCancel: (searchId: string) => Promise<IpcResult<void>>
  onSearchContentBatch: (
    callback: (event: {
      searchId: string
      results: FileSearchResponse['results']
      truncated: boolean
    }) => void
  ) => () => void
  onSearchContentDone: (
    callback: (event: {
      searchId: string
      truncated: boolean
      scannedFiles: number
      failedFiles: number
      /** See `SearchStreamErrorCode` for possible values. */
      code?: SearchStreamErrorCode
      error?: string
    }) => void
  ) => () => void
  searchFileNamesStreamStart: (
    searchId: string,
    scopeRoot: string,
    rootPath: string,
    query: string,
    /** When true, surface ignored/hidden files with `ignored: true` (ADR 0003). */
    includeIgnored?: boolean
  ) => Promise<IpcResult<void>>
  searchFileNamesStreamCancel: (searchId: string) => Promise<IpcResult<void>>
  onSearchFileNamesBatch: (
    callback: (event: { searchId: string; files: SearchFileHit[]; truncated?: boolean }) => void
  ) => () => void
  onSearchFileNamesDone: (
    callback: (event: {
      searchId: string
      truncated: boolean
      totalFiles: number
      /**
       * Programmatic error code. One of:
       * - `QUERY_TOO_LONG`         — query exceeded `MAX_SEARCH_QUERY_LEN`.
       * - `PATH_VALIDATION_FAILED` — scope/root failed `validate_search_path`.
       * - `RG_SPAWN_FAILED`        — ripgrep binary failed to start.
       * - `RG_STDOUT_CAPTURE_FAILED` — stdout pipe could not be captured.
       * - `RG_STREAM_FAILED`       — stdout read failed, or rg exited with a
       *   non-zero status other than `1` (no matches).
       */
      code?: SearchStreamErrorCode
      error?: string
    }) => void
  ) => () => void
  /** `options.expected` (web only): refuse with `PRECONDITION_FAILED` when the file changed since it was read. */
  writeFile: (
    filePath: string,
    content: string,
    options?: { expected?: FsWriteExpected }
  ) => Promise<IpcResult<void>>
  createFile: (filePath: string, content?: string) => Promise<IpcResult<void>>
  createDirectory: (dirPath: string) => Promise<IpcResult<void>>
  deletePath: (path: string, options?: { recursive?: boolean }) => Promise<IpcResult<void>>
  renameFile: (oldPath: string, newPath: string) => Promise<IpcResult<void>>
  copyFile: (srcPath: string, destPath: string) => Promise<IpcResult<void>>
  watchDirectory: (dirPath: string) => Promise<IpcResult<void>>
  unwatchDirectory: (dirPath: string) => Promise<IpcResult<void>>
  onFileChanged: (callback: FileChangeCallback) => () => void
  onFileCreated: (callback: FileChangeCallback) => () => void
  onFileDeleted: (callback: FileChangeCallback) => () => void
}

export type {
  DirectoryEntry,
  FileChangeEvent,
  FileContent,
  FileInfo,
  FileSearchResponse,
  SearchFileHit
}

// ============================================================================
// Session Persistence Types
// ============================================================================

/**
 * Captured DEC private-mode state for terminal rehydration across refresh (R3).
 *
 * Mirrors Orca's `buildRehydrateSequences` mode set. Only the modes currently ON
 * are replayed (via `buildRehydrateSequences`) before the captured scrollback
 * content, so an alt-screen TUI (vim/tmux/less/htop) restores identically.
 * Modes are optional everywhere — absence degrades to content-only restore
 * (the pre-R3 behavior).
 */
export interface TerminalModes {
  /** Alt-screen on (DEC 1049/1047/47). Replay emits `\x1b[?1049h` (attrs reset first). */
  alternateScreen: boolean
  /** Bracketed-paste on (DEC 2004). Replay emits `\x1b[?2004h`. */
  bracketedPaste: boolean
  /** Application-cursor keys on (DEC 1). Replay emits `\x1b[?1h`. */
  applicationCursor: boolean
  /** Mouse tracking mode: `x10` (1000), `drag` (1002), `any` (1003); null = off. */
  mouseTracking?: 'x10' | 'drag' | 'any' | null
  /** SGR mouse encoding (DEC 1006). Replay emits `\x1b[?1006h`. */
  sgrMouseMode?: boolean
  /** SGR pixel mouse encoding (DEC 1016). Replay emits `\x1b[?1016h`. */
  sgrMousePixelsMode?: boolean
}

/**
 * Terminal session data for persistence
 * Subset of terminal instance with additional state for restoration
 */
export interface TerminalSession {
  id: string
  shell: string
  cwd: string
  history: string[]
  env?: Record<string, string>
  /**
   * Captured DEC private-mode snapshot (R3). Replayed before `history` on
   * restore so an alt-screen TUI screen/modes survive refresh. Optional:
   * absence (old save or capture unavailable) degrades to content-only restore.
   */
  modes?: TerminalModes
}

/**
 * Workspace state for persistence
 * Contains workspace configuration and active terminals
 */
export interface WorkspaceState {
  projectId: string
  activeTerminalId: string | null
  terminals: TerminalSession[]
}

/**
 * Complete session data structure
 * Contains all application state needed to restore session on app launch
 */
export interface SessionData {
  timestamp: string
  terminals: TerminalSession[]
  workspaces: WorkspaceState[]
}

/**
 * Session API for renderer
 * Handles session persistence operations (save, restore, clear, flush)
 */
export interface SessionApi {
  /**
   * Save complete session data
   */
  save: (sessionData: SessionData) => Promise<IpcResult<void>>

  /**
   * Restore session from disk
   */
  restore: () => Promise<IpcResult<SessionData>>

  /**
   * Clear saved session from disk
   */
  clear: () => Promise<IpcResult<void>>

  /**
   * Flush any pending auto-save operations
   */
  flush: () => Promise<IpcResult<void>>

  /**
   * Check if a saved session exists
   */
  hasSession: () => Promise<IpcResult<boolean>>
}

// ============================================================================
// Data Migration Types
// ============================================================================
//
// CANONICAL MIGRATION API CONTRACT
// =================================
// All layers must follow this contract for consistency.
//
// Method names (canonical):
// - getVersion()     - Get current schema version
// - getSchemaInfo()  - Get current and target schema versions
// - getHistory()     - Get migration history records
// - getRegistered()  - Get all registered migrations
// - runMigration()   - Run all pending migrations (singular!)
// - rollback()       - Rollback to a specific version
//
// Rust command names (snake_case):
// - data_migration_get_version
// - data_migration_get_schema_info
// - data_migration_get_history
// - data_migration_get_registered
// - data_migration_run_migrations
// - data_migration_rollback
//
// Error codes:
// - MIGRATION_VERSION_INVALID: Current version is corrupted
// - MIGRATION_HISTORY_CORRUPT: Migration history is corrupted
// - MIGRATION_EXECUTION_FAILED: A migration function failed
// - MIGRATION_ALREADY_RUNNING: Another migration is in progress
// - MIGRATION_NOT_FOUND: Requested migration version not found
// - ROLLBACK_FAILED: Rollback operation failed
// ============================================================================

/**
 * Migration record in history
 */
export interface MigrationRecord {
  version: string
  timestamp: string
  success: boolean
  error?: string
  duration?: number // in milliseconds
}

/**
 * Migration result
 */
export interface MigrationResult {
  version: string
  success: boolean
  error?: string
  duration: number
}

/**
 * Migration run result (can include partial results on failure)
 *
 * Note: The backend returns IpcResult<MigrationResult[]>, but we transform
 * it to MigrationRunResult to preserve partial results on failure.
 */
export type MigrationRunResult =
  | { success: true; data: MigrationResult[]; code?: never; error?: never }
  | {
      success: false
      error: string
      code: string
      partialResults?: MigrationResult[]
    }

/**
 * Schema version info
 */
export interface SchemaVersion {
  current: string
  target: string
}

/**
 * Registered migration info
 */
export interface MigrationInfo {
  version: string
  description: string
}

/**
 * Rollback request payload
 *
 * This type defines the structure for rollback requests.
 * Tauri automatically flattens single-struct parameters when invoking.
 *
 * The Rust side defines:
 * ```rust
 * #[derive(Debug, Clone, Deserialize)]
 * #[serde(rename_all = "camelCase")]
 * pub struct RollbackRequest {
 *     pub version: String,
 * }
 *
 * #[tauri::command]
 * pub async fn data_migration_rollback(request: RollbackRequest, ...) -> Result<IpcResult<()>, String>
 * ```
 *
 * Invoke from TypeScript:
 * ```ts
 * // Tauri flattens single-struct parameters automatically
 * invoke('data_migration_rollback', { version: '1.2.0' })
 * ```
 *
 * Note: For multi-parameter commands, you would wrap in a payload object.
 * Single-struct parameters are flattened for convenience.
 */
export interface RollbackRequest {
  version: string
}

/**
 * @deprecated Use RollbackRequest from the canonical contract instead.
 * This is an alias for backward compatibility.
 */
export type RollbackRequestPayload = RollbackRequest

/**
 * Canonical Migration API Contract
 *
 * This interface defines the contract that all layers (Tauri, Electron)
 * must implement for data migration operations.
 *
 * Implementation notes:
 * - getVersion returns "0.0.0" for fresh installs (no migrations run)
 * - runMigration returns MigrationRunResult (not IpcResult) to preserve partial results
 * - rollback accepts a version string and returns IpcResult<void>
 *
 * All methods use the IpcResult<T> pattern for consistent error handling,
 * except runMigration which uses MigrationRunResult to include partial results.
 */
export interface MigrationApi {
  /**
   * Get current schema version
   *
   * Returns the currently applied schema version.
   * Returns "0.0.0" for fresh installs (no migrations have been run).
   *
   * @returns IpcResult with version string (e.g., "1.2.3")
   */
  getVersion: () => Promise<IpcResult<string>>

  /**
   * Get schema version info (current and target versions)
   *
   * Returns both the current version and the target (latest registered) version.
   * Useful for checking if migrations are pending (current < target).
   *
   * @returns IpcResult with SchemaVersion containing current and target
   */
  getSchemaInfo: () => Promise<IpcResult<SchemaVersion>>

  /**
   * Get migration history
   *
   * Returns an array of all migration records including both successful
   * and failed migrations. Each record contains version, timestamp,
   * success status, optional error message, and duration.
   *
   * @returns IpcResult with array of MigrationRecord
   */
  getHistory: () => Promise<IpcResult<MigrationRecord[]>>

  /**
   * Get all registered migrations
   *
   * Returns info about all available migrations without running them.
   * Useful for displaying available/pending migrations to the user.
   *
   * @returns IpcResult with array of MigrationInfo
   */
  getRegistered: () => Promise<IpcResult<MigrationInfo[]>>

  /**
   * Run all pending migrations
   *
   * Executes all migrations from current version to latest registered version.
   * Returns an array of migration results, one for each migration executed.
   *
   * IMPORTANT: Returns MigrationRunResult (not IpcResult) to preserve
   * partial results when some migrations succeed but others fail.
   *
   * Error codes:
   * - MIGRATION_VERSION_INVALID: Current version is corrupted
   * - MIGRATION_HISTORY_CORRUPT: Migration history is corrupted
   * - MIGRATION_EXECUTION_FAILED: A migration function failed
   * - MIGRATION_ALREADY_RUNNING: Another migration is in progress
   *
   * @returns MigrationRunResult with success status and migration results
   */
  runMigration: () => Promise<MigrationRunResult>

  /**
   * Rollback to a specific version
   *
   * Reverts the database to the specified version by running rollback
   * functions for migrations newer than the target version.
   *
   * Note: Requires migrations to have rollback functions registered.
   *
   * Error codes:
   * - MIGRATION_NOT_FOUND: Target version not found in migrations
   * - ROLLBACK_FAILED: Rollback function failed or not available
   *
   * @param version - Version to rollback to (e.g., "1.2.0")
   * @returns IpcResult<void>
   */
  rollback: (version: string) => Promise<IpcResult<void>>
}
