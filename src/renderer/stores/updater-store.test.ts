import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUpdaterStore } from './updater-store'
import type { UpdateInfo, DownloadProgress, UpdateState } from '@shared/types/updater.types'
import * as apiBridge from '@/lib/api-bridge'
import * as tauriUpdaterApi from '@/lib/tauri-updater-api'
import * as tauriVersionSkip from '@/lib/tauri-version-skip'
import * as tauriSafeUpdate from '@/lib/tauri-safe-update'

vi.mock('@/lib/api-bridge', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-bridge')>('@/lib/api-bridge')
  return {
    ...actual,
    isTauri: vi.fn(() => false)
  }
})

vi.mock('@/lib/tauri-updater-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-updater-api')>('@/lib/tauri-updater-api')
  return {
    ...actual,
    downloadUpdate: vi.fn(),
    installAndRestart: vi.fn(),
    setAutoUpdateEnabled: vi.fn(),
    getAutoUpdateEnabled: vi.fn(),
    getUpdaterState: vi.fn(),
    registerUpdateEventHandlers: vi.fn(() => () => {}),
    checkForUpdates: vi.fn()
  }
})

vi.mock('@/lib/tauri-version-skip', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-version-skip')>(
    '@/lib/tauri-version-skip'
  )
  return {
    ...actual,
    getSkippedVersion: vi.fn(),
    isVersionSkipped: vi.fn(),
    clearSkippedVersion: vi.fn(),
    skipVersion: vi.fn()
  }
})

vi.mock('@/lib/tauri-safe-update', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-safe-update')>(
    '@/lib/tauri-safe-update'
  )
  return {
    ...actual,
    hasActiveTerminalSessions: vi.fn(() => false)
  }
})

// Mock window.api.updater
const mockUpdaterApi = {
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  installAndRestart: vi.fn(),
  skipVersion: vi.fn(),
  getState: vi.fn(),
  setAutoUpdateEnabled: vi.fn(),
  getAutoUpdateEnabled: vi.fn(),
  onUpdateAvailable: vi.fn(() => () => {}),
  onUpdateDownloaded: vi.fn(() => () => {}),
  onDownloadProgress: vi.fn(() => () => {}),
  onError: vi.fn(() => () => {})
}

beforeEach(() => {
  useUpdaterStore.getState().stopPeriodicChecks()

  vi.clearAllMocks()
  vi.mocked(apiBridge.isTauri).mockReturnValue(false)
  vi.stubGlobal('api', { updater: mockUpdaterApi })

  vi.mocked(tauriUpdaterApi.downloadUpdate).mockResolvedValue({
    success: true,
    data: undefined
  })
  vi.mocked(tauriUpdaterApi.installAndRestart).mockResolvedValue({
    success: true,
    data: undefined
  })
  vi.mocked(tauriUpdaterApi.setAutoUpdateEnabled).mockResolvedValue({
    success: true,
    data: undefined
  })
  vi.mocked(tauriUpdaterApi.getAutoUpdateEnabled).mockResolvedValue({
    success: true,
    data: true
  })
  vi.mocked(tauriUpdaterApi.getUpdaterState).mockResolvedValue({
    success: true,
    data: {
      updateAvailable: false,
      downloaded: false,
      version: null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: null
    }
  })
  vi.mocked(tauriUpdaterApi.checkForUpdates).mockResolvedValue(null)

  vi.mocked(tauriVersionSkip.getSkippedVersion).mockResolvedValue(null)
  vi.mocked(tauriVersionSkip.isVersionSkipped).mockResolvedValue(false)
  vi.mocked(tauriVersionSkip.clearSkippedVersion).mockResolvedValue()
  vi.mocked(tauriVersionSkip.skipVersion).mockResolvedValue()
  vi.mocked(tauriSafeUpdate.hasActiveTerminalSessions).mockReturnValue(false)

  mockUpdaterApi.checkForUpdates.mockResolvedValue({ success: true, data: null })
  mockUpdaterApi.downloadUpdate.mockResolvedValue({ success: true, data: undefined })
  mockUpdaterApi.installAndRestart.mockResolvedValue({ success: true, data: undefined })
  mockUpdaterApi.skipVersion.mockResolvedValue({ success: true, data: undefined })
  mockUpdaterApi.getState.mockResolvedValue({
    success: true,
    data: {
      updateAvailable: false,
      downloaded: false,
      version: null,
      isChecking: false,
      isDownloading: false,
      downloadProgress: null,
      error: null,
      lastChecked: null
    }
  })
  mockUpdaterApi.getAutoUpdateEnabled.mockResolvedValue({ success: true, data: true })
  mockUpdaterApi.setAutoUpdateEnabled.mockResolvedValue({ success: true, data: undefined })

  // Reset store to initial state
  useUpdaterStore.setState({
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
    hasActiveTerminals: false
  })
})

