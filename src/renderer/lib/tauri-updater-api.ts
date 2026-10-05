import type { IpcResult } from '@shared/types/ipc.types'
import {
  type DownloadProgress,
  type UpdateInfo,
  UpdaterErrorCodes,
  type UpdateState
} from '@shared/types/updater.types'
import { getVersion } from '@tauri-apps/api/app'
import { Channel, invoke } from '@tauri-apps/api/core'
import type { Update } from '@tauri-apps/plugin-updater'
import { BackupErrorCodes, createBackup, setAppVersion } from './tauri-backup-api'
import { keepPreviousVersion, setCurrentVersion } from './tauri-rollback-api'

const UPSTREAM_LATEST_RELEASE_URL = 'https://api.github.com/repos/gnoviawan/termul/releases/latest'
const AUR_UPDATE_CHECK_TIMEOUT_MS = 8000

/**
 * Release channel selection for the desktop updater. The persisted preference
 * selects which signed manifest Rust checks. Stable, Insider, and Nightly all
 * download, install, and restart inside the app. The JavaScript plugin
 * `check()` cannot take a runtime endpoint, so the check and install commands
 * live in `desktop_updater`.
 */
export type UpdateChannel = 'stable' | 'insider' | 'nightly'

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable'

// The fetch source of truth is `server_update::UpdateChannel::manifest_url()`
// (src-tauri/src/server_update.rs); this constant is now only the error-message
// + release-page source. Keep them in sync when editing.
const CHANNEL_MANIFEST_URLS: Record<UpdateChannel, string> = {
  stable: 'https://github.com/gnoviawan/termul/releases/latest/download/latest-stable.json',
  insider: 'https://github.com/gnoviawan/termul/releases/download/insider/latest-insider.json',
  nightly: 'https://github.com/gnoviawan/termul/releases/download/nightly/latest-nightly.json'
}

const CHANNEL_RELEASE_PAGE_URLS: Record<UpdateChannel, string> = {
  stable: 'https://github.com/gnoviawan/termul/releases/latest',
  insider: 'https://github.com/gnoviawan/termul/releases/tag/insider',
  nightly: 'https://github.com/gnoviawan/termul/releases/tag/nightly'
}

export function getChannelManifestUrl(channel: UpdateChannel): string {
  return CHANNEL_MANIFEST_URLS[channel]
}

export function getChannelReleasePageUrl(channel: UpdateChannel): string {
  return CHANNEL_RELEASE_PAGE_URLS[channel]
}

export function normalizeUpdateChannel(value: string | null | undefined): UpdateChannel {
  if (value === 'insider' || value === 'nightly') return value
  return DEFAULT_UPDATE_CHANNEL
}

export type UpdateMode = 'tauri' | 'aur'

const UPDATE_MODE: UpdateMode = import.meta.env.VITE_TERMUL_UPDATE_MODE === 'aur' ? 'aur' : 'tauri'

/**
 * Default mode uses Tauri's signed updater manifest and self-update flow.
 * AUR mode only checks upstream GitHub Releases and asks users to update with yay.
 */

let pendingAurUpdate: UpdateInfo | null = null
let signedUpdateInfo: UpdateInfo | null = null
let autoUpdateEnabled = true
let lastCheckedAt: string | null = null
let preparedUpdateVersion: string | null = null

interface SignedUpdatePayload {
  version: string
  currentVersion: string
  releaseNotes?: string | null
  releaseDate?: string | null
}

