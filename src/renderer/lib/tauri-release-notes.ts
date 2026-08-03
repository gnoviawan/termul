import { getVersion } from '@tauri-apps/api/app'
import { Store } from '@tauri-apps/plugin-store'

import { isTauriContext } from './tauri-runtime'

const STORE_FILE = 'whats-new.json'
const LAST_SEEN_VERSION_KEY = 'whatsNew.lastSeenVersion'

const GITHUB_RELEASE_BY_TAG_URL = 'https://api.github.com/repos/gnoviawan/termul/releases/tags'
const RELEASE_FETCH_TIMEOUT_MS = 8000

/**
 * Adapter shape shared by the Tauri `Store` and the web localStorage-backed
 * store. Both expose `get`/`set`/`save` so the facade methods can branch in
 * `getStore` and the rest of the call site is transport-agnostic.
 */
interface ReleaseNotesStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  save(): Promise<void>
}

/**
 * Web-only localStorage-backed store adapter (CAP-3). Mirrors the Tauri
 * `Store` shape over flat composite localStorage keys shaped
 * `${STORE_FILE}::${key}` (e.g. `whats-new.json::whatsNew.lastSeenVersion`),
 * matching the spec's I/O matrix. Each logical key is its own localStorage
 * entry; there is no shared envelope object.
 *
 * `save()` is a no-op — localStorage writes are synchronous, so `set`
 * already persists. All ops swallow `QuotaExceededError`/`SecurityError`/JSON
 * parse failures and degrade silently (the facade is best-effort: the
 * "what's new" popup must never throw on persistence failure).
 */
class WebReleaseNotesStore implements ReleaseNotesStore {
  private readonly storageKey: string

  constructor(storageKey: string) {
    this.storageKey = storageKey
  }

  private compositeKey(key: string): string {
    return `${this.storageKey}::${key}`
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (typeof localStorage === 'undefined') return undefined
    try {
      const raw = localStorage.getItem(this.compositeKey(key))
      if (raw === null) return undefined
      return JSON.parse(raw) as T
    } catch {
      // Corrupt JSON / SecurityError (private mode) — degrade silently.
      return undefined
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(this.compositeKey(key), JSON.stringify(value))
    } catch {
      // QuotaExceededError / SecurityError — drop the write silently. The UI
      // must never throw on persistence; reads return last-good or empty.
    }
  }

  async save(): Promise<void> {
    // no-op — localStorage is synchronous; `set` already persisted.
  }
}

let storeInstance: ReleaseNotesStore | null = null

async function getStore(): Promise<ReleaseNotesStore> {
  if (storeInstance) return storeInstance

  // Ternary (rather than if/else) so TypeScript's control-flow analysis sees
  // exactly one branch assigns `storeInstance` — the post-block type narrows
  // to `ReleaseNotesStore` (not `| null`).
  storeInstance = isTauriContext()
    ? await Store.load(STORE_FILE, {
        autoSave: false,
        defaults: {}
      })
    : new WebReleaseNotesStore(STORE_FILE)

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
 *
 * Branches on `isTauriContext()`: desktop reads via Tauri's `getVersion()`;
 * web reads the build-time `import.meta.env.VITE_APP_VERSION` define injected
 * by `vite.config.web.ts`. Falls back to `'0.0.0'` when the define is absent
 * (e.g. under Vitest, or a misconfigured build) so `compareVersions` treats it
 * as same/downgrade and never pops "what's new" on a stale value.
 */
export async function getCurrentAppVersion(): Promise<string> {
  if (isTauriContext()) {
    return getVersion()
  }
  const v = import.meta.env.VITE_APP_VERSION
  return typeof v === 'string' && v.length > 0 ? v : '0.0.0'
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
  // Nils the shared singleton so the next `getStore()` call re-creates the
  // adapter for the current `isTauriContext()` branch. Covers both the Tauri
  // `Store` and the web `WebReleaseNotesStore` since they share this variable.
  storeInstance = null
}
