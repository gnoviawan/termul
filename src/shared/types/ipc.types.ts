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
  RENAME_FAILED: 'RENAME_FAILED'
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
  onPowerResume: (callback: () => void) => () => void
}

// Keyboard shortcut callback for main -> renderer communication
export type KeyboardShortcutCallback = (shortcut: 'nextTerminal' | 'prevTerminal' | 'zoomIn' | 'zoomOut' | 'zoomReset') => void

// Keyboard API for renderer
export interface KeyboardApi {
  onShortcut: (callback: KeyboardShortcutCallback) => () => void
}

// Window maximize state callback for main -> renderer communication
export type WindowMaximizeChangedCallback = (isMaximized: boolean) => void

// App close coordination types
export type AppCloseResponse = 'close' | 'cancel'
export type AppCloseRequestedCallback = () => void

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
}

// Visibility API for renderer to notify main process of visibility changes
export interface VisibilityApi {
  setVisibilityState: (isVisible: boolean) => Promise<IpcResult<void>>
}

// Filesystem types re-exported for convenience
import type {
  DirectoryEntry,
  FileContent,
  FileInfo,
  FileChangeEvent,
  ReadDirectoryOptions
} from './filesystem.types'

export type FileChangeCallback = (event: FileChangeEvent) => void

// Filesystem API for renderer
export interface FilesystemApi {
  readDirectory: (
    dirPath: string,
    options?: ReadDirectoryOptions
  ) => Promise<IpcResult<DirectoryEntry[]>>
  readFile: (filePath: string) => Promise<IpcResult<FileContent>>
  getFileInfo: (filePath: string) => Promise<IpcResult<FileInfo>>
  writeFile: (filePath: string, content: string) => Promise<IpcResult<void>>
  createFile: (filePath: string, content?: string) => Promise<IpcResult<void>>
  createDirectory: (dirPath: string) => Promise<IpcResult<void>>
  deleteFile: (filePath: string) => Promise<IpcResult<void>>
  renameFile: (
    oldPath: string,
    newPath: string
  ) => Promise<IpcResult<void>>
  watchDirectory: (dirPath: string) => Promise<IpcResult<void>>
  unwatchDirectory: (dirPath: string) => Promise<IpcResult<void>>
  onFileChanged: (callback: FileChangeCallback) => () => void
  onFileCreated: (callback: FileChangeCallback) => () => void
  onFileDeleted: (callback: FileChangeCallback) => () => void
}

export type {
  DirectoryEntry,
  FileContent,
  FileInfo,
  FileChangeEvent,
  ReadDirectoryOptions
}
