import type { IpcResult } from '@shared/types/ipc.types'
import {
  type DownloadProgress,
  type UpdateInfo,
  UpdaterErrorCodes,
  type UpdateState
} from '@shared/types/updater.types'
import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { runtimeT } from '@/i18n/runtime'
import { BackupErrorCodes, createBackup, setAppVersion } from './tauri-backup-api'
import { keepPreviousVersion, setCurrentVersion } from './tauri-rollback-api'

// Stable signed-manifest alias published alongside `latest-stable.json` so the
// Tauri updater plugin's build-time `endpoints` config (which cannot be
// overridden per check from the renderer) keeps resolving for stable users.
const STABLE_UPDATE_MANIFEST_URL =
  'https://github.com/gnoviawan/termul/releases/latest/download/latest.json'
const UPSTREAM_LATEST_RELEASE_URL = 'https://api.github.com/repos/gnoviawan/termul/releases/latest'
const AUR_UPDATE_CHECK_TIMEOUT_MS = 8000

/**
 * Release channel selection for the desktop updater. The persisted preference
 * selects which per-channel manifest the facade consults. Stable reuses the
 * signed `@tauri-apps/plugin-updater` `check()` flow (the plugin's endpoint
 * resolves to the stable manifest alias); Insider/Nightly fetch their manifest
 * JSON directly and offer the update via manual download, because the Tauri
 * updater plugin cannot take a runtime endpoint URL from the renderer.
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

let pendingTauriUpdate: Update | null = null
let downloadedUpdate: Update | null = null
let pendingAurUpdate: UpdateInfo | null = null
let manualUpdateInfo: UpdateInfo | null = null
let autoUpdateEnabled = true
let lastCheckedAt: string | null = null
let downloadedVersion: string | null = null
let preparedUpdateVersion: string | null = null
let isManualUpdateMode = false

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
  const details = getErrorMessage(
    error,
    runtimeT('shell', 'updates.errors.unknownUpdater', 'Unknown updater error')
  )
  return new Error(
    runtimeT(
      'shell',
      'updates.errors.checkSourceFailed',
      'Failed to check for updates from {{sourceUrl}}: {{details}}',
      { sourceUrl, details }
    )
  )
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
      error: runtimeT(
        'shell',
        'updates.errors.currentVersionFailed',
        'Failed to determine current app version: {{details}}',
        {
          details: getErrorMessage(
            error,
            runtimeT('shell', 'updates.errors.unknown', 'Unknown error')
          )
        }
      ),
      code: UpdaterErrorCodes.INSTALL_FAILED
    }
  }

  const backupResult = await createBackup()
  if (!backupResult.success) {
    return {
      success: false,
      error:
        backupResult.error ??
        runtimeT('shell', 'updates.errors.backupFailed', 'Failed to create backup before update'),
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
      error:
        preserveResult.error ??
        runtimeT(
          'shell',
          'updates.errors.preserveVersionFailed',
          'Failed to preserve current version before update'
        ),
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

interface ChannelManifest {
  version?: string
  notes?: string
  pub_date?: string
  platforms?: Record<string, unknown>
}

async function fetchChannelManifest(channel: UpdateChannel): Promise<ChannelManifest> {
  const result = await invoke<IpcResult<unknown>>('updater_fetch_channel_manifest', { channel })
  if (!result.success) {
    throw new Error(result.error)
  }
  const body = result.data
  if (typeof body !== 'object' || body === null) {
    throw new Error('Channel manifest is not a JSON object')
  }
  const manifest = body as ChannelManifest
  if (manifest.version !== undefined && typeof manifest.version !== 'string') {
    throw new Error('Channel manifest `version` is not a string')
  }
  return manifest
}

/**
 * Insider/Nightly check: fetch the per-channel manifest, compare against the
 * current app version with SemVer prerelease precedence, and offer the update
 * via manual download. The Tauri updater plugin cannot take a runtime endpoint
 * URL from the renderer, so non-stable channels offer a manual download of the
 * channel's GitHub release page instead of the signed in-app install.
 *
 * On manifest fetch failure (404 / network) the call throws so the store
 * surfaces the error and the periodic retry re-attempts next cycle.
 */
