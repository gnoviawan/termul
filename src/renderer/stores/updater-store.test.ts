import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUpdaterStore } from './updater-store'
import type { UpdateInfo, DownloadProgress, UpdateState } from '@shared/types/updater.types'

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
  vi.stubGlobal('api', { updater: mockUpdaterApi })
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
    autoUpdateEnabled: true
  })
  vi.clearAllMocks()
})

describe('updater-store', () => {
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
