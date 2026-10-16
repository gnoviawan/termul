/**
 * Session API Adapter
 *
 * Crash-recovery snapshot of the open terminals and workspaces. The snapshot
 * lives in the persistence facade under `PersistenceKeys.sessionsAutoSave`
 * (device scope), so it follows the same store as every other device value:
 * the plugin-store file on desktop, the host store on web.
 *
 * Earlier builds kept it in its own plugin-store file `termul-sessions.json`
 * (a localStorage shim of that file on web). The first read, write or clear
 * moves a leftover entry into the facade, marks the move done with
 * `PersistenceKeys.sessionsLegacyMigrated` and deletes the legacy entry. After
 * that the legacy file is never read again.
 *
 * Features:
 * - Save/restore session data
 * - Auto-save with debouncing
 * - Flush pending operations
 * - Clear session
 */

import type { IpcResult, SessionApi, SessionData } from '@shared/types/ipc.types'
import { IpcErrorCodes } from '@shared/types/ipc.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { Store } from '@tauri-apps/plugin-store'
import { logFrontendError } from './log-api'
import { persistenceApi } from './persistence-api'
import { trimSessionData } from './persistence-trim'
import { isTauriContext } from './tauri-runtime'

// ============================================================================
// Constants
// ============================================================================

/** The legacy plugin-store file (and its localStorage shim name on web). */
const LEGACY_STORE_FILE = 'termul-sessions.json'
/** The entry the legacy file kept the snapshot under. */
const LEGACY_SESSION_ENTRY = 'sessions/auto-save'
const AUTO_SAVE_DEBOUNCE_MS = 2000 // 2 seconds

// ============================================================================
// Types
// ============================================================================

/** The `{ _version, data }` envelope the legacy file wrapped the snapshot in. */
interface LegacyPersistedSession {
  _version: number
  data: SessionData
}

/**
 * Read-side shape shared by the Tauri `Store` and the web localStorage-backed
 * legacy store, so the one-time move is transport-agnostic. Signatures mirror
 * the real Tauri `Store` (`delete` returns `Promise<boolean>` — whether the key
 * was present) so `Store` is structurally assignable to this interface.
 */
interface LegacySessionStore {
  get<T>(key: string): Promise<T | undefined>
  delete(key: string): Promise<boolean>
  save(): Promise<void>
}

/**
 * Web-only localStorage-backed shim of the legacy session file (CAP-3). Mirrors
 * the Tauri `Store` shape over flat composite localStorage keys shaped
 * `${LEGACY_STORE_FILE}::${key}` (e.g. `termul-sessions.json::sessions/auto-save`).
 * Each logical key is its own localStorage entry; there is no shared envelope
 * object.
 *
 * `save()` is a no-op — localStorage writes are synchronous. Corrupt JSON
 * degrades to `undefined`; a `getItem` failure propagates. `delete`
 * propagates `removeItem` failures so the caller can log them.
 */
class WebSessionStore implements LegacySessionStore {
  private readonly storageKey: string

  constructor(storageKey: string) {
    this.storageKey = storageKey
  }

  private compositeKey(key: string): string {
    return `${this.storageKey}::${key}`
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (typeof localStorage === 'undefined') return undefined
    // A failing `getItem` (SecurityError in private mode) throws, so the caller
    // can tell "unreadable" from "absent" and retry the move later.
    const raw = localStorage.getItem(this.compositeKey(key))
    if (raw === null) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      // Corrupt JSON: nothing recoverable, treat as absent.
      return undefined
    }
  }

  async delete(key: string): Promise<boolean> {
    if (typeof localStorage === 'undefined') return false
    const composite = this.compositeKey(key)
    let had: boolean
    try {
      had = localStorage.getItem(composite) !== null
    } catch {
      // SecurityError on read — degrade silently, matching `get()`.
      return false
    }
    localStorage.removeItem(composite)
    return had
  }

  async save(): Promise<void> {
    // no-op — localStorage is synchronous; `delete` already persisted.
  }
}

// ============================================================================
// State
// ============================================================================

let legacyStoreInstance: LegacySessionStore | null = null
/** The one-time legacy move: set by the first operation, reset only on failure. */
let legacySettlement: Promise<void> | null = null
let autoSaveTimeout: ReturnType<typeof setTimeout> | null = null
let pendingAutoSaveData: SessionData | null = null

// ============================================================================
// Legacy file (read once, then never again)
// ============================================================================

async function getLegacyStore(): Promise<LegacySessionStore> {
  if (legacyStoreInstance) return legacyStoreInstance

  // Ternary (rather than if/else) so TypeScript's control-flow analysis sees
  // exactly one branch assigns `legacyStoreInstance` — the post-block type
  // narrows to `LegacySessionStore` (not `| null`).
  legacyStoreInstance = isTauriContext()
    ? await Store.load(LEGACY_STORE_FILE, { autoSave: false, defaults: {} })
    : new WebSessionStore(LEGACY_STORE_FILE)

  return legacyStoreInstance
}

