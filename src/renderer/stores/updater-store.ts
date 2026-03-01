import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type {
  UpdateInfo,
  UpdateState,
  DownloadProgress
} from '@shared/types/updater.types'
import { isTauri } from '@/lib/api-bridge'
import {
  checkForUpdates as tauriCheckForUpdates,
  downloadUpdate as tauriDownloadUpdate,
  installAndRestart as tauriInstallAndRestart,
  getUpdaterState as tauriGetUpdaterState,
  setAutoUpdateEnabled as tauriSetAutoUpdateEnabled,
  getAutoUpdateEnabled as tauriGetAutoUpdateEnabled,
  registerUpdateEventHandlers,
  clearPendingUpdate,
  type TauriUpdaterEventHandlers
} from '@/lib/tauri-updater-api'
import {
  getSkippedVersion,
  skipVersion as tauriSkipVersion,
  clearSkippedVersion,
  isVersionSkipped
} from '@/lib/tauri-version-skip'
import { hasActiveTerminalSessions } from '@/lib/tauri-safe-update'

const RETRY_DELAYS_MS = [5000, 30000, 300000] as const
const BASE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000
const CHECK_STAGGER_MS = 2 * 60 * 60 * 1000

let periodicCheckTimer: ReturnType<typeof setTimeout> | null = null
let activeTauriUpdaterUnsubscribe: (() => void) | null = null
let isInitialized = false
let initializationPromise: Promise<void> | null = null
let hasCompletedStartupAutoCheck = false
let updaterLifecycleGeneration = 0

function clearPeriodicCheckTimer(): void {
  if (periodicCheckTimer) {
    clearTimeout(periodicCheckTimer)
    periodicCheckTimer = null
  }
}

