/**
 * Tauri Session API Adapter
 *
 * Provides session persistence functionality. Branches on `isTauriContext()`:
 * - Desktop: `@tauri-apps/plugin-store` (`Store.load(STORE_FILE, ...)`).
 * - Web/remote: a localStorage-backed adapter over flat composite keys
 *   shaped `${STORE_FILE}::${key}` (e.g. `termul-sessions.json::sessions/auto-save`),
 *   matching the spec's I/O matrix.
 *
 * Follows the same pattern as tauri-persistence-api.ts for consistency.
 *
 * Features:
 * - Save/restore session data
 * - Auto-save with debouncing
 * - Flush pending operations
 * - Clear session
 */

import type { IpcResult, SessionApi, SessionData } from '@shared/types/ipc.types'
import { IpcErrorCodes } from '@shared/types/ipc.types'
import { Store } from '@tauri-apps/plugin-store'

import { isTauriContext } from './tauri-runtime'

// ============================================================================
// Constants
// ============================================================================

const STORE_FILE = 'termul-sessions.json'
const SESSION_KEY = 'sessions/auto-save'
const AUTO_SAVE_DEBOUNCE_MS = 2000 // 2 seconds
const CURRENT_VERSION = 1

// ============================================================================
// Types
// ============================================================================

interface PersistedSession {
  _version: number
  data: SessionData
}

/**
 * Adapter shape shared by the Tauri `Store` and the web localStorage-backed
 * store. Both expose `get`/`set`/`delete`/`save` so the session methods can
 * branch in `getStore` and stay transport-agnostic. Signatures mirror the
 * real Tauri `Store` (`delete` returns `Promise<boolean>` — whether the key
 * was present) so `Store` is structurally assignable to this interface.
 */
interface SessionStoreAdapter {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  save(): Promise<void>
}

/**
 * Web-only localStorage-backed session store adapter (CAP-3). Mirrors the
 * Tauri `Store` shape over flat composite localStorage keys shaped
 * `${STORE_FILE}::${key}` (e.g. `termul-sessions.json::sessions/auto-save`),
 * matching the spec's I/O matrix. Each logical key is its own localStorage
 * entry; there is no shared envelope object.
 *
 * `save()` is a no-op — localStorage writes are synchronous, so `set`
 * already persists. Reads swallow `QuotaExceededError`/`SecurityError`/JSON
 * parse failures and degrade to `undefined` (best-effort on read). Writes do
 * NOT swallow — a `QuotaExceededError` on `set` propagates so `save` can
 * surface a `SESSION_STORE_ERROR` (the session store is not best-effort: a
 * silent write failure would make crash-recovery believe a session persisted
 * that did not).
 */
class WebSessionStore implements SessionStoreAdapter {
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
    // Propagate QuotaExceededError/SecurityError so `save` reports a
    // SESSION_STORE_ERROR instead of a false success.
    localStorage.setItem(this.compositeKey(key), JSON.stringify(value))
  }

  async delete(key: string): Promise<boolean> {
    if (typeof localStorage === 'undefined') return false
    const composite = this.compositeKey(key)
    let had: boolean
    try {
      had = localStorage.getItem(composite) !== null
    } catch {
      // Corrupt access / SecurityError on read — degrade silently, matching `get()`.
      return false
    }
    // Propagate removeItem failures so `clear()` can surface a
    // SESSION_STORE_ERROR instead of reporting a false success (the same
    // no-silent-write-failure contract `set()` upholds).
    localStorage.removeItem(composite)
    return had
  }

  async save(): Promise<void> {
    // no-op — localStorage is synchronous; `set` already persisted.
  }
}

// ============================================================================
// State
// ============================================================================

let storeInstance: SessionStoreAdapter | null = null
let autoSaveTimeout: ReturnType<typeof setTimeout> | null = null
let pendingAutoSaveData: SessionData | null = null

// ============================================================================
// Store Management
// ============================================================================

async function getStore(): Promise<SessionStoreAdapter> {
  if (storeInstance) return storeInstance

  // Ternary (rather than if/else) so TypeScript's control-flow analysis sees
  // exactly one branch assigns `storeInstance` — the post-block type narrows
  // to `SessionStoreAdapter` (not `| null`).
  storeInstance = isTauriContext()
    ? await Store.load(STORE_FILE, { autoSave: false, defaults: {} })
    : new WebSessionStore(STORE_FILE)

  return storeInstance
}

// ============================================================================
// Validation
// ============================================================================

function validateSessionData(data: unknown): data is SessionData {
  if (!data || typeof data !== 'object') {
    return false
  }

  const session = data as Partial<SessionData>

  // Check timestamp
  if (!session.timestamp || typeof session.timestamp !== 'string') {
    return false
  }

  // Check terminals array
  if (!Array.isArray(session.terminals)) {
    return false
  }

  // Validate each terminal session
  for (const terminal of session.terminals) {
    if (!terminal.id || typeof terminal.id !== 'string') {
      return false
    }
    if (!terminal.shell || typeof terminal.shell !== 'string') {
      return false
    }
    if (!terminal.cwd || typeof terminal.cwd !== 'string') {
      return false
    }
    if (!Array.isArray(terminal.history)) {
      return false
    }
  }

  // Check workspaces array
  if (!Array.isArray(session.workspaces)) {
    return false
  }

  // Validate each workspace
  for (const workspace of session.workspaces) {
    if (!workspace.projectId || typeof workspace.projectId !== 'string') {
      return false
    }
    if (workspace.activeTerminalId !== null && typeof workspace.activeTerminalId !== 'string') {
      return false
    }
    if (!Array.isArray(workspace.terminals)) {
      return false
    }
  }

  return true
}

