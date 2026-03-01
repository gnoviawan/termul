import { useCallback } from 'react'
import { useUpdaterStore } from '@/stores/updater-store'

/**
 * useUpdateStore Hook
 *
 * Typed hook that returns the full updater store.
 * Provides access to all updater state and actions.
 *
 * @returns The complete updater store state and actions
 *
 * @example
 * ```tsx
 * function UpdateComponent() {
 *   const { updateAvailable, version, checkForUpdates } = useUpdateStore()
 *
 *   return (
 *     <div>
 *       {updateAvailable && <span>Version {version} available</span>}
 *       <button onClick={checkForUpdates}>Check for Updates</button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useUpdateStore() {
  const store = useUpdaterStore()
  return store
}

/**
 * useUpdateCheck Hook (Tauri - No-op implementation)
 *
 * Placeholder for Tauri compatibility.
 * Auto-updater is not implemented in Tauri POC phase.
 *
 * @param autoCheck - Whether to automatically check on mount (default: true)
 * @returns Object containing update state and check function
 */
export function useUpdateCheck(autoCheck = true) {
  // Get state from store
  const isChecking = useUpdaterStore((state) => state.isChecking)
  const updateAvailable = useUpdaterStore((state) => state.updateAvailable)
  const version = useUpdaterStore((state) => state.version)
  const error = useUpdaterStore((state) => state.error)

  // Get actions
  const checkForUpdates = useUpdaterStore((state) => state.checkForUpdates)

  /**
   * Manual check function (no-op in Tauri)
   */
  const check = useCallback(() => {
    console.warn('[Updater] Auto-updater not implemented in Tauri POC')
    // No-op for Tauri
  }, [checkForUpdates])

  return {
    isChecking: false,
    updateAvailable: false,
    version: '',
    check,
    error: null
  }
}
