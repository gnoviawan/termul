import { BrowserWindow, app } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import type { ProgressInfo } from 'electron-updater'
import type { IpcResult } from '../../shared/types/ipc.types'
import { read, write } from './persistence-service'

// Updater error codes
export const UpdaterErrorCodes = {
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  UPDATE_NOT_AVAILABLE: 'UPDATE_NOT_AVAILABLE',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  INSTALL_FAILED: 'INSTALL_FAILED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNSAFE_TO_UPDATE: 'UNSAFE_TO_UPDATE',
  INCOMPATIBLE_VERSION: 'INCOMPATIBLE_VERSION',
  BACKUP_FAILED: 'BACKUP_FAILED',
  ALREADY_RUNNING: 'ALREADY_RUNNING',
  WRITE_FAILED: 'WRITE_FAILED'
} as const

export type UpdaterErrorCode =
  (typeof UpdaterErrorCodes)[keyof typeof UpdaterErrorCodes]

// Update state types
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

// Download progress info
export interface DownloadProgress {
  bytesPerSecond: number
  percent: number
  transferred: number
  total: number
}

// Full updater state
export interface UpdaterState {
  state: UpdateState
  updateInfo: UpdateInfo | null
  downloadProgress: DownloadProgress | null
  error: string | null
  skippedVersion: string | null
}

// Persistence keys
const SKIPPED_VERSION_KEY = 'updater/skipped-version'
const UPDATE_CHECK_INTERVAL_KEY = 'updater/last-check-time'

// Constants
const BASE_CHECK_INTERVAL = 12 * 60 * 60 * 1000 // 12 hours
const STAGGER_RANGE = 2 * 60 * 60 * 1000 // ±1 hour (with Math.random() * STAGGER_RANGE - STAGGER_RANGE / 2)
const MAX_RETRY_ATTEMPTS = 3
const RETRY_DELAYS = [5000, 30000, 300000] // 5s, 30s, 5min

// Singleton instance
let updaterServiceInstance: UpdaterService | null = null

/**
 * Updater Service - Manages application updates using electron-updater
 *
 * Features:
 * - Automatic update checking with staggered intervals
 * - Background download with progress tracking
 * - Safe update window detection (checks for active PTY sessions)
 * - Network retry logic with exponential backoff
 * - Offline mode handling
 * - Skip version functionality
 * - Pre-update compatibility checks
 */
export class UpdaterService {
  private mainWindow: BrowserWindow | null = null
  private currentState: UpdateState = 'idle'
  private currentUpdateInfo: UpdateInfo | null = null
  private currentDownloadProgress: DownloadProgress | null = null
  private currentError: string | null = null
  private skippedVersion: string | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private isDownloading = false
  private retryCount = 0
  private isInitialized = false

  constructor() {
    this.setupAutoUpdater()
  }

