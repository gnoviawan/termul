import { useCallback, useEffect } from 'react'
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
 * useUpdateCheck Hook
 *
 * Initializes updater integration and exposes a manual check action.
 *
 * @param autoCheck - Whether to automatically check on mount (default: true)
 * @returns Object containing update state and check function
 */
export function useUpdateCheck(autoCheck = true) {
  const isChecking = useUpdaterStore((state) => state.isChecking)
  const updateAvailable = useUpdaterStore((state) => state.updateAvailable)
  const version = useUpdaterStore((state) => state.version)
  const error = useUpdaterStore((state) => state.error)

  const checkForUpdates = useUpdaterStore((state) => state.checkForUpdates)
  const initializeUpdater = useUpdaterStore((state) => state.initializeUpdater)
  const stopPeriodicChecks = useUpdaterStore((state) => state.stopPeriodicChecks)

  useEffect(() => {
    void initializeUpdater({ autoCheck })
  }, [autoCheck, initializeUpdater])

  useEffect(() => {
    return () => {
      stopPeriodicChecks()
    }
  }, [stopPeriodicChecks])

  const check = useCallback(() => {
    void checkForUpdates()
  }, [checkForUpdates])

  return {
    isChecking,
    updateAvailable,
    version: version ?? '',
    check,
    error
  }
}
