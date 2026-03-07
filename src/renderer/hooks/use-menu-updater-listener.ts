import { useEffect } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useUpdaterActions } from '@/stores/updater-store'
import { cleanupTauriListener, isTauriContext } from '@/lib/tauri-runtime'

const MENU_EVENTS = {
  CHECK_FOR_UPDATES_TRIGGERED: 'updater:check-for-updates-triggered'
} as const

/**
 * useMenuUpdaterListener Hook
 *
 * Keeps the updater initialized and reacts to native menu events emitted by Tauri.
 */
export function useMenuUpdaterListener(): void {
  const { initializeUpdater, checkForUpdates } = useUpdaterActions()

  useEffect(() => {
    void initializeUpdater({ autoCheck: false })
  }, [initializeUpdater])

  useEffect(() => {
    if (!isTauriContext()) {
      return
    }

    let unlisten: Promise<UnlistenFn> | undefined

    try {
      unlisten = listen(MENU_EVENTS.CHECK_FOR_UPDATES_TRIGGERED, () => {
        void checkForUpdates()
      })
    } catch (error) {
      console.error('[useMenuUpdaterListener] Failed to register menu updater listener:', error)
      return
    }

    return () => {
      cleanupTauriListener(unlisten)
    }
  }, [checkForUpdates])
}
