import { useEffect } from 'react'
import { useUpdaterActions } from '@/stores/updater-store'

/**
 * useMenuUpdaterListener Hook
 *
 * Listens for menu-triggered update check events.
 * When the user clicks "Check for Updates..." in the application menu,
 * this hook triggers the update check via the updater store.
 *
 * This hook should be used once at the app level to handle menu events.
 */
export function useMenuUpdaterListener(): void {
  const { checkForUpdates } = useUpdaterActions()

  useEffect(() => {
    // Listen for the menu-triggered update check event
    const listener = (): void => {
      checkForUpdates()
    }

    window.electron?.ipcRenderer?.on('updater:check-for-updates-triggered', listener)

    return () => {
      window.electron?.ipcRenderer?.removeListener('updater:check-for-updates-triggered', listener)
    }
  }, [checkForUpdates])
}
