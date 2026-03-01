import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import type { IpcResult } from '@shared/types/ipc.types'
import type { DownloadProgress, UpdateInfo, UpdateState } from '@shared/types/updater.types'

let pendingUpdate: Update | null = null
let autoUpdateEnabled = true
let lastCheckedAt: string | null = null
let downloadedVersion: string | null = null

export interface TauriUpdaterEventHandlers {
  onUpdateAvailable?: (update: Update) => void
  onDownloadProgress?: (progress: DownloadProgress) => void
  onUpdateDownloaded?: (update: Update) => void
  onError?: (error: string) => void
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

    downloadedVersion = pendingUpdate.version

    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'DOWNLOAD_FAILED'
    }
  }
}

export async function installAndRestart(): Promise<IpcResult<void>> {
  if (!pendingUpdate || downloadedVersion !== pendingUpdate.version) {
    return {
      success: false,
      error: 'No downloaded update ready to install',
      code: 'UPDATE_NOT_AVAILABLE'
    }
  }

  try {
    await relaunch()
    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'INSTALL_FAILED'
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

export function registerUpdateEventHandlers(_handlers: TauriUpdaterEventHandlers): () => void {
  return () => {
    // no-op cleanup
  }
}

export async function clearPendingUpdate(): Promise<void> {
  pendingUpdate = null
  downloadedVersion = null
}

export function _resetUpdaterStateForTesting(): void {
  pendingUpdate = null
  downloadedVersion = null
  lastCheckedAt = null
  autoUpdateEnabled = true
}