describe('updater-store', () => {
  describe('tauri integration paths', () => {
    it('should surface tauri download failure without marking update as downloaded', async () => {
      vi.mocked(apiBridge.isTauri).mockReturnValue(true)
      useUpdaterStore.setState({ updateAvailable: true, downloaded: false })

      vi.mocked(tauriUpdaterApi.downloadUpdate).mockResolvedValue({
        success: false,
        error: 'tauri download failed',
        code: 'DOWNLOAD_FAILED'
      })

      await useUpdaterStore.getState().downloadUpdate()

      const state = useUpdaterStore.getState()
      expect(state.downloaded).toBe(false)
      expect(state.error).toBe('tauri download failed')
      expect(state.isDownloading).toBe(false)
    })

    it('should surface tauri install failure', async () => {
      vi.mocked(apiBridge.isTauri).mockReturnValue(true)
      useUpdaterStore.setState({ downloaded: true, error: null })

      vi.mocked(tauriUpdaterApi.installAndRestart).mockResolvedValue({
        success: false,
        error: 'tauri install failed',
        code: 'INSTALL_FAILED'
      })

      await useUpdaterStore.getState().installAndRestart()

      expect(useUpdaterStore.getState().error).toBe('tauri install failed')
    })

    it('should run startup auto-check after non-auto initialization if requested later', async () => {
      vi.mocked(apiBridge.isTauri).mockReturnValue(true)
      vi.mocked(tauriUpdaterApi.getAutoUpdateEnabled).mockResolvedValue({
        success: true,
        data: true
      })
      vi.mocked(tauriUpdaterApi.checkForUpdates).mockResolvedValue({
        version: '2.1.0',
        releaseDate: '2026-01-01T00:00:00.000Z',
        releaseNotes: 'notes',
        isSecurityUpdate: false
      })

      await useUpdaterStore.getState().initializeUpdater({ autoCheck: false })
      expect(tauriUpdaterApi.checkForUpdates).not.toHaveBeenCalled()

      await useUpdaterStore.getState().initializeUpdater({ autoCheck: true })
      expect(tauriUpdaterApi.checkForUpdates).toHaveBeenCalledTimes(1)

      await useUpdaterStore.getState().initializeUpdater({ autoCheck: true })
      expect(tauriUpdaterApi.checkForUpdates).toHaveBeenCalledTimes(1)

      useUpdaterStore.getState().stopPeriodicChecks()
    })

    it('should not retry when check pause is caused by active terminals', async () => {
      vi.useFakeTimers()
      vi.mocked(apiBridge.isTauri).mockReturnValue(true)
      vi.mocked(tauriSafeUpdate.hasActiveTerminalSessions).mockReturnValue(true)

      await useUpdaterStore.getState().runCheckWithRetry()

      expect(tauriUpdaterApi.checkForUpdates).not.toHaveBeenCalled()
      expect(useUpdaterStore.getState().error).toBe(
        'Update checks paused because active terminal sessions are running.'
      )

      vi.useRealTimers()
    })

    it('should cancel in-flight retry when auto-update gets disabled', async () => {
      vi.useFakeTimers()
      vi.mocked(apiBridge.isTauri).mockReturnValue(false)
      mockUpdaterApi.checkForUpdates.mockResolvedValue({ success: false, error: 'Network error' })

      const retryPromise = useUpdaterStore.getState().runCheckWithRetry()
      await Promise.resolve()

      await useUpdaterStore.getState().setAutoUpdateEnabled(false)

      await vi.runAllTimersAsync()
      await retryPromise

      expect(mockUpdaterApi.checkForUpdates).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })

    it('should not schedule periodic checks if updater is stopped during initialization', async () => {
      vi.useFakeTimers()
      vi.mocked(apiBridge.isTauri).mockReturnValue(true)

      const statePromise = new Promise<{ success: true; data: UpdateState }>((resolve) => {
        setTimeout(() => {
          resolve({
            success: true,
            data: {
              updateAvailable: false,
              downloaded: false,
              version: null,
              isChecking: false,
              isDownloading: false,
              downloadProgress: null,
              error: null,
              lastChecked: null
            }
          })
        }, 0)
      })
      vi.mocked(tauriUpdaterApi.getUpdaterState).mockImplementation(async () => await statePromise)

      const initializePromise = useUpdaterStore.getState().initializeUpdater({ autoCheck: false })
      await Promise.resolve()

      useUpdaterStore.getState().stopPeriodicChecks()

      await vi.runAllTimersAsync()
      await initializePromise

      expect(tauriUpdaterApi.checkForUpdates).not.toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('should enable auto-update and trigger immediate check when already initialized', async () => {
      vi.mocked(apiBridge.isTauri).mockReturnValue(false)
      mockUpdaterApi.getAutoUpdateEnabled.mockResolvedValue({ success: true, data: false })

      await useUpdaterStore.getState().initializeUpdater({ autoCheck: false })
      expect(useUpdaterStore.getState().autoUpdateEnabled).toBe(false)

      await useUpdaterStore.getState().setAutoUpdateEnabled(true)

      expect(useUpdaterStore.getState().autoUpdateEnabled).toBe(true)
      expect(mockUpdaterApi.checkForUpdates).toHaveBeenCalled()

      useUpdaterStore.getState().stopPeriodicChecks()
    })
  })

  describe('checkForUpdates', () => {
    it('should set isChecking during check', async () => {
      mockUpdaterApi.checkForUpdates.mockResolvedValue({
        success: true,
        data: null
      })

      const promise = useUpdaterStore.getState().checkForUpdates()
      expect(useUpdaterStore.getState().isChecking).toBe(true)

      await promise
      expect(useUpdaterStore.getState().isChecking).toBe(false)
    })

    it('should not run concurrent checks', async () => {
      mockUpdaterApi.checkForUpdates.mockResolvedValue({
        success: true,
        data: null
      })

      useUpdaterStore.setState({ isChecking: true })
      await useUpdaterStore.getState().checkForUpdates()

      expect(mockUpdaterApi.checkForUpdates).not.toHaveBeenCalled()
    })

    it('should set error on failure', async () => {
      mockUpdaterApi.checkForUpdates.mockResolvedValue({
        success: false,
        error: 'Network error'
      })

      await useUpdaterStore.getState().checkForUpdates()

      expect(useUpdaterStore.getState().error).toBe('Network error')
      expect(useUpdaterStore.getState().isChecking).toBe(false)
    })

    it('should not set updateAvailable from response data (relies on events)', async () => {
      mockUpdaterApi.checkForUpdates.mockResolvedValue({
        success: true,
        data: { version: '2.0.0', releaseDate: '2026-01-01', isSecurityUpdate: false }
      })

      await useUpdaterStore.getState().checkForUpdates()

      // Response data should NOT trigger updateAvailable — only IPC events should
      expect(useUpdaterStore.getState().updateAvailable).toBe(false)
      expect(useUpdaterStore.getState().version).toBeNull()
    })

    it('should update lastChecked after check', async () => {
      mockUpdaterApi.checkForUpdates.mockResolvedValue({
        success: true,
        data: null
      })

      await useUpdaterStore.getState().checkForUpdates()

      expect(useUpdaterStore.getState().lastChecked).toBeInstanceOf(Date)
    })
  })

  describe('internal actions', () => {
    it('_setUpdateAvailable should set update info', () => {
      const info: UpdateInfo = {
        version: '2.0.0',
        releaseDate: '2026-01-01',
        isSecurityUpdate: false
      }

      useUpdaterStore.getState()._setUpdateAvailable(info)

      const state = useUpdaterStore.getState()
      expect(state.updateAvailable).toBe(true)
      expect(state.version).toBe('2.0.0')
      expect(state.downloaded).toBe(false)
      expect(state.error).toBeNull()
    })

    it('_setUpdateDownloaded should mark as downloaded', () => {
      const info: UpdateInfo = {
        version: '2.0.0',
        releaseDate: '2026-01-01',
        isSecurityUpdate: false
      }

      useUpdaterStore.getState()._setUpdateDownloaded(info)

      const state = useUpdaterStore.getState()
      expect(state.updateAvailable).toBe(true)
      expect(state.downloaded).toBe(true)
      expect(state.downloadProgress).toBe(100)
      expect(state.isDownloading).toBe(false)
    })

    it('_setDownloadProgress should update progress', () => {
      const progress: DownloadProgress = {
        bytesPerSecond: 1000,
        percent: 50,
        transferred: 500,
        total: 1000
      }

      useUpdaterStore.getState()._setDownloadProgress(progress)

      expect(useUpdaterStore.getState().downloadProgress).toBe(50)
    })

    it('_setUpdaterError should set error and clear checking/downloading', () => {
      useUpdaterStore.setState({ isChecking: true, isDownloading: true })

      useUpdaterStore.getState()._setUpdaterError('Something failed', 'NETWORK_ERROR')

      const state = useUpdaterStore.getState()
      expect(state.error).toBe('Something failed (NETWORK_ERROR)')
      expect(state.isChecking).toBe(false)
      expect(state.isDownloading).toBe(false)
    })

    it('_initializeState should hydrate from main process state', () => {
      const mainState: UpdateState = {
        updateAvailable: true,
        downloaded: false,
        version: '2.0.0',
        isChecking: false,
        isDownloading: false,
        downloadProgress: null,
        error: null,
        lastChecked: '2026-01-01T00:00:00.000Z'
      }

      useUpdaterStore.getState()._initializeState(mainState)

      const state = useUpdaterStore.getState()
      expect(state.updateAvailable).toBe(true)
      expect(state.version).toBe('2.0.0')
      expect(state.lastChecked).toBeInstanceOf(Date)
    })
  })

  describe('skipVersion', () => {
    it('should set skippedVersion and clear updateAvailable', async () => {
      mockUpdaterApi.skipVersion.mockResolvedValue({ success: true, data: undefined })
      useUpdaterStore.setState({ updateAvailable: true, version: '2.0.0' })

      await useUpdaterStore.getState().skipVersion('2.0.0')

      const state = useUpdaterStore.getState()
      expect(state.skippedVersion).toBe('2.0.0')
      expect(state.updateAvailable).toBe(false)
    })
  })
})
