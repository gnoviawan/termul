import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMenuUpdaterListener } from './use-menu-updater-listener'
import { useUpdaterStore } from '@/stores/updater-store'

beforeEach(() => {
  vi.stubGlobal('electron', {
    ipcRenderer: {
      on: vi.fn(),
      removeListener: vi.fn()
    }
  })
  vi.stubGlobal('api', {
    updater: {
      checkForUpdates: vi.fn(() => Promise.resolve({ success: true, data: null })),
      getState: vi.fn(() => Promise.resolve({ success: true, data: {} })),
      getAutoUpdateEnabled: vi.fn(() => Promise.resolve({ success: true, data: true })),
      onUpdateAvailable: vi.fn(() => () => {}),
      onUpdateDownloaded: vi.fn(() => () => {}),
      onDownloadProgress: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {})
    }
  })
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

describe('useMenuUpdaterListener', () => {
  it('should register menu event listener on mount', () => {
    renderHook(() => useMenuUpdaterListener())

    expect(window.electron.ipcRenderer.on).toHaveBeenCalledWith(
      'updater:check-for-updates-triggered',
      expect.any(Function)
    )
  })

  it('should clean up listener on unmount', () => {
    const { unmount } = renderHook(() => useMenuUpdaterListener())
    unmount()

    expect(window.electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'updater:check-for-updates-triggered',
      expect.any(Function)
    )
  })

  it('should trigger checkForUpdates when menu event fires', () => {
    renderHook(() => useMenuUpdaterListener())

    // Get the registered listener
    const onCall = (window.electron.ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls
      .find((call: unknown[]) => call[0] === 'updater:check-for-updates-triggered')

    expect(onCall).toBeDefined()

    // Simulate menu event
    const listener = onCall![1]
    listener()

    // Verify checkForUpdates was called via store action
    expect(window.api.updater.checkForUpdates).toHaveBeenCalled()
  })
})