function getPeriodicDelayMs(): number {
  return BASE_CHECK_INTERVAL_MS + Math.floor(Math.random() * CHECK_STAGGER_MS)
}

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
  releaseNotes: string | null
  hasActiveTerminals: boolean

  // Actions
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installAndRestart: () => Promise<void>
  skipVersion: (version: string) => Promise<void>
  setError: (error: string | null) => void
  setAutoUpdateEnabled: (enabled: boolean) => Promise<void>
  initializeUpdater: (options?: { autoCheck?: boolean }) => Promise<void>
  schedulePeriodicChecks: (generation?: number) => void
  stopPeriodicChecks: () => void
  runCheckWithRetry: (generation?: number) => Promise<void>

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
  releaseNotes: null,
  hasActiveTerminals: false,

  /**
   * Check for available updates via IPC / Tauri updater plugin
   */
  checkForUpdates: async (): Promise<void> => {
    const { isChecking } = get()
    if (isChecking) return

    set({ isChecking: true, error: null })

    try {
      if (isTauri()) {
        const activeTerminals = hasActiveTerminalSessions()
        set({ hasActiveTerminals: activeTerminals })

        if (activeTerminals) {
          set({
            isChecking: false,
            error: 'Update checks paused because active terminal sessions are running.'
          })
          return
        }

        const updateInfo = await tauriCheckForUpdates()
        const checkedAt = new Date()

        if (!updateInfo) {
          await clearPendingUpdate()
          set({
            updateAvailable: false,
            downloaded: false,
            version: null,
            downloadProgress: 0,
            releaseNotes: null,
            error: null,
            lastChecked: checkedAt
          })
          return
        }

        const skippedVersion = await getSkippedVersion()
        const shouldSkipVersion = await isVersionSkipped(updateInfo.version)

        if (shouldSkipVersion) {
          set({
            skippedVersion,
            updateAvailable: false,
            downloaded: false,
            version: updateInfo.version,
            releaseNotes: updateInfo.releaseNotes ?? null,
            downloadProgress: 0,
            error: null,
            lastChecked: checkedAt
          })
          return
        }

        if (skippedVersion && skippedVersion !== updateInfo.version) {
          await clearSkippedVersion()
          set({ skippedVersion: null })
        }

        set({
          updateAvailable: true,
          downloaded: false,
          version: updateInfo.version,
          releaseNotes: updateInfo.releaseNotes ?? null,
          downloadProgress: 0,
          error: null,
          lastChecked: checkedAt
        })

        return
      }

      if (!window.api?.updater) {
        set({ error: 'Updater API not available in this environment' })
        return
      }

      const result = await window.api.updater.checkForUpdates()

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
   * Download the available update via IPC / Tauri updater plugin
   */
  downloadUpdate: async (): Promise<void> => {
    const { isDownloading, updateAvailable } = get()
    if (isDownloading || !updateAvailable) return

    set({ isDownloading: true, error: null, downloadProgress: 0 })

    try {
      if (isTauri()) {
        const result = await tauriDownloadUpdate((progress) => {
          get()._setDownloadProgress(progress)
        })

        if (result.success) {
          set({
            downloaded: true,
            downloadProgress: 100,
            error: null
          })
        } else {
          set({
            error: result.error ?? 'Failed to download update',
            downloaded: false
          })
        }

        return
      }

      if (!window.api?.updater) {
        set({ error: 'Updater API not available in this environment' })
        return
      }

      const result = await window.api.updater.downloadUpdate()

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
      if (isTauri()) {
        const result = await tauriInstallAndRestart()
        if (!result.success) {
          set({ error: result.error ?? 'Failed to install update' })
        }
        return
      }

      if (!window.api?.updater) {
        set({ error: 'Updater API not available in this environment' })
        return
      }

      const result = await window.api.updater.installAndRestart()

      if (result?.success === false) {
        set({ error: result.error ?? 'Failed to install update' })
      }
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
      if (isTauri()) {
        await tauriSkipVersion(version)
        set({ skippedVersion: version, updateAvailable: false, downloaded: false })
        return
      }

      if (!window.api?.updater) {
        set({ error: 'Updater API not available in this environment' })
        return
      }

      const result = await window.api.updater.skipVersion(version)

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

    const applyAutoUpdateSetting = async (): Promise<void> => {
      set({ autoUpdateEnabled: enabled })

      if (!enabled) {
        updaterLifecycleGeneration += 1
        clearPeriodicCheckTimer()
        return
      }

      if (isInitialized) {
        const generation = updaterLifecycleGeneration
        await get().runCheckWithRetry(generation)
        if (generation !== updaterLifecycleGeneration) return
        get().schedulePeriodicChecks(generation)
      }
    }

    try {
      if (isTauri()) {
        const result = await tauriSetAutoUpdateEnabled(enabled)
        if (result.success) {
          await applyAutoUpdateSetting()
        } else {
          set({ error: result.error ?? 'Failed to update auto-update setting' })
        }
        return
      }

      if (!window.api?.updater) {
        set({ error: 'Updater API not available in this environment' })
        return
      }

      const result = await window.api.updater.setAutoUpdateEnabled(enabled)

      if (result?.success === false) {
        set({ error: result.error ?? 'Failed to update auto-update setting' })
      } else {
        await applyAutoUpdateSetting()
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to update auto-update setting'
      set({ error: errorMessage })
    }
  },

  initializeUpdater: async (options?: { autoCheck?: boolean }): Promise<void> => {
    const currentGeneration = updaterLifecycleGeneration

    if (initializationPromise) {
      await initializationPromise
      if (currentGeneration !== updaterLifecycleGeneration) return

      if (options?.autoCheck === true && !hasCompletedStartupAutoCheck && get().autoUpdateEnabled) {
        await get().runCheckWithRetry(currentGeneration)
        if (currentGeneration !== updaterLifecycleGeneration) return
        hasCompletedStartupAutoCheck = true
      }
      return
    }

    if (isInitialized) {
      if (currentGeneration !== updaterLifecycleGeneration) return

      if (options?.autoCheck === true && !hasCompletedStartupAutoCheck && get().autoUpdateEnabled) {
        await get().runCheckWithRetry(currentGeneration)
        if (currentGeneration !== updaterLifecycleGeneration) return
        hasCompletedStartupAutoCheck = true
      }
      return
    }

    initializationPromise = (async () => {
      isInitialized = true

      try {
        if (isTauri()) {
          const events: TauriUpdaterEventHandlers = {
            onUpdateAvailable: (update) => {
              get()._setUpdateAvailable({
                version: update.version,
                releaseDate: new Date().toISOString(),
                releaseNotes: update.body ?? undefined,
                isSecurityUpdate: false
              })
            },
            onDownloadProgress: (progress) => {
              get()._setDownloadProgress(progress)
            },
            onUpdateDownloaded: (update) => {
              get()._setUpdateDownloaded({
                version: update.version,
                releaseDate: new Date().toISOString(),
                releaseNotes: update.body ?? undefined,
                isSecurityUpdate: false
              })
            },
            onError: (error) => {
              get()._setUpdaterError(error)
            }
          }

          if (currentGeneration !== updaterLifecycleGeneration) return
          activeTauriUpdaterUnsubscribe?.()
          activeTauriUpdaterUnsubscribe = registerUpdateEventHandlers(events)

          const stateResult = await tauriGetUpdaterState()
          if (currentGeneration !== updaterLifecycleGeneration) return
          if (stateResult.success) {
            get()._initializeState(stateResult.data)
          } else {
            get()._setUpdaterError(stateResult.error ?? 'Failed to load updater state')
          }

          const autoUpdateResult = await tauriGetAutoUpdateEnabled()
          if (currentGeneration !== updaterLifecycleGeneration) return
          if (autoUpdateResult.success) {
            set({ autoUpdateEnabled: autoUpdateResult.data })
          }

          const skippedVersion = await getSkippedVersion()
          if (currentGeneration !== updaterLifecycleGeneration) return
          set({ skippedVersion })

          if (options?.autoCheck === true && get().autoUpdateEnabled) {
            await get().runCheckWithRetry(currentGeneration)
            if (currentGeneration !== updaterLifecycleGeneration) return
            hasCompletedStartupAutoCheck = true
          }

          if (get().autoUpdateEnabled) {
            get().schedulePeriodicChecks(currentGeneration)
          }

          return
        }

        if (!window.api?.updater) {
          set({ error: 'Updater API not available in this environment' })
          return
        }

        const state = await window.api.updater.getState()
        if (currentGeneration !== updaterLifecycleGeneration) return
        if (state.success) {
          get()._initializeState(state.data)
        }

        const autoUpdateEnabled = await window.api.updater.getAutoUpdateEnabled()
        if (currentGeneration !== updaterLifecycleGeneration) return
        if (autoUpdateEnabled.success) {
          set({ autoUpdateEnabled: autoUpdateEnabled.data })
        }

        if (options?.autoCheck === true && autoUpdateEnabled.success && autoUpdateEnabled.data) {
          await get().checkForUpdates()
          if (currentGeneration !== updaterLifecycleGeneration) return
          hasCompletedStartupAutoCheck = true
        }
      } catch (err) {
        isInitialized = false
        const errorMessage = err instanceof Error ? err.message : 'Failed to initialize updater'
        set({ error: errorMessage })
      } finally {
        initializationPromise = null
      }
    })()

    await initializationPromise
  },

  schedulePeriodicChecks: (generation?: number): void => {
    const targetGeneration = generation ?? updaterLifecycleGeneration
    if (targetGeneration !== updaterLifecycleGeneration) return

    clearPeriodicCheckTimer()

    const scheduleNext = () => {
      if (targetGeneration !== updaterLifecycleGeneration) return

      periodicCheckTimer = setTimeout(async () => {
        if (targetGeneration !== updaterLifecycleGeneration) return

        try {
          if (get().autoUpdateEnabled) {
            await get().runCheckWithRetry(targetGeneration)
          }
        } finally {
          if (targetGeneration === updaterLifecycleGeneration && get().autoUpdateEnabled) {
            scheduleNext()
          }
        }
      }, getPeriodicDelayMs())
    }

    if (get().autoUpdateEnabled) {
      scheduleNext()
    }
  },

  stopPeriodicChecks: (): void => {
    updaterLifecycleGeneration += 1
    clearPeriodicCheckTimer()
    activeTauriUpdaterUnsubscribe?.()
    activeTauriUpdaterUnsubscribe = null
    initializationPromise = null
    hasCompletedStartupAutoCheck = false
    isInitialized = false
  },

  runCheckWithRetry: async (generation?: number): Promise<void> => {
    const targetGeneration = generation ?? updaterLifecycleGeneration

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (targetGeneration !== updaterLifecycleGeneration || !get().autoUpdateEnabled) return

      await get().checkForUpdates()

      if (targetGeneration !== updaterLifecycleGeneration || !get().autoUpdateEnabled) return

      const currentError = get().error
      if (!currentError) return

      const isRetryablePauseError =
        currentError === 'Update checks paused because active terminal sessions are running.'
      if (isRetryablePauseError) return

      if (attempt === RETRY_DELAYS_MS.length) return

      const delay = RETRY_DELAYS_MS[attempt]
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), delay)
      })
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
      releaseNotes: info.releaseNotes ?? null,
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
      releaseNotes: info.releaseNotes ?? null,
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
    set({
      error: code ? `${error} (${code})` : error,
      isChecking: false,
      isDownloading: false,
      hasActiveTerminals: hasActiveTerminalSessions()
    })
  },

  /**
   * Internal action: Initialize state from main process
   */
  _initializeState: (state: UpdateState): void => {
    set((current) => ({
      updateAvailable: state.updateAvailable,
      version: state.version,
      downloaded: state.downloaded,
      downloadProgress: state.downloadProgress?.percent ?? 0,
      isChecking: state.isChecking,
      isDownloading: state.isDownloading,
      error: state.error,
      lastChecked: state.lastChecked ? new Date(state.lastChecked) : null,
      autoUpdateEnabled: current.autoUpdateEnabled,
      releaseNotes: null,
      hasActiveTerminals: hasActiveTerminalSessions()
    }))
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
      autoUpdateEnabled: state.autoUpdateEnabled,
      releaseNotes: state.releaseNotes,
      hasActiveTerminals: state.hasActiveTerminals
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
      setAutoUpdateEnabled: state.setAutoUpdateEnabled,
      initializeUpdater: state.initializeUpdater,
      schedulePeriodicChecks: state.schedulePeriodicChecks,
      stopPeriodicChecks: state.stopPeriodicChecks,
      runCheckWithRetry: state.runCheckWithRetry
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
