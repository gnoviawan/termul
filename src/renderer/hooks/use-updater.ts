import { useEffect, useCallback, useState } from 'react'
import { useUpdaterStore, useUpdaterInternalActions } from '@/stores/updater-store'
import type { UpdateInfo, DownloadProgress, UpdaterErrorCode } from '@shared/types/updater.types'

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
 * Automatically checks for updates when component mounts.
 * Optionally skip auto-check with `autoCheck = false`.
 * Manually trigger with returned `check()` function.
 * 
 * Sets up event listeners for:
 * - onUpdateAvailable - Update store when update found
 * - onUpdateDownloaded - Update store when downloaded
 * - onDownloadProgress - Update progress
 * - onError - Handle errors
 * 
 * @param autoCheck - Whether to automatically check on mount (default: true)
 * @returns Object containing update state and check function
 * 
 * @example
 * ```tsx
 * // Auto-check on mount
 * function App() {
 *   const { isChecking, updateAvailable, version, check, error } = useUpdateCheck()
 *   
 *   return (
 *     <div>
 *       {isChecking && <span>Checking for updates...</span>}
 *       {updateAvailable && <span>Version {version} available!</span>}
 *       {error && <span>Error: {error}</span>}
 *     </div>
 *   )
 * }
 * ```
 * 
 * @example
 * ```tsx
 * // Manual check only
 * function Settings() {
 *   const { isChecking, updateAvailable, version, check, error } = useUpdateCheck(false)
 *   
 *   return (
 *     <button onClick={check} disabled={isChecking}>
 *       {isChecking ? 'Checking...' : 'Check for Updates'}
 *     </button>
 *   )
 * }
 * ```
 */
export function useUpdateCheck(autoCheck = true) {
  const [isInitialized, setIsInitialized] = useState(false)
  
  // Get state from store
  const isChecking = useUpdaterStore((state) => state.isChecking)
  const updateAvailable = useUpdaterStore((state) => state.updateAvailable)
  const version = useUpdaterStore((state) => state.version)
  const error = useUpdaterStore((state) => state.error)
  
  // Get actions
  const checkForUpdates = useUpdaterStore((state) => state.checkForUpdates)
  
  // Get internal actions for IPC event handling
  const internalActions = useUpdaterInternalActions()

  /**
   * Manual check function
   * Can be called by user action or on mount
   */
  const check = useCallback(() => {
    checkForUpdates()
  }, [checkForUpdates])

  // Set up IPC event listeners
  useEffect(() => {
    // Check if updater API is available
    if (!window.api.updater) {
      console.warn('Updater API not available. Make sure preload is properly configured.')
      return
    }

    // Set up event listeners for updater events
    const unsubscribeUpdateAvailable = window.api.updater.onUpdateAvailable((info: UpdateInfo) => {
      internalActions._setUpdateAvailable(info)
    })

    const unsubscribeUpdateDownloaded = window.api.updater.onUpdateDownloaded((info: UpdateInfo) => {
      internalActions._setUpdateDownloaded(info)
    })

    const unsubscribeDownloadProgress = window.api.updater.onDownloadProgress((progress: DownloadProgress) => {
      internalActions._setDownloadProgress(progress)
    })

    const unsubscribeError = window.api.updater.onError((errorMsg: string, code: UpdaterErrorCode) => {
      internalActions._setUpdaterError(errorMsg, code)
    })

    // Initialize state from main process on mount
    const initializeState = async () => {
      try {
        const result = await window.api.updater?.getState()
        if (result?.success && result.data) {
          internalActions._initializeState(result.data)
        }

        // Get auto-update enabled setting
        const autoUpdateResult = await window.api.updater?.getAutoUpdateEnabled()
        if (autoUpdateResult?.success) {
          // Only update if data is a boolean, otherwise preserve default (true)
          if (typeof autoUpdateResult.data === 'boolean') {
            useUpdaterStore.setState({ autoUpdateEnabled: autoUpdateResult.data })
          }
        }
      } catch (err) {
        console.error('Failed to initialize updater state:', err)
      } finally {
        setIsInitialized(true)
      }
    }

    initializeState()

    // Cleanup function - remove all event listeners
    return () => {
      unsubscribeUpdateAvailable()
      unsubscribeUpdateDownloaded()
      unsubscribeDownloadProgress()
      unsubscribeError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Run once on mount

  // Auto-check on mount if enabled and after initialization
  useEffect(() => {
    if (autoCheck && isInitialized) {
      check()
    }
  }, [autoCheck, isInitialized, check])

  return {
    isChecking,
    updateAvailable,
    version,
    check,
    error
  }
}
