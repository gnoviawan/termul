import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUpdaterStore } from './updater-store'
import type { DownloadProgress, UpdateInfo, UpdateState } from '@shared/types/updater.types'
import * as tauriSafeUpdate from '@/lib/tauri-safe-update'
import * as tauriUpdaterApi from '@/lib/tauri-updater-api'
import * as tauriVersionSkip from '@/lib/tauri-version-skip'

vi.mock('@/lib/tauri-updater-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-updater-api')>(
    '@/lib/tauri-updater-api'
  )
  return {
    ...actual,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installAndRestart: vi.fn(),
    getUpdaterState: vi.fn(),
    setAutoUpdateEnabled: vi.fn(),
    getAutoUpdateEnabled: vi.fn(),
    registerUpdateEventHandlers: vi.fn(() => () => {}),
    clearPendingUpdate: vi.fn()
  }
})

vi.mock('@/lib/tauri-version-skip', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-version-skip')>(
    '@/lib/tauri-version-skip'
  )
  return {
    ...actual,
    getSkippedVersion: vi.fn(),
    skipVersion: vi.fn(),
    clearSkippedVersion: vi.fn(),
    isVersionSkipped: vi.fn()
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

const INITIAL_UPDATER_STATE: UpdateState = {
  updateAvailable: false,
  downloaded: false,
  version: null,
  isChecking: false,
  isDownloading: false,
  downloadProgress: null,
  error: null,
  lastChecked: null
}

beforeEach(() => {
  useUpdaterStore.getState().stopPeriodicChecks()
  vi.clearAllMocks()

  vi.mocked(tauriUpdaterApi.checkForUpdates).mockResolvedValue(null)
  vi.mocked(tauriUpdaterApi.downloadUpdate).mockResolvedValue({
    success: true,
    data: undefined
  })
  vi.mocked(tauriUpdaterApi.installAndRestart).mockResolvedValue({
    success: true,
    data: undefined
  })
  vi.mocked(tauriUpdaterApi.getUpdaterState).mockResolvedValue({
    success: true,
    data: INITIAL_UPDATER_STATE
  })
  vi.mocked(tauriUpdaterApi.setAutoUpdateEnabled).mockResolvedValue({
    success: true,
    data: undefined
  })
  vi.mocked(tauriUpdaterApi.getAutoUpdateEnabled).mockResolvedValue({
    success: true,
    data: true
  })

  vi.mocked(tauriVersionSkip.getSkippedVersion).mockResolvedValue(null)
  vi.mocked(tauriVersionSkip.skipVersion).mockResolvedValue()
  vi.mocked(tauriVersionSkip.clearSkippedVersion).mockResolvedValue()
  vi.mocked(tauriVersionSkip.isVersionSkipped).mockResolvedValue(false)

  vi.mocked(tauriSafeUpdate.hasActiveTerminalSessions).mockReturnValue(false)

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
  describe('checkForUpdates', () => {
    it('should set isChecking during check', async () => {
      vi.mocked(tauriUpdaterApi.checkForUpdates).mockImplementation(async () => {
        expect(useUpdaterStore.getState().isChecking).toBe(true)
        return null
      })

      await useUpdaterStore.getState().checkForUpdates()

      expect(useUpdaterStore.getState().isChecking).toBe(false)
    })

    it('should not run concurrent checks', async () => {
      useUpdaterStore.setState({ isChecking: true })

      await useUpdaterStore.getState().checkForUpdates()

      expect(tauriUpdaterApi.checkForUpdates).not.toHaveBeenCalled()
    })

    it('should populate update state when Tauri returns an available update', async () => {
      vi.mocked(tauriUpdaterApi.checkForUpdates).mockResolvedValue({
        version: '2.0.0',
        releaseDate: '2026-01-01T00:00:00.000Z',
        releaseNotes: 'Important fixes',
        isSecurityUpdate: false
      })

      await useUpdaterStore.getState().checkForUpdates()

      const state = useUpdaterStore.getState()
      expect(state.updateAvailable).toBe(true)
      expect(state.version).toBe('2.0.0')
      expect(state.releaseNotes).toBe('Important fixes')
      expect(state.lastChecked).toBeInstanceOf(Date)
    })

    it('should clear pending update state when no update is available', async () => {
      useUpdaterStore.setState({
        updateAvailable: true,
        downloaded: true,
        version: '2.0.0',
        downloadProgress: 100,
        releaseNotes: 'Old notes'
      })

      await useUpdaterStore.getState().checkForUpdates()

      const state = useUpdaterStore.getState()
      expect(tauriUpdaterApi.clearPendingUpdate).toHaveBeenCalled()
      expect(state.updateAvailable).toBe(false)
      expect(state.downloaded).toBe(false)
      expect(state.version).toBeNull()
      expect(state.releaseNotes).toBeNull()
      expect(state.downloadProgress).toBe(0)
    })

    it('should keep version skipped without surfacing update availability', async () => {
      vi.mocked(tauriUpdaterApi.checkForUpdates).mockResolvedValue({
        version: '2.0.0',
        releaseDate: '2026-01-01T00:00:00.000Z',
        isSecurityUpdate: false
      })
      vi.mocked(tauriVersionSkip.getSkippedVersion).mockResolvedValue('2.0.0')
      vi.mocked(tauriVersionSkip.isVersionSkipped).mockResolvedValue(true)

      await useUpdaterStore.getState().checkForUpdates()

      const state = useUpdaterStore.getState()
      expect(state.skippedVersion).toBe('2.0.0')
      expect(state.updateAvailable).toBe(false)
      expect(state.version).toBe('2.0.0')
    })

    it('should not call updater when active terminals exist', async () => {
      vi.mocked(tauriSafeUpdate.hasActiveTerminalSessions).mockReturnValue(true)

      await useUpdaterStore.getState().checkForUpdates()

      expect(tauriUpdaterApi.checkForUpdates).not.toHaveBeenCalled()
      expect(useUpdaterStore.getState().error).toBe(
        'Update checks paused because active terminal sessions are running.'
      )
    })

    it('should surface Tauri updater errors', async () => {
      vi.mocked(tauriUpdaterApi.checkForUpdates).mockRejectedValue(new Error('Network error'))

      await useUpdaterStore.getState().checkForUpdates()

      expect(useUpdaterStore.getState().error).toBe('Network error')
      expect(useUpdaterStore.getState().isChecking).toBe(false)
    })
  })

  describe('download/install/skip actions', () => {
    it('should surface tauri download failure without marking update as downloaded', async () => {
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
      useUpdaterStore.setState({ downloaded: true, error: null })
      vi.mocked(tauriUpdaterApi.installAndRestart).mockResolvedValue({
        success: false,
        error: 'tauri install failed',
        code: 'INSTALL_FAILED'
      })

      await useUpdaterStore.getState().installAndRestart()

      expect(useUpdaterStore.getState().error).toBe('tauri install failed')
    })

    it('should set skippedVersion and clear updateAvailable', async () => {
      useUpdaterStore.setState({ updateAvailable: true, version: '2.0.0' })

      await useUpdaterStore.getState().skipVersion('2.0.0')

      const state = useUpdaterStore.getState()
      expect(tauriVersionSkip.skipVersion).toHaveBeenCalledWith('2.0.0')
      expect(state.skippedVersion).toBe('2.0.0')
      expect(state.updateAvailable).toBe(false)
      expect(state.downloaded).toBe(false)
    })
  })

  describe('initialization and scheduling', () => {
    it('should hydrate updater state from Tauri', async () => {
      vi.mocked(tauriUpdaterApi.getUpdaterState).mockResolvedValue({
        success: true,
        data: {
          updateAvailable: true,
          downloaded: false,
          version: '2.0.0',
          isChecking: false,
          isDownloading: false,
          downloadProgress: null,
          error: null,
          lastChecked: '2026-01-01T00:00:00.000Z'
        }
      })

      await useUpdaterStore.getState().initializeUpdater({ autoCheck: false })

      const state = useUpdaterStore.getState()
      expect(tauriUpdaterApi.registerUpdateEventHandlers).toHaveBeenCalledTimes(1)
      expect(state.updateAvailable).toBe(true)
      expect(state.version).toBe('2.0.0')
      expect(state.lastChecked).toBeInstanceOf(Date)
    })

    it('should run startup auto-check after non-auto initialization if requested later', async () => {
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
    })

    it('should not retry when check pause is caused by active terminals', async () => {
      vi.useFakeTimers()
      vi.mocked(tauriSafeUpdate.hasActiveTerminalSessions).mockReturnValue(true)

      await useUpdaterStore.getState().runCheckWithRetry()

      expect(tauriUpdaterApi.checkForUpdates).not.toHaveBeenCalled()
      expect(useUpdaterStore.getState().error).toBe(
        'Update checks paused because active terminal sessions are running.'
      )

      vi.useRealTimers()
    })

    it('should not schedule periodic checks if updater is stopped during initialization', async () => {
      vi.useFakeTimers()

      const statePromise = new Promise<{ success: true; data: UpdateState }>((resolve) => {
        setTimeout(() => resolve({ success: true, data: INITIAL_UPDATER_STATE }), 0)
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
      vi.mocked(tauriUpdaterApi.getAutoUpdateEnabled).mockResolvedValue({
        success: true,
        data: false
      })

      await useUpdaterStore.getState().initializeUpdater({ autoCheck: false })
      expect(useUpdaterStore.getState().autoUpdateEnabled).toBe(false)

      await useUpdaterStore.getState().setAutoUpdateEnabled(true)

      expect(useUpdaterStore.getState().autoUpdateEnabled).toBe(true)
      expect(tauriUpdaterApi.checkForUpdates).toHaveBeenCalled()
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
  })
})
