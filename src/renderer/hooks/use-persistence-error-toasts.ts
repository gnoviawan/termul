import type { PersistenceErrorCode, PersistenceErrorEvent } from '@shared/types/ipc.types'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { persistenceApi } from '@/lib/api'

/** One toast per failure code and key in this window; later repeats stay silent. */
export const PERSISTENCE_ERROR_TOAST_WINDOW_MS = 30_000

/** Plain-language name of a stored value, for the toast text. */
const KEY_LABELS: readonly [RegExp, string][] = [
  [/^terminals\//, 'the terminal layout'],
  [/^snapshots\//, 'the snapshots'],
  [/^chat-draft\//, 'the chat draft'],
  [/^last-launch-draft\//, 'the launch draft'],
  [/^projects\/[^/]+\/command-history$/, 'the command history'],
  [/^acp\/mention-recents/, 'the recent file mentions'],
  [/^(editor-state|workspace)\//, 'the editor state'],
  [/^settings\/recent-commands$/, 'the recent commands'],
  [/^settings\//, 'the settings'],
  [/^ssh\/profiles$/, 'the SSH profiles'],
  [/^sessions\//, 'the session backup']
]

function labelFor(key: string): string {
  return KEY_LABELS.find(([pattern]) => pattern.test(key))?.[1] ?? `"${key}"`
}

const MESSAGES: Record<PersistenceErrorCode, (label: string) => string> = {
  STORE_VALUE_TOO_LARGE: (label) => `Saved value for ${label} is too large; it was not saved.`,
  STORE_PARTITION_FULL: (label) => `The storage for this device is full; ${label} was not saved.`,
  STORE_NOT_HYDRATED: (label) =>
    `Could not save ${label}: its stored value could not be read. Reload the page to try again.`,
  STORE_WRITE_FAILED: (label) => `The server could not write ${label} to disk; it was not saved.`,
  STORE_BASE_REQUIRED: (label) =>
    `Could not save ${label}: this page has not loaded its stored value yet. Reload the page to try again.`,
  STORE_CAS_FAILED: (label) =>
    `Could not save ${label}: another device changed it first. Try again.`
}

/** The toast text for one failed write. */
export function persistenceErrorText(event: PersistenceErrorEvent): string {
  return MESSAGES[event.code](labelFor(event.key))
}

/**
 * Shows a toast when a store write fails: the value was not saved and the
 * writer cannot fix it alone. A repeat of the same code for the same key inside
 * `PERSISTENCE_ERROR_TOAST_WINDOW_MS` is dropped, so an auto-save that fails on
 * every change does not bury the screen. Mounted once per renderer root.
 */
export function usePersistenceErrorToasts(): void {
  useEffect(() => {
    const lastShownAt = new Map<string, number>()
    return persistenceApi.onPersistenceError((event) => {
      const now = Date.now()
      for (const [id, shownAt] of lastShownAt) {
        if (now - shownAt >= PERSISTENCE_ERROR_TOAST_WINDOW_MS) lastShownAt.delete(id)
      }
      const id = `persistence-error:${event.code}:${event.key}`
      if (lastShownAt.has(id)) return
      lastShownAt.set(id, now)
      toast.error(persistenceErrorText(event), { id })
    })
  }, [])
}
