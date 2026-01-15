import type { IpcResult } from './ipc.types'

// Updater information for available updates
export interface UpdateInfo {
  version: string
  releaseDate: string
  releaseNotes?: string
  isSecurityUpdate: boolean
  downloadUrl?: string
}

// Current state of the updater
export interface UpdateState {
  updateAvailable: boolean
  downloaded: boolean
  version: string | null
  isChecking: boolean
  isDownloading: boolean
  downloadProgress: DownloadProgress | null
  error: string | null
  lastChecked: string | null // ISO timestamp
}

// Data stored when user skips a version
export interface SkipVersionData {
  version: string
  skippedAt: string // ISO timestamp
}

// Download progress information
export interface DownloadProgress {
  bytesPerSecond: number
  percent: number
  transferred: number
  total: number
}

// Error codes for updater operations
export const UpdaterErrorCodes = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  OFFLINE: 'OFFLINE',
  UPDATE_NOT_AVAILABLE: 'UPDATE_NOT_AVAILABLE',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  INSTALL_FAILED: 'INSTALL_FAILED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  DISK_SPACE_INSUFFICIENT: 'DISK_SPACE_INSUFFICIENT',
  INVALID_UPDATE_INFO: 'INVALID_UPDATE_INFO',
  UPDATE_CHECK_FAILED: 'UPDATE_CHECK_FAILED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
} as const

export type UpdaterErrorCode = (typeof UpdaterErrorCodes)[keyof typeof UpdaterErrorCodes]

// IPC channel definitions for updater
export type UpdaterIpcChannels = {
  'updater:checkForUpdates': () => IpcResult<UpdateInfo | null>
  'updater:downloadUpdate': () => IpcResult<void>
  'updater:installAndRestart': () => IpcResult<void>
  'updater:skipVersion': (version: string) => IpcResult<void>
  'updater:getState': () => IpcResult<UpdateState>
  'updater:setAutoUpdateEnabled': (enabled: boolean) => IpcResult<void>
  'updater:getAutoUpdateEnabled': () => IpcResult<boolean>
}

// Event types for main -> renderer communication
export type UpdateAvailableCallback = (info: UpdateInfo) => void
export type UpdateDownloadedCallback = (info: UpdateInfo) => void
export type DownloadProgressCallback = (progress: DownloadProgress) => void
export type UpdaterErrorCallback = (error: string, code: UpdaterErrorCode) => void

// Updater API exposed via preload
export interface UpdaterApi {
  checkForUpdates: () => Promise<IpcResult<UpdateInfo | null>>
  downloadUpdate: () => Promise<IpcResult<void>>
  installAndRestart: () => Promise<IpcResult<void>>
  skipVersion: (version: string) => Promise<IpcResult<void>>
  getState: () => Promise<IpcResult<UpdateState>>
  setAutoUpdateEnabled: (enabled: boolean) => Promise<IpcResult<void>>
  getAutoUpdateEnabled: () => Promise<IpcResult<boolean>>
  onUpdateAvailable: (callback: UpdateAvailableCallback) => () => void
  onUpdateDownloaded: (callback: UpdateDownloadedCallback) => () => void
  onDownloadProgress: (callback: DownloadProgressCallback) => () => void
  onError: (callback: UpdaterErrorCallback) => () => void
}