interface SignedDownloadEvent {
  event: string
  data?: {
    contentLength?: number
    chunkLength?: number
  }
}

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
  event: SignedDownloadEvent,
  downloadedSoFar: number,
  totalBytes: number
): { progress: DownloadProgress; downloadedSoFar: number; totalBytes: number } {
  if (event.event === 'Started') {
    const total = event.data?.contentLength ?? totalBytes
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
    const nextDownloaded = downloadedSoFar + (event.data?.chunkLength ?? 0)
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

interface ParsedSemver {
  core: number[]
  prerelease: string[]
}

/**
 * Parse a normalized version into core numeric components (padded to 3) and a
 * dot-separated prerelease identifier list (empty when the version is a release).
 * The first `-` separates the prerelease from the core; build metadata (`+`)
 * is stripped upstream by `normalizeVersion`.
 */
function parseSemver(version: string): ParsedSemver {
  const dashIndex = version.indexOf('-')
  const coreStr = dashIndex === -1 ? version : version.slice(0, dashIndex)
  const preStr = dashIndex === -1 ? '' : version.slice(dashIndex + 1)
  const core = coreStr.split('.').map((part) => Number.parseInt(part, 10) || 0)
  while (core.length < 3) core.push(0)
  const prerelease = preStr ? preStr.split('.') : []
  return { core, prerelease }
}

function isNumericIdentifier(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value)
}

/**
 * Compare two prerelease identifier lists per SemVer 2.0 precedence:
 * numeric identifiers compare numerically and always precede alphanumeric ones;
 * alphanumeric identifiers compare lexically (ASCII); a smaller identifier
 * count precedes a larger one when all preceding identifiers are equal.
 */
function comparePrerelease(a: string[], b: string[]): number {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const ai = a[index]
    const bi = b[index]
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    const aNum = isNumericIdentifier(ai)
    const bNum = isNumericIdentifier(bi)
    if (aNum && bNum) {
      const diff = Number.parseInt(ai, 10) - Number.parseInt(bi, 10)
      if (diff !== 0) return diff
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1
    } else if (ai < bi) {
      return -1
    } else if (ai > bi) {
      return 1
    }
  }
  return 0
}

/**
 * Normalize a version string for comparison: trim, strip the leading `v`, and
 * drop build metadata (`+...`). The prerelease segment (`-rc.1`, `-nightly.*`)
 * is preserved so SemVer prerelease precedence is honored across channels.
 */
export function normalizeVersion(version: string): string {
  const trimmed = version.trim().replace(/^v/i, '')
  return trimmed.split('+')[0] ?? trimmed
}

/**
 * Compare two versions with full SemVer 2.0 prerelease precedence.
 *
 * Core version components (major.minor.patch) are compared numerically first.
 * A release version (no prerelease) is always greater than one with a
 * prerelease (`0.5.0` > `0.5.0-rc.1`), and prerelease identifiers are compared
 * per SemVer rules. This guarantees `0.0.0-nightly.*` (core `0.0.0` + prerelease)
 * is less than any real release, so a nightly user that later switches to
 * Stable is always offered the stable build.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(normalizeVersion(a))
  const pb = parseSemver(normalizeVersion(b))

  for (let index = 0; index < 3; index += 1) {
    const diff = pa.core[index] - pb.core[index]
    if (diff !== 0) return diff
  }

  const aHasPre = pa.prerelease.length > 0
  const bHasPre = pb.prerelease.length > 0
  if (!aHasPre && bHasPre) return 1
  if (aHasPre && !bHasPre) return -1
  if (aHasPre && bHasPre) return comparePrerelease(pa.prerelease, pb.prerelease)
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

  return compareVersions(latestVersion, currentVersion) > 0 ? mapGitHubReleaseToInfo(release) : null
}

function payloadToUpdateInfo(payload: SignedUpdatePayload): UpdateInfo {
  return {
    version: payload.version,
    releaseDate: payload.releaseDate ?? undefined,
    releaseNotes: payload.releaseNotes ?? undefined,
    isSecurityUpdate: false
  }
}

/**
 * Signed check for every channel. Rust selects the manifest URL, verifies the
 * signature on install, and keeps the update handle. A missing manifest is an
 * error. This path does not open a browser.
 */
