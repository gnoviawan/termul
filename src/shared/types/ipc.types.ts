// IPC Result pattern from architecture.md
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
  // Index signature to satisfy Tauri's InvokeArgs constraint
  [key: string]: unknown
}

// Terminal info returned after spawn
export interface TerminalInfo {
  id: string
  shell: string
  cwd: string
}

// IPC channel definitions
export type TerminalIpcChannels = {
  'terminal:spawn': (options: TerminalSpawnOptions) => IpcResult<TerminalInfo>
  'terminal:write': (terminalId: string, data: string) => IpcResult<void>
  'terminal:resize': (terminalId: string, cols: number, rows: number) => IpcResult<void>
  'terminal:kill': (terminalId: string) => IpcResult<void>
}

// Event types for main -> renderer communication
// Terminal data callback — receives binary data as Uint8Array (via Tauri Channel)
// Previously received string via event emitter; migrated to binary Channel API in ADR-002.2
export type TerminalDataCallback = (terminalId: string, data: Uint8Array) => void
export type TerminalExitCallback = (terminalId: string, exitCode: number, signal?: number) => void
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

export interface GitApi {
  getStatus: (cwd: string) => Promise<GitStatusDetail[]>
  getDiff: (cwd: string, path: string, staged?: boolean) => Promise<string>
  stage: (cwd: string, path: string) => Promise<void>
  unstage: (cwd: string, path: string) => Promise<void>
  discard: (cwd: string, path: string) => Promise<void>
  getLog: (cwd: string, limit?: number) => Promise<GitCommit[]>
  commit: (cwd: string, summary: string, description?: string, amend?: boolean) => Promise<void>
  push: (cwd: string) => Promise<void>
  getCommitContext: (cwd: string) => Promise<GitCommitContext>
}

// Terminal API exposed via preload
export interface TerminalApi {
  spawn: (options?: TerminalSpawnOptions) => Promise<IpcResult<TerminalInfo>>
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
  updateOrphanDetection: (enabled: boolean, timeout: number | null) => Promise<IpcResult<void>>
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
}

export interface BranchInfo {
  name: string
  isRemote: boolean
  isCurrent: boolean
  upstream?: string | null
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

// Persistence API for renderer
export interface PersistenceApi {
  read: <T>(key: string) => Promise<IpcResult<T>>
  write: <T>(key: string, data: T) => Promise<IpcResult<void>>
  writeDebounced: <T>(key: string, data: T) => Promise<IpcResult<void>>
  flushPendingWrites: () => Promise<IpcResult<void>>
  delete: (key: string) => Promise<IpcResult<void>>
}

// System API for renderer
export interface SystemApi {
  getHomeDirectory: () => Promise<IpcResult<string>>
  onPowerResume: (callback: () => void) => () => void
}

// Keyboard shortcut callback for main -> renderer communication
export type KeyboardShortcutCallback = (
  shortcut: 'nextTerminal' | 'prevTerminal' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'sidebarToggle'
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
}

// One terminal entry within a remote project tree (mirrors Rust RemoteTerminal)
export interface RemoteTerminalEntry {
  ptyId: string
  name: string
  cwd?: string
}

// One project with its terminals (mirrors Rust RemoteProject)
export interface RemoteProjectEntry {
  id: string
  name: string
  terminals: RemoteTerminalEntry[]
}

// Full project tree published to the remote server (mirrors Rust ProjectTree)
export interface RemoteProjectTree {
  projects: RemoteProjectEntry[]
  // Index signature to satisfy Tauri's InvokeArgs constraint
  [key: string]: unknown
}

// Remote terminal server control API
export interface RemoteServerApi {
  start: (options?: { bindMode?: RemoteBindMode }) => Promise<IpcResult<RemoteStatus>>
  stop: () => Promise<IpcResult<RemoteStatus>>
  status: () => Promise<IpcResult<RemoteStatus>>
  publishProjects: (tree: RemoteProjectTree) => Promise<IpcResult<void>>
}

// Filesystem types re-exported for convenience
import type {
  DirectoryEntry,
  FileChangeEvent,
  FileContent,
  FileInfo,
  FileSearchResponse
} from './filesystem.types'

export type FileChangeCallback = (event: FileChangeEvent) => void

// Filesystem API for renderer
export interface FilesystemApi {
  readDirectory: (dirPath: string) => Promise<IpcResult<DirectoryEntry[]>>
  readFile: (filePath: string) => Promise<IpcResult<FileContent>>
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
      error?: string
    }) => void
  ) => () => void
  searchFileNamesStreamStart: (
    searchId: string,
    scopeRoot: string,
    rootPath: string,
    query: string
  ) => Promise<IpcResult<void>>
  searchFileNamesStreamCancel: (searchId: string) => Promise<IpcResult<void>>
  onSearchFileNamesBatch: (
    callback: (event: { searchId: string; files: string[]; truncated: boolean }) => void
  ) => () => void
  onSearchFileNamesDone: (
    callback: (event: {
      searchId: string
      truncated: boolean
      totalFiles: number
      error?: string
    }) => void
  ) => () => void
  writeFile: (filePath: string, content: string) => Promise<IpcResult<void>>
  createFile: (filePath: string, content?: string) => Promise<IpcResult<void>>
  createDirectory: (dirPath: string) => Promise<IpcResult<void>>
  deletePath: (path: string, options?: { recursive?: boolean }) => Promise<IpcResult<void>>
  renameFile: (oldPath: string, newPath: string) => Promise<IpcResult<void>>
  watchDirectory: (dirPath: string) => Promise<IpcResult<void>>
  unwatchDirectory: (dirPath: string) => Promise<IpcResult<void>>
  onFileChanged: (callback: FileChangeCallback) => () => void
  onFileCreated: (callback: FileChangeCallback) => () => void
  onFileDeleted: (callback: FileChangeCallback) => () => void
}

export type { DirectoryEntry, FileChangeEvent, FileContent, FileInfo, FileSearchResponse }

// ============================================================================
// Session Persistence Types
// ============================================================================

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