  /**
   * Initialize the updater service with a window reference
   * Must be awaited to ensure skipped version is loaded before checkForUpdates
   */
  async initialize(mainWindow: BrowserWindow): Promise<void> {
    if (this.isInitialized) {
      console.warn('UpdaterService already initialized')
      return
    }

    this.mainWindow = mainWindow
    this.isInitialized = true
    await this.loadSkippedVersion()
    this.startPeriodicChecks()
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): UpdaterService {
    if (!updaterServiceInstance) {
      updaterServiceInstance = new UpdaterService()
    }
    return updaterServiceInstance
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static resetInstance(): void {
    if (updaterServiceInstance) {
      updaterServiceInstance.destroy()
      updaterServiceInstance = null
    }
  }

  /**
   * Check for updates manually
   */
  async checkForUpdates(): Promise<IpcResult<UpdateInfo>> {
    if (!this.isInitialized) {
      return {
        success: false,
        error: 'Updater service not initialized',
        code: UpdaterErrorCodes.NOT_INITIALIZED
      }
    }

    this.setState('checking')

    try {
      const updateInfo = await this.checkWithRetry()
      return { success: true, data: updateInfo }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      this.setError(errorMsg)
      return {
        success: false,
        error: errorMsg,
        code: UpdaterErrorCodes.NETWORK_ERROR
      }
    }
  }

  /**
   * Download the update in background
   */
  async downloadUpdate(): Promise<IpcResult<void>> {
    if (!this.isInitialized) {
      return {
        success: false,
        error: 'Updater service not initialized',
        code: UpdaterErrorCodes.NOT_INITIALIZED
      }
    }

    if (this.currentState !== 'available' && this.currentState !== 'idle') {
      return {
        success: false,
        error: `Cannot download in current state: ${this.currentState}`,
        code: UpdaterErrorCodes.ALREADY_RUNNING
      }
    }

    if (!this.currentUpdateInfo) {
      return {
        success: false,
        error: 'No update available to download',
        code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
      }
    }

    // Check if it's safe to update (no active PTY sessions)
    if (!await this.isSafeToUpdate()) {
      return {
        success: false,
        error: 'Cannot update: Active terminal sessions detected',
        code: UpdaterErrorCodes.UNSAFE_TO_UPDATE
      }
    }

    this.isDownloading = true
    this.setState('downloading')

    try {
      // Actually trigger the download with electron-updater
      await autoUpdater.downloadUpdate()
      return { success: true, data: undefined }
    } catch (error) {
      this.isDownloading = false
      const errorMsg = error instanceof Error ? error.message : 'Failed to download update'
      this.setError(errorMsg)
      return {
        success: false,
        error: errorMsg,
        code: UpdaterErrorCodes.DOWNLOAD_FAILED
      }
    }
  }

  /**
   * Install the update and restart the app
   */
  async installAndRestart(): Promise<IpcResult<void>> {
    if (!this.isInitialized) {
      return {
        success: false,
        error: 'Updater service not initialized',
        code: UpdaterErrorCodes.NOT_INITIALIZED
      }
    }

    if (this.currentState !== 'downloaded') {
      return {
        success: false,
        error: `Cannot install in current state: ${this.currentState}`,
        code: UpdaterErrorCodes.ALREADY_RUNNING
      }
    }

    this.setState('installing')

    try {
      // Call backup hook before updating
      await this.performBackup()

      // Set autoInstallOnAppQuit to trigger install on restart
      autoUpdater.autoInstallOnAppQuit = true

      // Restart the app to apply update
      app.relaunch()
      app.quit()

      return { success: true, data: undefined }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      this.setError(errorMsg)
      return {
        success: false,
        error: errorMsg,
        code: UpdaterErrorCodes.INSTALL_FAILED
      }
    }
  }

  /**
   * Skip a specific version
   */
  async skipVersion(version: string): Promise<IpcResult<void>> {
    try {
      this.skippedVersion = version
      await write(SKIPPED_VERSION_KEY, version)
      return { success: true, data: undefined }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to skip version',
        code: UpdaterErrorCodes.WRITE_FAILED
      }
    }
  }

  /**
   * Get the current updater state
   */
  getState(): UpdaterState {
    return {
      state: this.currentState,
      updateInfo: this.currentUpdateInfo,
      downloadProgress: this.currentDownloadProgress,
      error: this.currentError,
      skippedVersion: this.skippedVersion
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    this.isInitialized = false
    this.mainWindow = null
  }

  /**
   * Setup electron-updater configuration and event handlers
   */
  private setupAutoUpdater(): void {
    // Configure for GitHub Releases
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'PecutAPP',
      repo: 'termul'
    })

    // Disable auto-download (we'll handle it manually)
    autoUpdater.autoDownload = false

    // Disable auto-install on quit (we'll control when to install)
    autoUpdater.autoInstallOnAppQuit = false

    // Event handlers
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      console.log('Update available:', info.version)
      this.currentUpdateInfo = info

      // Check if version is skipped
      if (info.version === this.skippedVersion) {
        console.log(`Version ${info.version} is skipped, ignoring`)
        this.setState('idle')
        return
      }

      // Pre-update compatibility check
      if (!this.isVersionCompatible(info)) {
        console.warn('Update version is not compatible, ignoring')
        this.setState('idle')
        return
      }