/** The session data inside a legacy entry (versioned envelope or bare). */
function legacySessionData(raw: LegacyPersistedSession | SessionData): SessionData {
  return typeof raw === 'object' && raw !== null && '_version' in raw
    ? (raw as LegacyPersistedSession).data
    : (raw as SessionData)
}

/**
 * Moves a leftover legacy entry into the facade, once. Skipped when the facade
 * already holds a session or the move was already marked done, so the legacy
 * file is not even opened in those cases. Facade failures reject (the caller
 * reports them); legacy-file failures are logged and never block the session
 * API, which then simply has no legacy entry to offer.
 */
async function moveLegacySession(): Promise<void> {
  const marker = await persistenceApi.read<boolean>(PersistenceKeys.sessionsLegacyMigrated)
  if (marker.success) return
  if (marker.code !== 'KEY_NOT_FOUND') throw new Error(marker.error)
  const current = await persistenceApi.read<SessionData>(PersistenceKeys.sessionsAutoSave)
  if (current.success) {
    // The facade already holds a session: mark the move done so a later
    // `clear()` cannot bring a stale legacy entry back.
    const done = await persistenceApi.write(PersistenceKeys.sessionsLegacyMigrated, true)
    if (!done.success) throw new Error(done.error)
    return
  }
  if (current.code !== 'KEY_NOT_FOUND') throw new Error(current.error)

  let legacy: LegacySessionStore
  let raw: LegacyPersistedSession | SessionData | undefined
  try {
    legacy = await getLegacyStore()
    raw = await legacy.get<LegacyPersistedSession | SessionData>(LEGACY_SESSION_ENTRY)
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'tauri-session-api.legacy-read',
      message: `could not read the legacy session file: ${String(error)}`
    })
    // Unreadable is not absent: nothing is marked, so the next call tries again.
    legacySettlement = null
    return
  }

  if (raw !== null && raw !== undefined) {
    const moved = await persistenceApi.write(
      PersistenceKeys.sessionsAutoSave,
      trimSessionData(legacySessionData(raw))
    )
    if (!moved.success) throw new Error(moved.error)
  }
  // Mark the move before the entry goes, so a later `clear()` can never bring
  // a stale legacy entry back.
  const marked = await persistenceApi.write(PersistenceKeys.sessionsLegacyMigrated, true)
  if (!marked.success) throw new Error(marked.error)
  if (raw === null || raw === undefined) return
  try {
    await legacy.delete(LEGACY_SESSION_ENTRY)
    await legacy.save()
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'tauri-session-api.legacy-delete',
      message: `could not delete the legacy session entry: ${String(error)}`
    })
  }
}

function settleLegacySession(): Promise<void> {
  if (!legacySettlement) {
    legacySettlement = moveLegacySession().catch((error: unknown) => {
      // Retry on the next call: nothing was marked done.
      legacySettlement = null
      throw error
    })
  }
  return legacySettlement
}

// ============================================================================
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

/** The stored session, or `undefined` when none is stored. Throws on a store failure. */
async function readStoredSession(): Promise<SessionData | undefined> {
  await settleLegacySession()
  const result = await persistenceApi.read<SessionData>(PersistenceKeys.sessionsAutoSave)
  if (result.success) return result.data
  if (result.code === 'KEY_NOT_FOUND') return undefined
  throw new Error(result.error)
}

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

    await settleLegacySession()
    const result = await persistenceApi.write(
      PersistenceKeys.sessionsAutoSave,
      trimSessionData({ ...sessionData, timestamp: new Date().toISOString() })
    )
    if (!result.success) throw new Error(result.error)

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
    const sessionData = await readStoredSession()

    if (sessionData === undefined || sessionData === null) {
      return {
        success: false,
        error: 'No saved session found',
        code: IpcErrorCodes.SESSION_NOT_FOUND
      }
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

    await settleLegacySession()
    const result = await persistenceApi.delete(PersistenceKeys.sessionsAutoSave)
    if (!result.success) throw new Error(result.error)

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
    const sessionData = await readStoredSession()

    const hasData = sessionData !== null && sessionData !== undefined

    // Additional validation if data exists
    if (hasData && typeof sessionData === 'object') {
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
 * @internal Testing only - reset the legacy store and the one-time legacy move
 */
export function _resetStoreInstanceForTesting() {
  legacyStoreInstance = null
  legacySettlement = null
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout)
    autoSaveTimeout = null
  }
  pendingAutoSaveData = null
}