// ============================================================================
// Session API Implementation
// ============================================================================

async function save(sessionData: SessionData): Promise<IpcResult<void>> {
  try {
    // Validate session data structure
    if (!validateSessionData(sessionData)) {
      return {
        success: false,
        error: 'Invalid session data structure',
        code: IpcErrorCodes.SESSION_INVALID
      }
    }

    const store = await getStore()

    // Create versioned session data
    const persisted: PersistedSession = {
      _version: CURRENT_VERSION,
      data: {
        ...sessionData,
        timestamp: new Date().toISOString()
      }
    }

    await store.set(SESSION_KEY, persisted)
    await store.save()

    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown save error',
      code: IpcErrorCodes.SESSION_STORE_ERROR
    }
  }
}

async function restore(): Promise<IpcResult<SessionData>> {
  try {
    const store = await getStore()
    const raw = await store.get<PersistedSession | SessionData>(SESSION_KEY)

    if (raw === null || raw === undefined) {
      return {
        success: false,
        error: 'No saved session found',
        code: IpcErrorCodes.SESSION_NOT_FOUND
      }
    }

    // Handle versioned data
    let sessionData: SessionData
    if (typeof raw === 'object' && raw !== null && '_version' in raw) {
      sessionData = (raw as PersistedSession).data
    } else {
      // Legacy data without version
      sessionData = raw as SessionData
    }

    // Validate restored session data
    if (!validateSessionData(sessionData)) {
      return {
        success: false,
        error: 'Invalid session data structure',
        code: IpcErrorCodes.SESSION_INVALID
      }
    }

    return { success: true, data: sessionData }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown restore error',
      code: IpcErrorCodes.SESSION_STORE_ERROR
    }
  }
}

async function clear(): Promise<IpcResult<void>> {
  try {
    // Cancel any pending auto-save
    if (autoSaveTimeout) {
      clearTimeout(autoSaveTimeout)
      autoSaveTimeout = null
    }
    pendingAutoSaveData = null

    const store = await getStore()
    await store.delete(SESSION_KEY)
    await store.save()

    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown clear error',
      code: IpcErrorCodes.SESSION_STORE_ERROR
    }
  }
}

async function flush(): Promise<IpcResult<void>> {
  try {
    // Clear any pending auto-save timeout
    if (autoSaveTimeout) {
      clearTimeout(autoSaveTimeout)
      autoSaveTimeout = null
    }

    // If there's pending data, save it immediately
    if (pendingAutoSaveData) {
      const result = await save(pendingAutoSaveData)
      if (!result.success) {
        return result
      }
      pendingAutoSaveData = null
    }

    // Ensure store is saved
    const store = await getStore()
    await store.save()

    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown flush error',
      code: IpcErrorCodes.SESSION_STORE_ERROR
    }
  }
}

async function hasSession(): Promise<IpcResult<boolean>> {
  try {
    const store = await getStore()
    const raw = await store.get<PersistedSession | SessionData>(SESSION_KEY)

    const hasData = raw !== null && raw !== undefined

    // Additional validation if data exists
    if (hasData && typeof raw === 'object') {
      let sessionData: SessionData
      if ('_version' in raw) {
        sessionData = (raw as PersistedSession).data
      } else {
        sessionData = raw as SessionData
      }

      // Return false if data is invalid
      if (!validateSessionData(sessionData)) {
        return { success: true, data: false }
      }

      // A session with no terminals has nothing to restore — return false.
      if (sessionData.terminals.length === 0) {
        return { success: true, data: false }
      }
    }

    return { success: true, data: hasData }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown hasSession error',
      code: IpcErrorCodes.SESSION_STORE_ERROR
    }
  }
}

// ============================================================================
// Auto-save (internal)
// ============================================================================

function _autoSave(sessionData: SessionData): void {
  // Store pending data for flush
  pendingAutoSaveData = sessionData

  // Clear any pending auto-save
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout)
  }

  // Schedule new auto-save
  autoSaveTimeout = setTimeout(async () => {
    autoSaveTimeout = null
    const result = await save(sessionData)
    if (!result.success) {
      console.error('Auto-save failed:', result.error)
    }
    // Clear pending data after save
    pendingAutoSaveData = null
  }, AUTO_SAVE_DEBOUNCE_MS)
}

// ============================================================================
// Exported API
// ============================================================================

/**
 * Tauri Session API implementation
 *
 * @example
 * ```ts
 * import { createTauriSessionApi } from './tauri-session-api'
 *
 * const sessionApi = createTauriSessionApi()
 *
 * // Save session
 * const saveResult = await sessionApi.save(sessionData)
 *
 * // Restore session
 * const restoreResult = await sessionApi.restore()
 *
 * // Clear session
 * await sessionApi.clear()
 *
 * // Flush pending auto-save
 * await sessionApi.flush()
 * ```
 */
export const tauriSessionApi: SessionApi = {
  save,
  restore,
  clear,
  flush,
  hasSession
}

/**
 * Factory function for creating Tauri Session API instance
 * Follows the same pattern as other Tauri API adapters
 *
 * @returns SessionApi instance
 */
export function createTauriSessionApi(): SessionApi {
  return tauriSessionApi
}

/**
 * @internal Testing only - reset the singleton store instance
 */
export function _resetStoreInstanceForTesting() {
  storeInstance = null
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout)
    autoSaveTimeout = null
  }
  pendingAutoSaveData = null
}
