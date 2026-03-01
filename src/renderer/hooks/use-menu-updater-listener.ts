import { useEffect } from 'react'
import { useUpdaterActions } from '@/stores/updater-store'

/**
 * useMenuUpdaterListener Hook (Tauri - No-op implementation)
 *
 * Placeholder for Tauri compatibility.
 * Menu-triggered update events are Electron-specific.
 *
 * This hook should be used once at the app level to handle menu events.
 */
export function useMenuUpdaterListener(): void {
  const { checkForUpdates } = useUpdaterActions()

  useEffect(() => {
    // No-op for Tauri - menu events not implemented in POC phase
    console.debug('[MenuUpdater] Menu updater listener not implemented in Tauri POC')

    return () => {
      // No cleanup needed
    }
  }, [checkForUpdates])
}
