/**
 * Client identity for the versioned `authenticate` handshake (AD-4, AD-15).
 *
 * Two ids, both minted here by the CLIENT via `randomUUID` (the host never
 * mints or rewrites either):
 *
 * - `deviceId` — one per browser profile / desktop install. Persisted in
 *   `localStorage`, so every tab of a profile shares it (and the desktop
 *   webview keeps it per install).
 * - `clientInstanceId` — one per tab / window. Kept in `sessionStorage`, so
 *   two tabs of one profile differ while a reload of one tab keeps its id.
 *
 * Storage can throw (disabled storage, opaque origins, quota). The ids then
 * live in module memory for the page lifetime so every handshake of this page
 * still presents the SAME identity. Neither id is a credential; neither is
 * ever the web auth token.
 */

import {
  type AcpAuthenticatePayload,
  MAX_CLIENT_ID_LEN,
  WS_PROTOCOL_VERSION
} from '@shared/types/web-protocol.types'
import { logFrontendError } from './log-api'
import { randomUUID } from './uuid'

export const DEVICE_ID_STORAGE_KEY = 'termul.deviceId'
export const CLIENT_INSTANCE_ID_STORAGE_KEY = 'termul.clientInstanceId'

type StorageKind = 'local' | 'session'

function safeStorage(kind: StorageKind): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    // Access can throw (disabled storage / opaque origins) — treat as absent.
    return null
  }
}

/** Page-lifetime fallback used only when storage reads/writes fail. */
const memoryIds: Record<StorageKind, string | null> = { local: null, session: null }

/** One warn per kind per page: ids are resolved on every handshake. */
const warnedFallback: Record<StorageKind, boolean> = { local: false, session: false }

const utf8 = new TextEncoder()

/** The host limits ids by UTF-8 BYTES (`MAX_CLIENT_ID_LEN`), not UTF-16 units. */
function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    utf8.encode(value).length <= MAX_CLIENT_ID_LEN &&
    // The host refuses control characters (`char::is_control`, Unicode Cc).
    !/\p{Cc}/u.test(value)
  )
}

function warnFallback(kind: StorageKind, operation: 'read' | 'write'): void {
  if (warnedFallback[kind]) return
  warnedFallback[kind] = true
  // Never the id value — operation and kind only.
  void logFrontendError({
    level: 'warn',
    source: 'web-client-identity',
    message: `${kind}Storage ${operation} for the client identity failed; the id is kept in memory for this page only`
  })
}

function resolveId(kind: StorageKind, key: string): string {
  const storage = safeStorage(kind)
  if (storage) {
    try {
      const stored = storage.getItem(key)
      if (isValidId(stored)) return stored
    } catch {
      warnFallback(kind, 'read')
    }
  } else {
    warnFallback(kind, 'read')
  }

  // Storage is empty, corrupt, or unavailable. A previously minted in-memory
  // id (earlier write failure) keeps this page's identity stable.
  const remembered = memoryIds[kind]
  if (remembered) return remembered

  const minted = randomUUID()
  try {
    if (!storage) throw new Error('storage unavailable')
    storage.setItem(key, minted)
    // Two first-run tabs can both mint before either write lands; the last
    // write wins in storage. Adopt whatever storage holds now, so this tab
    // converges on the persisted value instead of a losing one.
    const persisted = storage.getItem(key)
    if (isValidId(persisted)) return persisted
  } catch {
    memoryIds[kind] = minted
    warnFallback(kind, 'write')
  }
  return minted
}

/** Stable per browser profile / install (`localStorage`). */
export function getDeviceId(): string {
  return resolveId('local', DEVICE_ID_STORAGE_KEY)
}

/** Stable per tab / window (`sessionStorage`); survives reload of that tab. */
export function getClientInstanceId(): string {
  return resolveId('session', CLIENT_INSTANCE_ID_STORAGE_KEY)
}

/**
 * Boot-time mint: called from both renderer roots so the identity exists (and
 * any storage fallback is logged) before the first WS handshake.
 */
export function ensureClientIdentity(): void {
  getDeviceId()
  getClientInstanceId()
}

/**
 * Full `authenticate` payload every WS client sends on every handshake.
 * `token` is omitted when no token is supplied (never an empty string).
 * `deviceId` defaults to the page's own id; only tests pass another.
 */
export function buildAuthenticatePayload(
  token?: string | null,
  deviceId: string = getDeviceId()
): AcpAuthenticatePayload {
  const payload: AcpAuthenticatePayload = {
    protocolVersion: WS_PROTOCOL_VERSION,
    deviceId,
    clientInstanceId: getClientInstanceId()
  }
  if (token) payload.token = token
  return payload
}

/** Test seam: drop the in-memory fallback ids and warn latches. */
export function __resetClientIdentityForTesting(): void {
  memoryIds.local = null
  memoryIds.session = null
  warnedFallback.local = false
  warnedFallback.session = false
}
