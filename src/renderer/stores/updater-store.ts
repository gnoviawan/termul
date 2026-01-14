import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type {
  UpdateInfo,
  UpdateState,
  DownloadProgress
} from '@shared/types/updater.types'

/**
 * Updater store state interface
 * Manages the state for application auto-updater functionality
 */
export interface UpdaterStoreState {
  // State
  updateAvailable: boolean
  version: string | null
  downloaded: boolean
  downloadProgress: number
  skippedVersion: string | null
  isChecking: boolean
  isDownloading: boolean
  error: string | null
  lastChecked: Date | null
  autoUpdateEnabled: boolean

  // Actions
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installAndRestart: () => Promise<void>
  skipVersion: (version: string) => Promise<void>
  setError: (error: string | null) => void
  setAutoUpdateEnabled: (enabled: boolean) => Promise<void>

  // Internal actions (for IPC event listeners)
  _setUpdateAvailable: (info: UpdateInfo) => void
  _setUpdateDownloaded: (info: UpdateInfo) => void
  _setDownloadProgress: (progress: DownloadProgress) => void
  _setUpdaterError: (error: string, code?: string) => void
  _initializeState: (state: UpdateState) => void
}

/**
 * Updater Zustand store
 * Manages application update state and provides actions for update operations
 */
export const useUpdaterStore = create<UpdaterStoreState>((set, get) => ({
  // Initial state
  updateAvailable: false,
  version: null,
  downloaded: false,
  downloadProgress: 0,
  skippedVersion: null,
  isChecking: false,
  isDownloading: false,
  error: null,
  lastChecked: null,
  autoUpdateEnabled: true,

  /**
   * Check for available updates via IPC
   */
  checkForUpdates: async (): Promise<void> => {
    const { isChecking } = get()
    if (isChecking) return

    set({ isChecking: true, error: null })

    try {
      const result = await window.api.updater?.checkForUpdates()

      if (result?.success === false) {
        set({ error: result.error ?? 'Failed to check for updates' })
      }

      set({ lastChecked: new Date() })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to check for updates'
      set({ error: errorMessage })
    } finally {
      set({ isChecking: false })
    }
  },

  /**
   * Download the available update via IPC
   */
  downloadUpdate: async (): Promise<void> => {
    const { isDownloading, updateAvailable } = get()
    if (isDownloading || !updateAvailable) return

    set({ isDownloading: true, error: null, downloadProgress: 0 })

    try {
      const result = await window.api.updater?.downloadUpdate()

      if (result?.success === false) {
        set({ error: result.error ?? 'Failed to download update' })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to download update'
      set({ error: errorMessage })
    } finally {
      set({ isDownloading: false })
    }
  },

  /**
   * Install the downloaded update and restart the application
   */
  installAndRestart: async (): Promise<void> => {
    const { downloaded } = get()
    if (!downloaded) return

    set({ error: null })

    try {
      const result = await window.api.updater?.installAndRestart()

      if (result?.success === false) {
        set({ error: result.error ?? 'Failed to install update' })
      }
      // Note: Application will restart if successful, so no need to update state
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to install update'
      set({ error: errorMessage })
    }
  },

  /**
   * Skip a specific version update
   */
  skipVersion: async (version: string): Promise<void> => {
    set({ error: null })

    try {
      const result = await window.api.updater?.skipVersion(version)

      if (result?.success === false) {
        set({ error: result.error ?? 'Failed to skip version' })
      } else {
        set({ skippedVersion: version, updateAvailable: false })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to skip version'
      set({ error: errorMessage })
    }
  },

  /**
   * Set error state manually
   */
  setError: (error: string | null): void => {
    set({ error })
  },

  /**
   * Enable or disable auto-updates
   */
  setAutoUpdateEnabled: async (enabled: boolean): Promise<void> => {
    set({ error: null })

    try {
      const result = await window.api.updater?.setAutoUpdateEnabled(enabled)

      if (result?.success === false) {
        set({ error: result.error ?? 'Failed to update auto-update setting' })
      } else {
        set({ autoUpdateEnabled: enabled })
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to update auto-update setting'
      set({ error: errorMessage })
    }
  },

  /**
   * Internal action: Called when update becomes available (IPC event)
   */
  _setUpdateAvailable: (info: UpdateInfo): void => {
    set({
      updateAvailable: true,
      version: info.version,
      downloaded: false,
      downloadProgress: 0,
      error: null
    })
  },

  /**
   * Internal action: Called when update is downloaded (IPC event)
   */
  _setUpdateDownloaded: (info: UpdateInfo): void => {
    set({
      updateAvailable: true,
      version: info.version,
      downloaded: true,
      downloadProgress: 100,
      isDownloading: false,
      error: null
    })
  },

  /**
   * Internal action: Called when download progress updates (IPC event)
   */
  _setDownloadProgress: (progress: DownloadProgress): void => {
    set({ downloadProgress: progress.percent })
  },

  /**
   * Internal action: Called when updater error occurs (IPC event)
   */
  _setUpdaterError: (error: string, code?: string): void => {
    set({ error: code ? `${error} (${code})` : error, isChecking: false, isDownloading: false })
  },

  /**
   * Internal action: Initialize state from main process
   */
  _initializeState: (state: UpdateState): void => {
    set({
      updateAvailable: state.updateAvailable,
      version: state.version,
      downloaded: state.downloaded,
      downloadProgress: state.downloadProgress?.percent ?? 0,
      isChecking: state.isChecking,
      isDownloading: state.isDownloading,
      error: state.error,
      lastChecked: state.lastChecked ? new Date(state.lastChecked) : null,
      autoUpdateEnabled: true // Will be fetched separately
    })
  }
}))

// ============================================================================
// SELECTORS (for performance - use useShallow pattern)
// ============================================================================

/**
 * Selector: Check if an update is available
 */
export function useUpdateAvailable(): boolean {
  return useUpdaterStore((state) => state.updateAvailable)
}

/**
 * Selector: Get the available version
 */
export function useUpdateVersion(): string | null {
  return useUpdaterStore((state) => state.version)
}

/**
 * Selector: Check if update is downloaded and ready to install
 */
export function useUpdateDownloaded(): boolean {
  return useUpdaterStore((state) => state.downloaded)
}

/**
 * Selector: Get download progress (0-100)
 */
export function useDownloadProgress(): number {
  return useUpdaterStore((state) => state.downloadProgress)
}

/**
 * Selector: Check if currently checking for updates
 */
export function useIsChecking(): boolean {
  return useUpdaterStore((state) => state.isChecking)
}

/**
 * Selector: Check if currently downloading update
 */
export function useIsDownloading(): boolean {
  return useUpdaterStore((state) => state.isDownloading)
}

/**
 * Selector: Get updater error message
 */
export function useUpdaterError(): string | null {
  return useUpdaterStore((state) => state.error)
}

/**
 * Selector: Get last checked timestamp
 */
export function useLastChecked(): Date | null {
  return useUpdaterStore((state) => state.lastChecked)
}

/**
 * Selector: Check if auto-update is enabled
 */
export function useAutoUpdateEnabled(): boolean {
  return useUpdaterStore((state) => state.autoUpdateEnabled)
}

/**
 * Selector: Get skipped version
 */
export function useSkippedVersion(): string | null {
  return useUpdaterStore((state) => state.skippedVersion)
}

/**
 * Selector: Get updater state object (all state except actions)
 */
export function useUpdaterState() {
  return useUpdaterStore(
    useShallow((state) => ({
      updateAvailable: state.updateAvailable,
      version: state.version,
      downloaded: state.downloaded,
      downloadProgress: state.downloadProgress,
      skippedVersion: state.skippedVersion,
      isChecking: state.isChecking,
      isDownloading: state.isDownloading,
      error: state.error,
      lastChecked: state.lastChecked,
      autoUpdateEnabled: state.autoUpdateEnabled
    }))
  )
}

/**
 * Selector: Get updater actions (all actions except state)
 */
export function useUpdaterActions() {
  return useUpdaterStore(
    useShallow((state) => ({
      checkForUpdates: state.checkForUpdates,
      downloadUpdate: state.downloadUpdate,
      installAndRestart: state.installAndRestart,
      skipVersion: state.skipVersion,
      setError: state.setError,
      setAutoUpdateEnabled: state.setAutoUpdateEnabled
    }))
  )
}

/**
 * Selector: Get internal actions (for IPC event setup)
 * These should only be used in a component that sets up IPC listeners
 */
export function useUpdaterInternalActions() {
  return useUpdaterStore(
    useShallow((state) => ({
      _setUpdateAvailable: state._setUpdateAvailable,
      _setUpdateDownloaded: state._setUpdateDownloaded,
      _setDownloadProgress: state._setDownloadProgress,
      _setUpdaterError: state._setUpdaterError,
      _initializeState: state._initializeState
    }))
  )
}

// Raw store export for accessing store outside of React components
// Usage: updaterStore.getState()
export const updaterStore = useUpdaterStore
