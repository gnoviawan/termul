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

// Clipboard API for renderer
export interface ClipboardApi {
  readText: () => Promise<IpcResult<string>>
  writeText: (text: string) => Promise<IpcResult<void>>
}