async function checkChannelUpdate(channel: UpdateChannel): Promise<UpdateInfo | null> {
  let manifest: ChannelManifest
  try {
    manifest = await fetchChannelManifest(channel)
  } catch (error) {
    lastCheckedAt = new Date().toISOString()
    throw createUpdaterCheckError(error, getChannelManifestUrl(channel))
  }

  const latestVersion = normalizeVersion(manifest.version ?? '')
  let updateInfo: UpdateInfo | null = null

  if (latestVersion) {
    const currentVersion = await getVersion()
    if (compareVersions(latestVersion, currentVersion) > 0) {
      updateInfo = {
        version: latestVersion,
        // Use the manifest's actual pub_date; do NOT fabricate a "now"
        // timestamp for a stale/undated manifest (it would masquerade as
        // just-published). Omit when the manifest lacks pub_date.
        releaseDate: manifest.pub_date,
        releaseNotes: manifest.notes ?? undefined,
        isSecurityUpdate: false,
        downloadUrl: getChannelReleasePageUrl(channel)
      }
    }
  }

  pendingTauriUpdate = null
  isManualUpdateMode = updateInfo !== null
  manualUpdateInfo = updateInfo
  downloadedVersion = null
  preparedUpdateVersion = null
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

  // Insider / Nightly consult their per-channel manifest and offer manual
  // download (the signed `check()` flow is stable-only by plugin limitation).
  if (channel !== DEFAULT_UPDATE_CHANNEL) {
    return checkChannelUpdate(channel)
  }

  // Stable: reuse the signed `@tauri-apps/plugin-updater` `check()` flow so the
  // existing signed download/install path and its backward compatibility are
  // preserved (the plugin endpoint resolves to the stable manifest alias).
  try {
    const update = await check()
    pendingTauriUpdate = update
    isManualUpdateMode = false
    manualUpdateInfo = null
    downloadedVersion = update && downloadedVersion === update.version ? downloadedVersion : null
    // Preserve the already-downloaded Update instance (and its in-memory bytes)
    // when a periodic re-check returns the same version; otherwise drop it so a
    // newer version is re-downloaded before install.
    downloadedUpdate =
      update && downloadedUpdate && downloadedUpdate.version === update.version
        ? downloadedUpdate
        : null
    preparedUpdateVersion =
      update && preparedUpdateVersion === update.version ? preparedUpdateVersion : null
    lastCheckedAt = new Date().toISOString()
    return update ? mapTauriUpdateToInfo(update) : null
  } catch (error) {
    lastCheckedAt = new Date().toISOString()

    const errorMsg = getErrorMessage(error, '')
    const isManifestMissing =
      errorMsg.includes('valid release JSON') ||
      errorMsg.includes('Could not fetch') ||
      errorMsg.includes('404')
    if (isManifestMissing) {
      try {
        const fallback = await checkGitHubFallback()
        if (fallback) {
          isManualUpdateMode = true
          manualUpdateInfo = fallback
          pendingTauriUpdate = null
          return fallback
        }
        return null
      } catch (fallbackError) {
        throw createUpdaterCheckError(fallbackError, UPSTREAM_LATEST_RELEASE_URL)
      }
    }

    throw createUpdaterCheckError(error, STABLE_UPDATE_MANIFEST_URL)
  }
}

