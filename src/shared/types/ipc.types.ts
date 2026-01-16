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
export type TerminalDataCallback = (terminalId: string, data: string) => void
export type TerminalExitCallback = (terminalId: string, exitCode: number, signal?: number) => void
export type TerminalCwdChangedCallback = (terminalId: string, cwd: string) => void
export type TerminalGitBranchChangedCallback = (terminalId: string, branch: string | null) => void
export type TerminalGitStatusChangedCallback = (terminalId: string, status: GitStatus | null) => void
export type TerminalExitCodeChangedCallback = (terminalId: string, exitCode: number) => void

// Git status interface
export interface GitStatus {
  modified: number
  staged: number
  untracked: number
  hasChanges: boolean
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
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
} as const

export type IpcErrorCode = (typeof IpcErrorCodes)[keyof typeof IpcErrorCodes]

// Dialog API for file/directory selection
export interface DialogApi {
  selectDirectory: () => Promise<IpcResult<string>>
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
  delete: (key: string) => Promise<IpcResult<void>>
}

// System API for renderer
export interface SystemApi {
  getHomeDirectory: () => Promise<IpcResult<string>>
}

// Keyboard shortcut callback for main -> renderer communication
export type KeyboardShortcutCallback = (shortcut: 'nextTerminal' | 'prevTerminal' | 'zoomIn' | 'zoomOut' | 'zoomReset') => void

// Keyboard API for renderer
export interface KeyboardApi {
  onShortcut: (callback: KeyboardShortcutCallback) => () => void
}

// ============================================================================
// Worktree Types (Story 1.3)
// ============================================================================

// Worktree status from Git operations (runtime-only, NOT persisted)
export interface WorktreeStatus {
  dirty: boolean
  ahead: number
  behind: number
  conflicted: boolean
  currentBranch: string
  updatedAt?: number
}

// Worktree metadata (persisted to disk)
export interface WorktreeMetadata {
  id: string
  projectId: string
  branchName: string
  worktreePath: string
  createdAt: string
  lastAccessedAt: string
  isArchived: boolean
  gitignoreProfile?: string
}

// Archived worktree metadata
export interface ArchivedWorktree {
  originalPath: string
  archivePath: string
  archivedAt: string
  expiresAt: string
  branchName: string
  projectId: string
  unpushedCommits: boolean
  commitCount: number
}

// DTOs for worktree operations
export interface CreateWorktreeDto {
  projectId: string
  branchName: string
  gitignoreSelections: string[]
}

export interface DeleteWorktreeOptions {
  force?: boolean
  deleteBranch?: boolean
}

// Worktree error codes
export const WorktreeErrorCode = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  BRANCH_ALREADY_CHECKED_OUT: 'BRANCH_ALREADY_CHECKED_OUT',
  GIT_OPERATION_FAILED: 'GIT_OPERATION_FAILED',
  PATH_EXISTS: 'PATH_EXISTS',
  INSUFFICIENT_DISK_SPACE: 'INSUFFICIENT_DISK_SPACE',
  GIT_VERSION_TOO_OLD: 'GIT_VERSION_TOO_OLD',
  WORKTREE_NOT_FOUND: 'WORKTREE_NOT_FOUND',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED'
} as const

export type WorktreeErrorCodeType = (typeof WorktreeErrorCode)[keyof typeof WorktreeErrorCode]

// Event callback types
export type StatusChangedCallback = (worktreeId: string, status: WorktreeStatus) => void
export type WorktreeCreatedCallback = (worktree: WorktreeMetadata) => void
export type WorktreeDeletedCallback = (worktreeId: string) => void
export type Unsubscribe = () => void

// Worktree API exposed via preload
export interface WorktreeApi {
  list: (projectId: string) => Promise<IpcResult<WorktreeMetadata[]>>
  create: (data: CreateWorktreeDto) => Promise<IpcResult<WorktreeMetadata>>
  delete: (worktreeId: string, options?: DeleteWorktreeOptions) => Promise<IpcResult<void>>
  archive: (worktreeId: string) => Promise<IpcResult<ArchivedWorktree>>
  restore: (archiveId: string, projectId: string) => Promise<IpcResult<WorktreeMetadata>>
  listArchived: (projectId: string) => Promise<IpcResult<ArchivedWorktree[]>>
  deleteArchive: (archiveId: string, projectId: string) => Promise<IpcResult<void>>
  cleanupArchives: (projectId: string) => Promise<IpcResult<{ cleaned: number }>>
  getStatus: (worktreeId: string) => Promise<IpcResult<WorktreeStatus>>
  onStatusChanged: (callback: StatusChangedCallback) => Unsubscribe
  onCreated: (callback: WorktreeCreatedCallback) => Unsubscribe
  onDeleted: (callback: WorktreeDeletedCallback) => Unsubscribe
}

// ============================================================================
// Gitignore Types (Story 1.4)
// ============================================================================

// Pattern category for .gitignore patterns
export type PatternCategory = 'dependencies' | 'build' | 'env' | 'cache' | 'ide' | 'test' | 'other'

// Parsed .gitignore pattern with metadata
export interface ParsedPattern {
  pattern: string
  category: PatternCategory
  isSecuritySensitive: boolean
  relatedPatterns: string[]
}

// Result of parsing .gitignore file
export interface GitignoreParseResult {
  patterns: ParsedPattern[]
  groupedPatterns: Map<PatternCategory, ParsedPattern[]>
  securityPatterns: ParsedPattern[]
}

// Gitignore profile for saved pattern selections
export interface GitignoreProfile {
  name: string
  patterns: string[]
  createdAt: string
}

// DTOs for gitignore operations
export interface ParseGitignoreDto {
  projectRoot: string
}

export interface SaveProfileDto {
  projectRoot: string
  name: string
  patterns: string[]
}

export interface DeleteProfileDto {
  projectRoot: string
  name: string
}

export interface LoadProfilesDto {
  projectRoot: string
}

// Gitignore error codes
export const GitignoreErrorCode = {
  GITIGNORE_PARSE_FAILED: 'GITIGNORE_PARSE_FAILED',
  FILE_COPY_FAILED: 'FILE_COPY_FAILED',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_ALREADY_EXISTS: 'PROFILE_ALREADY_EXISTS',
  INVALID_PROFILE_DATA: 'INVALID_PROFILE_DATA'
} as const

export type GitignoreErrorCodeType = (typeof GitignoreErrorCode)[keyof typeof GitignoreErrorCode]

// Gitignore API exposed via preload
export interface GitignoreApi {
  parse: (dto: ParseGitignoreDto) => Promise<IpcResult<GitignoreParseResult>>
  saveProfile: (dto: SaveProfileDto) => Promise<IpcResult<void>>
  deleteProfile: (dto: DeleteProfileDto) => Promise<IpcResult<void>>
  loadProfiles: (dto: LoadProfilesDto) => Promise<IpcResult<GitignoreProfile[]>>
}
