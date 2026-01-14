import { ipcMain, BrowserWindow } from 'electron'
import type { IpcResult } from '../../shared/types/ipc.types'
import type {
  UpdateInfo as SharedUpdateInfo,
  UpdateState as SharedUpdateState,
  DownloadProgress,
  UpdaterErrorCode
} from '../../shared/types/updater.types'
import { UpdaterErrorCodes } from '../../shared/types/updater.types'
import { getUpdaterService, type UpdaterService } from '../services/updater-service'
import type { UpdateInfo as ElectronUpdateInfo } from 'electron-updater'

function createSuccessResult<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

function createErrorResult(code: string, message: string): IpcResult<never> {
  return { success: false, error: message, code }
}

let updaterService: UpdaterService | null = null

// Convert electron-updater UpdateInfo to shared UpdateInfo type
function toSharedUpdateInfo(electronInfo: ElectronUpdateInfo | null): SharedUpdateInfo | null {
  if (!electronInfo) return null
  return {
    version: electronInfo.version,
    releaseDate: electronInfo.releaseDate ? new Date(electronInfo.releaseDate).toISOString() : new Date().toISOString(),
    releaseNotes: typeof electronInfo.releaseNotes === 'string' ? electronInfo.releaseNotes : undefined,
    isSecurityUpdate: false, // Could be determined from release notes or other metadata
    downloadUrl: undefined // electron-updater doesn't expose download URL directly
  }
}

// Map internal error codes to shared error codes
function mapErrorCode(code: string): UpdaterErrorCode {
  // Map internal codes to shared codes
  const codeMap: Record<string, UpdaterErrorCode> = {
    NOT_INITIALIZED: 'UPDATE_CHECK_FAILED',
    UPDATE_NOT_AVAILABLE: 'UPDATE_NOT_AVAILABLE',
    DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
    INSTALL_FAILED: 'INSTALL_FAILED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    UNSAFE_TO_UPDATE: 'UNKNOWN_ERROR',
    INCOMPATIBLE_VERSION: 'INVALID_UPDATE_INFO',
    BACKUP_FAILED: 'DISK_SPACE_INSUFFICIENT',
    ALREADY_RUNNING: 'UNKNOWN_ERROR'
  }
  return codeMap[code] || 'UNKNOWN_ERROR'
}

// Convert internal updater state to shared UpdateState type
function toSharedUpdateState(internalState: ReturnType<UpdaterService['getState']>): SharedUpdateState {
  const stateMapping: Record<string, SharedUpdateState> = {
    idle: {
      updateAvailable: false,
      downloaded: false,
      version: null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: null
    },
    checking: {
      updateAvailable: false,
      downloaded: false,
      version: null,
      isChecking: true,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: null
    },
    available: {
      updateAvailable: true,
      downloaded: false,
      version: internalState.updateInfo?.version || null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: new Date().toISOString()
    },
    downloading: {
      updateAvailable: true,
      downloaded: false,
      version: internalState.updateInfo?.version || null,
      isChecking: false,
      isDownloading: true,
      downloadProgress: internalState.downloadProgress,
      error: null,
      lastChecked: null
    },
    downloaded: {
      updateAvailable: true,
      downloaded: true,
      version: internalState.updateInfo?.version || null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: new Date().toISOString()
    },
    installing: {
      updateAvailable: true,
      downloaded: true,
      version: internalState.updateInfo?.version || null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: null
    },
    error: {
      updateAvailable: false,
      downloaded: false,
      version: null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: internalState.error,
      lastChecked: new Date().toISOString()
    }
  }

  return stateMapping[internalState.state] || stateMapping.idle
}

