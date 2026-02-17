import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useUpdateCheck } from './use-updater'
import { useUpdaterStore } from '@/stores/updater-store'

// Mock window.api.updater
const mockUpdaterApi = {
  checkForUpdates: vi.fn(() => Promise.resolve({ success: true, data: null })),
  downloadUpdate: vi.fn(),
  installAndRestart: vi.fn(),
  skipVersion: vi.fn(),
  getState: vi.fn(() => Promise.resolve({
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
  })),
  setAutoUpdateEnabled: vi.fn(),
  getAutoUpdateEnabled: vi.fn(() => Promise.resolve({ success: true, data: true })),
  onUpdateAvailable: vi.fn(() => () => {}),
  onUpdateDownloaded: vi.fn(() => () => {}),
  onDownloadProgress: vi.fn(() => () => {}),
  onError: vi.fn(() => () => {})
}

beforeEach(() => {
  vi.stubGlobal('api', { updater: mockUpdaterApi })
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useUpdateCheck', () => {
  it('should register IPC event listeners on mount', () => {
    renderHook(() => useUpdateCheck(false))

    expect(mockUpdaterApi.onUpdateAvailable).toHaveBeenCalledTimes(1)
    expect(mockUpdaterApi.onUpdateDownloaded).toHaveBeenCalledTimes(1)
    expect(mockUpdaterApi.onDownloadProgress).toHaveBeenCalledTimes(1)
    expect(mockUpdaterApi.onError).toHaveBeenCalledTimes(1)
  })

  it('should initialize state from main process', async () => {
    renderHook(() => useUpdateCheck(false))

    await waitFor(() => {
      expect(mockUpdaterApi.getState).toHaveBeenCalled()
    })
  })

  it('should auto-check when autoCheck is true', async () => {
    renderHook(() => useUpdateCheck(true))

    await waitFor(() => {
      expect(mockUpdaterApi.checkForUpdates).toHaveBeenCalled()
    })
  })

  it('should not auto-check when autoCheck is false', async () => {
    renderHook(() => useUpdateCheck(false))

    // Wait for initialization to complete
    await waitFor(() => {
      expect(mockUpdaterApi.getState).toHaveBeenCalled()
    })

    // checkForUpdates should not be called automatically
    expect(mockUpdaterApi.checkForUpdates).not.toHaveBeenCalled()
  })

  it('should clean up event listeners on unmount', () => {
    const cleanupAvailable = vi.fn()
    const cleanupDownloaded = vi.fn()
    const cleanupProgress = vi.fn()
    const cleanupError = vi.fn()

    mockUpdaterApi.onUpdateAvailable.mockReturnValue(cleanupAvailable)
    mockUpdaterApi.onUpdateDownloaded.mockReturnValue(cleanupDownloaded)
    mockUpdaterApi.onDownloadProgress.mockReturnValue(cleanupProgress)
    mockUpdaterApi.onError.mockReturnValue(cleanupError)

    const { unmount } = renderHook(() => useUpdateCheck(false))
    unmount()

    expect(cleanupAvailable).toHaveBeenCalled()
    expect(cleanupDownloaded).toHaveBeenCalled()
    expect(cleanupProgress).toHaveBeenCalled()
    expect(cleanupError).toHaveBeenCalled()
  })
})
