/**
 * One-time notice telling people who update from the old product name that
 * the app was renamed and their data is untouched. A fresh install never sees
 * it, and a device that dismissed it never sees it again.
 *
 * The notice is per device: the record lives in this origin's `localStorage`,
 * which the desktop webview keeps per install and a browser keeps per profile.
 */

import { logFrontendError } from './log-api'

export const RENAME_NOTICE_TITLE = 'Termul is now Troupe'
export const RENAME_NOTICE_DESCRIPTION =
  "It's the same app with a new name. Your projects, chats, settings and sign-ins are unchanged."
export const RENAME_NOTICE_DISMISS_LABEL = 'Got it'
export const RENAME_NOTICE_STORAGE_KEY = 'termul.renameNotice'
/** 0.4.x keys start `termul.`, `termul-` or `termul:`. */
const EARLIER_VERSION_KEY_PREFIX = 'termul'

/** `fresh`: this device started on the new name. `dismissed`: the notice was acknowledged. */
type RenameNoticeRecord = 'fresh' | 'dismissed'

function parseRecord(raw: string | null): RenameNoticeRecord | null {
  return raw === 'fresh' || raw === 'dismissed' ? raw : null
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function reportStorageFailure(operation: 'read' | 'write'): void {
  void logFrontendError({
    level: 'warn',
    source: 'rename-notice',
    message: `localStorage ${operation} for the rename notice failed; the notice stays hidden`
  })
}

function storedKeys(storage: Storage): string[] {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key !== null) keys.push(key)
  }
  return keys
}

/**
 * Whether this device ran an earlier version, decided from storage as it was
 * before this page wrote anything. Since 0.4.50 every launch mints
 * `termul.deviceId`, so any other `termul` key means an update; keys from
 * other apps on a shared origin do not count. A device that jumps from an
 * older version without such a key misses the notice, which is the safe way
 * to be wrong. Otherwise this is a fresh install, recorded right away so keys
 * written later in this session (device id, sign-in token) never read as an
 * update on the next launch.
 */
function classifyBootStorage(storage: Storage | null): boolean {
  if (!storage) return false
  let updated: boolean
  try {
    if (parseRecord(storage.getItem(RENAME_NOTICE_STORAGE_KEY)) !== null) return false
    updated = storedKeys(storage).some(
      (key) => key.startsWith(EARLIER_VERSION_KEY_PREFIX) && key !== RENAME_NOTICE_STORAGE_KEY
    )
  } catch {
    reportStorageFailure('read')
    return false
  }
  if (!updated) {
    try {
      storage.setItem(RENAME_NOTICE_STORAGE_KEY, 'fresh')
    } catch {
      reportStorageFailure('write')
    }
  }
  return updated
}

// Runs at module load, which both renderer roots reach through their static
// imports before React mounts and before `ensureClientIdentity` mints the
// device id. Deferring it to a hook would see that id on every fresh install.
let updatedFromEarlierVersion = classifyBootStorage(safeLocalStorage())

/** True while an updated device has not dismissed the notice. */
export function isRenameNoticeDue(): boolean {
  if (!updatedFromEarlierVersion) return false
  const storage = safeLocalStorage()
  if (!storage) return false
  try {
    return parseRecord(storage.getItem(RENAME_NOTICE_STORAGE_KEY)) === null
  } catch {
    reportStorageFailure('read')
    return false
  }
}

export function dismissRenameNotice(): void {
  updatedFromEarlierVersion = false
  try {
    safeLocalStorage()?.setItem(RENAME_NOTICE_STORAGE_KEY, 'dismissed')
  } catch {
    reportStorageFailure('write')
  }
}