export function registerUpdaterIpc(window?: BrowserWindow): void {
  if (!updaterService) {
    updaterService = getUpdaterService()
  }

  if (window) {
    updaterService.initialize(window)
  }

  // updater:checkForUpdates - Check for available updates
  ipcMain.handle('updater:checkForUpdates', async (): Promise<IpcResult<SharedUpdateInfo | null>> => {
    try {
      const result = await updaterService!.checkForUpdates()
      if (result.success) {
        const sharedInfo = toSharedUpdateInfo(result.data)
        return createSuccessResult(sharedInfo)
      }
      return createErrorResult(
        mapErrorCode(result.code),
        result.error
      )
    } catch (err) {
      return createErrorResult(
        UpdaterErrorCodes.UPDATE_CHECK_FAILED,
        err instanceof Error ? err.message : 'Unknown error checking for updates'
      )
    }
  })

  // updater:downloadUpdate - Download available update
  ipcMain.handle('updater:downloadUpdate', async (): Promise<IpcResult<void>> => {
    try {
      const result = await updaterService!.downloadUpdate()
      if (result.success) {
        return createSuccessResult(undefined)
      }
      return createErrorResult(
        mapErrorCode(result.code),
        result.error
      )
    } catch (err) {
      return createErrorResult(
        UpdaterErrorCodes.DOWNLOAD_FAILED,
        err instanceof Error ? err.message : 'Unknown error downloading update'
      )
    }
  })

  // updater:installAndRestart - Install update and restart app
  ipcMain.handle('updater:installAndRestart', async (): Promise<IpcResult<void>> => {
    try {
      const result = await updaterService!.installAndRestart()
      if (result.success) {
        return createSuccessResult(undefined)
      }
      return createErrorResult(
        mapErrorCode(result.code),
        result.error
      )
    } catch (err) {
      return createErrorResult(
        UpdaterErrorCodes.INSTALL_FAILED,
        err instanceof Error ? err.message : 'Unknown error installing update'
      )
    }
  })

  // updater:skipVersion - Skip a specific version
  ipcMain.handle(
    'updater:skipVersion',
    async (_event, version: string): Promise<IpcResult<void>> => {
      try {
        const result = await updaterService!.skipVersion(version)
        if (result.success) {
          return createSuccessResult(undefined)
        }
        return createErrorResult(
          mapErrorCode(result.code),
          result.error
        )
      } catch (err) {
        return createErrorResult(
          UpdaterErrorCodes.UPDATE_CHECK_FAILED,
          err instanceof Error ? err.message : 'Unknown error skipping version'
        )
      }
    }
  )

  // updater:getState - Get current updater state
  ipcMain.handle('updater:getState', async (): Promise<IpcResult<SharedUpdateState>> => {
    try {
      const internalState = updaterService!.getState()
      const sharedState = toSharedUpdateState(internalState)
      return createSuccessResult(sharedState)
    } catch (err) {
      return createErrorResult(
        UpdaterErrorCodes.NETWORK_ERROR,
        err instanceof Error ? err.message : 'Unknown error getting updater state'
      )
    }
  })

  // updater:setAutoUpdateEnabled - Enable/disable auto updates
  ipcMain.handle(
    'updater:setAutoUpdateEnabled',
    async (_event, enabled: boolean): Promise<IpcResult<void>> => {
      try {
        // Store preference in settings
        const { write } = await import('../services/persistence-service')
        const result = await write('settings/auto-update-enabled', enabled)
        if (result.success) {
          return createSuccessResult(undefined)
        }
        return createErrorResult(
          UpdaterErrorCodes.NETWORK_ERROR,
          result.error || 'Failed to save auto-update setting'
        )
      } catch (err) {
        return createErrorResult(
          UpdaterErrorCodes.NETWORK_ERROR,
          err instanceof Error ? err.message : 'Unknown error setting auto-update preference'
        )
      }
    }
  )

  // updater:getAutoUpdateEnabled - Check if auto updates enabled
  ipcMain.handle('updater:getAutoUpdateEnabled', async (): Promise<IpcResult<boolean>> => {
    try {
      const { read } = await import('../services/persistence-service')
      const result = await read<boolean>('settings/auto-update-enabled')
      if (result.success) {
        return createSuccessResult(result.data ?? true) // Default to enabled
      }
      // File not found is ok, return default
      if (result.code === 'FILE_NOT_FOUND') {
        return createSuccessResult(true)
      }
      return createErrorResult(
        UpdaterErrorCodes.NETWORK_ERROR,
        result.error || 'Failed to read auto-update setting'
      )
    } catch (err) {
      return createErrorResult(
        UpdaterErrorCodes.NETWORK_ERROR,
        err instanceof Error ? err.message : 'Unknown error getting auto-update preference'
      )
    }
  })
}

export function unregisterUpdaterIpc(): void {
  ipcMain.removeHandler('updater:checkForUpdates')
  ipcMain.removeHandler('updater:downloadUpdate')
  ipcMain.removeHandler('updater:installAndRestart')
  ipcMain.removeHandler('updater:skipVersion')
  ipcMain.removeHandler('updater:getState')
  ipcMain.removeHandler('updater:setAutoUpdateEnabled')
  ipcMain.removeHandler('updater:getAutoUpdateEnabled')
}
