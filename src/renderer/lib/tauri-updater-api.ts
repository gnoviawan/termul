import { getVersion } from '@tauri-apps/api/app'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import type { IpcResult } from '@shared/types/ipc.types'
import {
  UpdaterErrorCodes,
  type DownloadProgress,
  type UpdateInfo,
  type UpdateState
} from '@shared/types/updater.types'
import { BackupErrorCodes, createBackup, setAppVersion } from './tauri-backup-api'
import { keepPreviousVersion, setCurrentVersion } from './tauri-rollback-api'

let pendingUpdate: Update | null = null
let autoUpdateEnabled = true
let lastCheckedAt: string | null = null
let downloadedVersion: string | null = null
let preparedUpdateVersion: string | null = null

export interface TauriUpdaterEventHandlers {
  onUpdateAvailable?: (update: Update) => void
  onDownloadProgress?: (progress: DownloadProgress) => void
  onUpdateDownloaded?: (update: Update) => void
  onError?: (error: string) => void
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

async function syncRecoveryVersionMetadata(): Promise<string> {
  const currentVersion = await getVersion()
  await Promise.all([setAppVersion(currentVersion), setCurrentVersion(currentVersion)])
  return currentVersion
}

async function prepareUpdateRecovery(): Promise<IpcResult<void>> {
  let currentVersion: string

  try {
    currentVersion = await syncRecoveryVersionMetadata()
  } catch (error) {
    return {
      success: false,
      error: `Failed to determine current app version: ${getErrorMessage(error, 'Unknown error')}`,
      code: UpdaterErrorCodes.INSTALL_FAILED
    }
  }

  const backupResult = await createBackup()
  if (!backupResult.success) {
    return {
      success: false,
      error: backupResult.error ?? 'Failed to create backup before update',
      code:
        backupResult.code === BackupErrorCodes.DISK_SPACE_ERROR
          ? UpdaterErrorCodes.DISK_SPACE_INSUFFICIENT
          : UpdaterErrorCodes.INSTALL_FAILED
    }
  }

  const preserveResult = await keepPreviousVersion(currentVersion)
  if (!preserveResult.success) {
    return {
      success: false,
      error: preserveResult.error ?? 'Failed to preserve current version before update',
      code: UpdaterErrorCodes.INSTALL_FAILED
    }
  }

  return { success: true, data: undefined }
}

export function isUpdateAvailable(update: Update | null): update is Update {
  return Boolean(update)
}

export function mapTauriUpdateToInfo(update: Update): UpdateInfo {
  return {
    version: update.version,
    releaseDate: update.date ?? new Date().toISOString(),
    releaseNotes: update.body ?? undefined,
    isSecurityUpdate: false
  }
}

function mapDownloadEventToProgress(
  event: DownloadEvent,
  downloadedSoFar: number,
  totalBytes: number
): { progress: DownloadProgress; downloadedSoFar: number; totalBytes: number } {
  if (event.event === 'Started') {
    const total = event.data.contentLength ?? totalBytes
    return {
      progress: {
        bytesPerSecond: 0,
        percent: 0,
        transferred: 0,
        total
      },
      downloadedSoFar: 0,
      totalBytes: total
    }
  }

  if (event.event === 'Progress') {
    const nextDownloaded = downloadedSoFar + event.data.chunkLength
    const percent = totalBytes > 0 ? Math.min(100, (nextDownloaded / totalBytes) * 100) : 0

    return {
      progress: {
        bytesPerSecond: 0,
        percent,
        transferred: nextDownloaded,
        total: totalBytes
      },
      downloadedSoFar: nextDownloaded,
      totalBytes
    }
  }

  return {
    progress: {
      bytesPerSecond: 0,
      percent: 100,
      transferred: totalBytes,
      total: totalBytes
    },
    downloadedSoFar,
    totalBytes
  }
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  try {
    const update = await check()
    pendingUpdate = update
    downloadedVersion = update && downloadedVersion === update.version ? downloadedVersion : null
    preparedUpdateVersion = update && preparedUpdateVersion === update.version ? preparedUpdateVersion : null
    lastCheckedAt = new Date().toISOString()
    return update ? mapTauriUpdateToInfo(update) : null
  } catch {
    lastCheckedAt = new Date().toISOString()
    throw new Error('Failed to check for updates')
  }
}

export async function downloadUpdate(
  onProgress?: (progress: DownloadProgress) => void
): Promise<IpcResult<void>> {
  if (!pendingUpdate) {
    return {
      success: false,
      error: 'No update available to download',
      code: 'UPDATE_NOT_AVAILABLE'
    }
  }

  try {
    const updateVersion = pendingUpdate.version

    if (preparedUpdateVersion !== updateVersion) {
      const preparationResult = await prepareUpdateRecovery()
      if (!preparationResult.success) {
        return preparationResult
      }
      preparedUpdateVersion = updateVersion
    }

    let downloadedSoFar = 0
    let totalBytes = 0

    if (onProgress) {
      onProgress({
        bytesPerSecond: 0,
        percent: 0,
        transferred: 0,
        total: 0
      })
    }

    await pendingUpdate.downloadAndInstall((event) => {
      if (!onProgress) return

      const mapped = mapDownloadEventToProgress(event, downloadedSoFar, totalBytes)
      downloadedSoFar = mapped.downloadedSoFar
      totalBytes = mapped.totalBytes
      onProgress(mapped.progress)
    })

    downloadedVersion = updateVersion

    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error, 'Failed to download update'),
      code: UpdaterErrorCodes.DOWNLOAD_FAILED
    }
  }
}

export async function installAndRestart(): Promise<IpcResult<void>> {
  if (!pendingUpdate || downloadedVersion !== pendingUpdate.version) {
    return {
      success: false,
      error: 'No downloaded update ready to install',
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  try {
    await relaunch()
    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error, 'Failed to relaunch after update'),
      code: UpdaterErrorCodes.INSTALL_FAILED
    }
  }
}

export async function getUpdaterState(): Promise<IpcResult<UpdateState>> {
  return {
    success: true,
    data: {
      updateAvailable: pendingUpdate !== null,
      downloaded: pendingUpdate !== null && downloadedVersion === pendingUpdate.version,
      version: pendingUpdate?.version ?? null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: lastCheckedAt
    }
  }
}

export async function setAutoUpdateEnabled(enabled: boolean): Promise<IpcResult<void>> {
  autoUpdateEnabled = enabled
  return { success: true, data: undefined }
}

export async function getAutoUpdateEnabled(): Promise<IpcResult<boolean>> {
  return { success: true, data: autoUpdateEnabled }
}

export function registerUpdateEventHandlers(handlers: TauriUpdaterEventHandlers): () => void {
  void syncRecoveryVersionMetadata().catch((error) => {
    handlers.onError?.(
      `Failed to initialize updater recovery metadata: ${getErrorMessage(error, 'Unknown error')}`
    )
  })

  return () => {
    // no-op cleanup
  }
}

export async function clearPendingUpdate(): Promise<void> {
  pendingUpdate = null
  downloadedVersion = null
  preparedUpdateVersion = null
}

export function _resetUpdaterStateForTesting(): void {
  pendingUpdate = null
  downloadedVersion = null
  preparedUpdateVersion = null
  lastCheckedAt = null
  autoUpdateEnabled = true
}