async function checkSignedUpdate(channel: UpdateChannel): Promise<UpdateInfo | null> {
  let result: IpcResult<SignedUpdatePayload | null>
  try {
    result = await invoke<IpcResult<SignedUpdatePayload | null>>('updater_check_signed', {
      channel
    })
  } catch (error) {
    signedUpdateInfo = null
    lastCheckedAt = new Date().toISOString()
    throw createUpdaterCheckError(error, getChannelManifestUrl(channel))
  }

  if (!result?.success) {
    signedUpdateInfo = null
    lastCheckedAt = new Date().toISOString()
    throw createUpdaterCheckError(
      new Error(result?.error ?? 'Signed update check failed'),
      getChannelManifestUrl(channel)
    )
  }

  const updateInfo = result.data ? payloadToUpdateInfo(result.data) : null
  signedUpdateInfo = updateInfo
  preparedUpdateVersion = updateInfo ? preparedUpdateVersion : null
  lastCheckedAt = new Date().toISOString()
  return updateInfo
}

export async function checkForUpdates(
  channel: UpdateChannel = DEFAULT_UPDATE_CHANNEL
): Promise<UpdateInfo | null> {
  // AUR mode is orthogonal to the channel preference: AUR users update via yay,
  // so the channel selection does not redirect their check.
  if (isAurUpdateMode()) {
    try {
      const update = await checkAurUpdate()
      pendingAurUpdate = update
      lastCheckedAt = new Date().toISOString()
      return update
    } catch (error) {
      lastCheckedAt = new Date().toISOString()
      throw createUpdaterCheckError(error, UPSTREAM_LATEST_RELEASE_URL)
    }
  }

  return checkSignedUpdate(channel)
}

async function installSignedUpdate(
  onProgress?: (progress: DownloadProgress) => void
): Promise<IpcResult<void>> {
  if (!signedUpdateInfo) {
    return {
      success: false,
      error: 'No update available to download',
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  const updateVersion = signedUpdateInfo.version

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

  const onEvent = new Channel<SignedDownloadEvent>()
  onEvent.onmessage = (event) => {
    if (!onProgress) return
    const mapped = mapDownloadEventToProgress(event, downloadedSoFar, totalBytes)
    downloadedSoFar = mapped.downloadedSoFar
    totalBytes = mapped.totalBytes
    onProgress(mapped.progress)
  }

  try {
    const result = await invoke<IpcResult<void>>('updater_install_signed', { onEvent })
    if (!result?.success) {
      return {
        success: false,
        error: result?.error ?? 'Failed to install update',
        code: result?.code ?? UpdaterErrorCodes.DOWNLOAD_FAILED
      }
    }
    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error, 'Failed to download update'),
      code: UpdaterErrorCodes.DOWNLOAD_FAILED
    }
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

  // One action downloads the signed bundle, installs it, and restarts the app.
  return installSignedUpdate(onProgress)
}

export async function installAndRestart(): Promise<IpcResult<void>> {
  if (isAurUpdateMode()) {
    return {
      success: false,
      error: 'AUR build cannot self-install updates. Update with: yay -S termul-manager',
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  if (!signedUpdateInfo) {
    return {
      success: false,
      error: 'No downloaded update ready to install',
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  return installSignedUpdate()
}

export async function getUpdaterState(): Promise<IpcResult<UpdateState>> {
  const updateAvailable = isAurUpdateMode() ? pendingAurUpdate !== null : signedUpdateInfo !== null
  const version = isAurUpdateMode()
    ? (pendingAurUpdate?.version ?? null)
    : (signedUpdateInfo?.version ?? null)

  return {
    success: true,
    data: {
      updateAvailable,
      downloaded: false,
      version,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: lastCheckedAt,
      isManualUpdateMode: false
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
  pendingAurUpdate = null
  signedUpdateInfo = null
  preparedUpdateVersion = null
  try {
    await invoke('updater_clear_pending')
  } catch {
    // The desktop command drops the signed handle. A missing runtime still
    // clears the renderer copy above.
  }
}

export function _resetUpdaterStateForTesting(): void {
  pendingAurUpdate = null
  signedUpdateInfo = null
  preparedUpdateVersion = null
  lastCheckedAt = null
  autoUpdateEnabled = true
}
