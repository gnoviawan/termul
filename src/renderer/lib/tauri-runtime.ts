import type { UnlistenFn } from '@tauri-apps/api/event'

type MaybeUnlisten = Promise<UnlistenFn> | UnlistenFn | null | undefined

export function isTauriContext(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
  )
}

export function cleanupTauriListener(unlisten: MaybeUnlisten): void {
  if (!unlisten) return

  if (typeof unlisten === 'function') {
    unlisten()
    return
  }

  if (typeof unlisten.then === 'function') {
    void unlisten
      .then((dispose) => {
        dispose()
      })
      .catch(() => {
        // Ignore teardown failures in test/browser contexts.
      })
  }
}