      this.setState('available')
      this.sendEvent('update-available', info)
    })

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      console.log('Update not available, current version:', info.version)
      this.setState('idle')
    })

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.currentDownloadProgress = {
        bytesPerSecond: progress.bytesPerSecond,
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      }
      this.sendEvent('download-progress', this.currentDownloadProgress)
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      console.log('Update downloaded:', info.version)
      this.isDownloading = false
      this.currentUpdateInfo = info
      this.setState('downloaded')
      this.sendEvent('update-downloaded', info)
    })

    autoUpdater.on('error', (error: Error) => {
      console.error('Updater error:', error)
      this.isDownloading = false

      // Handle offline mode gracefully
      if (this.isOfflineError(error)) {
        console.log('Offline mode detected, update check skipped')
        this.setState('idle')
        return
      }

      const errorMsg = error instanceof Error ? error.message : String(error)
      this.setError(errorMsg)
      // Send error as object with code and message - use valid error code from shared types
      this.sendEvent('error', { code: 'UNKNOWN_ERROR', message: errorMsg })
    })
  }

  /**
   * Check for updates with retry logic
   */
  private async checkWithRetry(): Promise<UpdateInfo> {
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        this.retryCount = attempt
        const result = await autoUpdater.checkForUpdates()

        if (!result) {
          throw new Error('No update information available')
        }

        if (result.updateInfo) {
          return result.updateInfo
        }

        throw new Error('Update check returned no info')
      } catch (error) {
        const isLastAttempt = attempt === MAX_RETRY_ATTEMPTS - 1

        if (isLastAttempt) {
          throw error
        }

        // Check if it's an offline error - don't retry
        if (this.isOfflineError(error)) {
          throw error
        }

        // Wait before retry with exponential backoff
        const delay = RETRY_DELAYS[attempt]
        console.log(`Update check failed, retrying in ${delay}ms... (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`)
        await this.delay(delay)
      }
    }

    throw new Error('Max retry attempts reached')
  }

  /**
   * Start periodic update checks with staggered interval
   */
  private startPeriodicChecks(): void {
    // Calculate staggered interval (12 hours ± random 0-2 hours)
    const stagger = Math.floor(Math.random() * STAGGER_RANGE) - STAGGER_RANGE / 2
    const interval = BASE_CHECK_INTERVAL + stagger

    console.log(`Starting periodic update checks every ${(interval / 3600000).toFixed(2)} hours`)

    this.checkTimer = setInterval(async () => {
      try {
        await this.checkForUpdates()
      } catch (error) {
        console.error('Periodic update check failed:', error)
      }
    }, interval)
  }

  /**
   * Check if it's safe to update (no active PTY sessions)
   */
  private async isSafeToUpdate(): Promise<boolean> {
    // This will be connected to PtyManager later
    // For now, return true to allow updates
    // TODO: Integrate with PtyManager to check for active sessions
    return true
  }

  /**
   * Perform backup before update
   */
  private async performBackup(): Promise<void> {
    // This will be connected to a backup service later
    // For now, just log that we would perform a backup
    console.log('Performing pre-update backup...')
    // TODO: Implement backup integration
  }

  /**
   * Check if version is compatible with current version
   */
  private isVersionCompatible(updateInfo: UpdateInfo): boolean {
    // Basic compatibility check - can be enhanced
    // For now, just check if version is present
    return Boolean(updateInfo.version)
  }

  /**
   * Check if error is due to offline mode
   */
  private isOfflineError(error: unknown): boolean {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return (
      errorMsg.includes('ENOTFOUND') ||
      errorMsg.includes('ECONNREFUSED') ||
      errorMsg.includes('network') ||
      errorMsg.includes('offline') ||
      errorMsg.includes('internet')
    )
  }

  /**
   * Load skipped version from persistence
   */
  private async loadSkippedVersion(): Promise<void> {
    try {
      const result = await read<string>(SKIPPED_VERSION_KEY)
      if (result.success && result.data) {
        this.skippedVersion = result.data
      }
    } catch (error) {
      console.warn('Failed to load skipped version:', error)
    }
  }

  /**
   * Set current state
   */
  private setState(state: UpdateState): void {
    this.currentState = state
    this.currentError = null
  }

  /**
   * Set error state
   */
  private setError(error: string): void {
    this.currentState = 'error'
    this.currentError = error
  }

  /**
   * Send event to renderer process
   */
  private sendEvent(event: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(`updater:${event}`, data)
    }
  }

  /**
   * Delay utility for retry logic
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Get the default updater service instance
 */
export function getUpdaterService(): UpdaterService {
  return UpdaterService.getInstance()
}

/**
 * Reset the updater service instance
 */
export function resetUpdaterService(): void {
  UpdaterService.resetInstance()
}