async function checkGitHubFallback(): Promise<UpdateInfo | null> {
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

export async function downloadUpdate(
  onProgress?: (progress: DownloadProgress) => void
): Promise<IpcResult<void>> {
  if (isAurUpdateMode()) {
    if (!pendingAurUpdate) {
      return {
        success: false,
        error: runtimeT(
          'shell',
          'updates.errors.noUpdateAvailable',
          'No update available to download'
        ),
        code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
      }
    }

    return {
      success: false,
      error: runtimeT(
        'shell',
        'updates.errors.aurSelfUpdate',
        'AUR build cannot self-update. Update with: {{command}}',
        { command: 'yay -S termul-manager' }
      ),
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  if (isManualUpdateMode && manualUpdateInfo) {
    await openUrl(manualUpdateInfo.downloadUrl ?? UPSTREAM_LATEST_RELEASE_URL)
    return { success: true, data: undefined }
  }

  if (!pendingTauriUpdate) {
    return {
      success: false,
      error: runtimeT(
        'shell',
        'updates.errors.noUpdateAvailable',
        'No update available to download'
      ),
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  // Capture the handle before any await: a concurrent periodic checkForUpdates()
  // can reassign the module-scoped pendingTauriUpdate mid-download, which would
  // otherwise make the post-await assignments point at the wrong Update.
  const updateHandle = pendingTauriUpdate

  try {
    const updateVersion = updateHandle.version

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

    await updateHandle.download((event) => {
      if (!onProgress) return

      const mapped = mapDownloadEventToProgress(event, downloadedSoFar, totalBytes)
      downloadedSoFar = mapped.downloadedSoFar
      totalBytes = mapped.totalBytes
      onProgress(mapped.progress)
    })

    downloadedUpdate = updateHandle
    downloadedVersion = updateVersion

    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(
        error,
        runtimeT('shell', 'updates.errors.downloadFailed', 'Failed to download update')
      ),
      code: UpdaterErrorCodes.DOWNLOAD_FAILED
    }
  }
}

export async function installAndRestart(): Promise<IpcResult<void>> {
  if (isAurUpdateMode()) {
    return {
      success: false,
      error: runtimeT(
        'shell',
        'updates.errors.aurSelfInstall',
        'AUR build cannot self-install updates. Update with: {{command}}',
        { command: 'yay -S termul-manager' }
      ),
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  if (isManualUpdateMode && manualUpdateInfo) {
    await openUrl(manualUpdateInfo.downloadUrl ?? UPSTREAM_LATEST_RELEASE_URL)
    return { success: true, data: undefined }
  }

  if (
    !pendingTauriUpdate ||
    downloadedVersion !== pendingTauriUpdate.version ||
    !downloadedUpdate
  ) {
    return {
      success: false,
      error: runtimeT(
        'shell',
        'updates.errors.noDownloadedUpdate',
        'No downloaded update ready to install'
      ),
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    }
  }

  try {
    // Apply the already-downloaded package, then restart into the new version.
    // Split from download so the app is never force-restarted during download.
    await downloadedUpdate.install()
    await relaunch()
    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(
        error,
        runtimeT(
          'shell',
          'updates.errors.installRestartFailed',
          'Failed to install and restart after update'
        )
      ),
      code: UpdaterErrorCodes.INSTALL_FAILED
    }
  }
}

export async function getUpdaterState(): Promise<IpcResult<UpdateState>> {
  const updateAvailable = isAurUpdateMode()
    ? pendingAurUpdate !== null
    : pendingTauriUpdate !== null || isManualUpdateMode
  const version = isAurUpdateMode()
    ? (pendingAurUpdate?.version ?? null)
    : (pendingTauriUpdate?.version ?? manualUpdateInfo?.version ?? null)
  const downloaded = isAurUpdateMode()
    ? false
    : !isManualUpdateMode &&
      pendingTauriUpdate !== null &&
      downloadedVersion === pendingTauriUpdate.version

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
      lastChecked: lastCheckedAt,
      isManualUpdateMode: !isAurUpdateMode() && isManualUpdateMode
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
      runtimeT(
        'shell',
        'updates.errors.recoveryMetadataFailed',
        'Failed to initialize updater recovery metadata: {{details}}',
        {
          details: getErrorMessage(
            error,
            runtimeT('shell', 'updates.errors.unknown', 'Unknown error')
          )
        }
      )
    )
  })

  return () => {
    // no-op cleanup
  }
}

export async function clearPendingUpdate(): Promise<void> {
  pendingTauriUpdate = null
  downloadedUpdate = null
  pendingAurUpdate = null
  manualUpdateInfo = null
  downloadedVersion = null
  preparedUpdateVersion = null
  isManualUpdateMode = false
}

export function _resetUpdaterStateForTesting(): void {
  pendingTauriUpdate = null
  downloadedUpdate = null
  pendingAurUpdate = null
  manualUpdateInfo = null
  downloadedVersion = null
  preparedUpdateVersion = null
  lastCheckedAt = null
  autoUpdateEnabled = true
  isManualUpdateMode = false
}

export function isInManualUpdateMode(): boolean {
  return !isAurUpdateMode() && isManualUpdateMode
}
