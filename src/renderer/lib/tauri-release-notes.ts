import { getVersion } from '@tauri-apps/api/app'
import { Store } from '@tauri-apps/plugin-store'

const STORE_FILE = 'whats-new.json'
const LAST_SEEN_VERSION_KEY = 'whatsNew.lastSeenVersion'

const GITHUB_RELEASE_BY_TAG_URL = 'https://api.github.com/repos/gnoviawan/termul/releases/tags'
const RELEASE_FETCH_TIMEOUT_MS = 8000

let storeInstance: Store | null = null

async function getStore(): Promise<Store> {
  if (storeInstance) return storeInstance

  storeInstance = await Store.load(STORE_FILE, {
    autoSave: false,
    defaults: {}
  })

  return storeInstance
}

/**
 * Release notes resolved for a specific version.
 */
export interface ReleaseNotes {
  version: string
  notes: string | null
  htmlUrl: string | null
}

interface GitHubRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
}

/**
 * Strip a leading `v` and any build/prerelease metadata so versions compare on
 * their numeric release components only.
 */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '').split(/[+-]/)[0] ?? version
}

/**
 * Compare two semver-like versions. Returns >0 when `a` is newer than `b`,
 * <0 when older, and 0 when equal on their numeric components.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = normalizeVersion(a)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const partsB = normalizeVersion(b)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(partsA.length, partsB.length, 3)

  for (let index = 0; index < length; index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0)
    if (diff !== 0) return diff
  }

  return 0
}

/**
 * Get the running application version.
 */
export async function getCurrentAppVersion(): Promise<string> {
  return getVersion()
}

/**
 * Read the last version for which the What's New popup was shown.
 * Returns null when nothing has been recorded yet (e.g. fresh install).
 */
export async function getLastSeenVersion(): Promise<string | null> {
  const store = await getStore()
  const value = await store.get<string>(LAST_SEEN_VERSION_KEY)
  return value ?? null
}

/**
 * Persist the version for which the What's New popup has been shown so it is
 * not shown again for the same version.
 */
export async function setLastSeenVersion(version: string): Promise<void> {
  const store = await getStore()
  await store.set(LAST_SEEN_VERSION_KEY, version)
  await store.save()
}

/**
 * Fetch GitHub release notes for a specific version tag (`v{version}`).
 * Returns null when the release is missing, has no notes, or the request fails.
 */
export async function fetchReleaseNotes(version: string): Promise<ReleaseNotes | null> {
  const normalized = normalizeVersion(version)
  if (!normalized) return null

  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => {
    controller.abort()
  }, RELEASE_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(`${GITHUB_RELEASE_BY_TAG_URL}/v${normalized}`, {
      headers: {
        Accept: 'application/vnd.github+json'
      },
      signal: controller.signal
    })

    if (!response.ok) {
      return null
    }

    const release = (await response.json()) as GitHubRelease
    const body = release.body?.trim()

    return {
      version: normalized,
      notes: body && body.length > 0 ? body : null,
      htmlUrl: release.html_url ?? null
    }
  } catch {
    // Network errors, aborts, and malformed responses degrade silently — the
    // caller still records the version as seen so a transient failure does not
    // pin a stale popup.
    return null
  } finally {
    window.clearTimeout(timeoutId)
  }
}

export function _resetReleaseNotesStoreForTesting(): void {
  storeInstance = null
}
