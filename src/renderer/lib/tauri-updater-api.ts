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

const STABLE_UPDATE_MANIFEST_URL =
  'https://github.com/gnoviawan/termul/releases/latest/download/latest.json'
const UPSTREAM_LATEST_RELEASE_URL = 'https://api.github.com/repos/gnoviawan/termul/releases/latest'
const AUR_UPDATE_CHECK_TIMEOUT_MS = 8000

export type UpdateMode = 'tauri' | 'aur'

const UPDATE_MODE: UpdateMode =
  import.meta.env.VITE_TERMUL_UPDATE_MODE === 'aur' ? 'aur' : 'tauri'

/**
 * Default mode uses Tauri's signed updater manifest and self-update flow.
 * AUR mode only checks upstream GitHub Releases and asks users to update with yay.
 */

let pendingTauriUpdate: Update | null = null
let pendingAurUpdate: UpdateInfo | null = null
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

export function getUpdateMode(): UpdateMode {
  return UPDATE_MODE
}

export function isAurUpdateMode(): boolean {
  return UPDATE_MODE === 'aur'
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  if (typeof error === 'string' && error.trim()) {
    return error
  }

  try {
    const serialized = JSON.stringify(error)
    if (serialized && serialized !== '{}') {
      return serialized
    }
  } catch {
    // Ignore serialization failures and use the fallback below.
  }

  return fallback
}

function createUpdaterCheckError(error: unknown, sourceUrl: string): Error {
  const details = getErrorMessage(error, 'Unknown updater error')
  return new Error(`Failed to check for updates from ${sourceUrl}: ${details}`)
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

interface GitHubRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
}

function normalizeVersion(version: string): string {
  // Ignore AUR pkgrel/build metadata; app updates only track upstream release versions.
  return version.trim().replace(/^v/i, '').split(/[+-]/)[0] ?? version
}

function compareVersions(a: string, b: string): number {
  const partsA = normalizeVersion(a).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const partsB = normalizeVersion(b).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(partsA.length, partsB.length, 3)

  for (let index = 0; index < length; index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0)
    if (diff !== 0) return diff
  }

  return 0
}

function mapGitHubReleaseToInfo(release: GitHubRelease): UpdateInfo {
  const version = normalizeVersion(release.tag_name ?? release.name ?? '')
  return {
    version,
    releaseDate: release.published_at ?? new Date().toISOString(),
    releaseNotes: release.body ?? undefined,
    isSecurityUpdate: false,
    downloadUrl: release.html_url
  }
}

async function checkAurUpdate(): Promise<UpdateInfo | null> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => {
    controller.abort()
  }, AUR_UPDATE_CHECK_TIMEOUT_MS)

  const [currentVersion, response] = await Promise.all([
    getVersion(),
    fetch(UPSTREAM_LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json'
      },
      signal: controller.signal
    })
  ]).finally(() => {
    window.clearTimeout(timeoutId)
  })

  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status}`)
  }

  const release = (await response.json()) as GitHubRelease
  const latestVersion = normalizeVersion(release.tag_name ?? release.name ?? '')

  if (!latestVersion) {
    throw new Error('Latest release has no version tag')
  }

  return compareVersions(latestVersion, currentVersion) > 0
    ? mapGitHubReleaseToInfo(release)
    : null
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  try {
    if (isAurUpdateMode()) {
      const update = await checkAurUpdate()
      pendingAurUpdate = update
      lastCheckedAt = new Date().toISOString()
      return update
    }

    const update = await check()
    pendingTauriUpdate = update
    downloadedVersion = update && downloadedVersion === update.version ? downloadedVersion : null
    preparedUpdateVersion =
      update && preparedUpdateVersion === update.version ? preparedUpdateVersion : null
    lastCheckedAt = new Date().toISOString()
    return update ? mapTauriUpdateToInfo(update) : null
  } catch (error) {
    lastCheckedAt = new Date().toISOString()
    throw createUpdaterCheckError(
      error,
      isAurUpdateMode() ? UPSTREAM_LATEST_RELEASE_URL : STABLE_UPDATE_MANIFEST_URL
    )
  }
}

export async function downloadUpdate(
  onProgress?: (progress: DownloadProgress) => void
): Promise<IpcResult<void>> {
  if (isAurUpdateMode()) {
    if (!pendingAurUpdate) {
      return {
        success: false,
        error: 'No update available to download',
        code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
      }
    }

    return {
      success: false,
      error: 'AUR build cannot self-update. Update with: yay -S termul-manager',
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  if (!pendingTauriUpdate) {
    return {
      success: false,
      error: 'No update available to download',
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  try {
    const updateVersion = pendingTauriUpdate.version

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

    await pendingTauriUpdate.downloadAndInstall((event) => {
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
  if (isAurUpdateMode()) {
    return {
      success: false,
      error: 'AUR build cannot self-install updates. Update with: yay -S termul-manager',
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  if (!pendingTauriUpdate || downloadedVersion !== pendingTauriUpdate.version) {
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
  const updateAvailable = isAurUpdateMode() ? pendingAurUpdate !== null : pendingTauriUpdate !== null
  const version = isAurUpdateMode()
    ? pendingAurUpdate?.version ?? null
    : pendingTauriUpdate?.version ?? null
  const downloaded = isAurUpdateMode()
    ? false
    : pendingTauriUpdate !== null && downloadedVersion === pendingTauriUpdate.version

  return {
    success: true,
    data: {
      updateAvailable,
      downloaded,
      version,
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
  pendingTauriUpdate = null
  pendingAurUpdate = null
  downloadedVersion = null
  preparedUpdateVersion = null
}

export function _resetUpdaterStateForTesting(): void {
  pendingTauriUpdate = null
  pendingAurUpdate = null
  downloadedVersion = null
  preparedUpdateVersion = null
  lastCheckedAt = null
  autoUpdateEnabled = true
}
