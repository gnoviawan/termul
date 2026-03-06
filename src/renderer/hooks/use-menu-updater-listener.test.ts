import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useMenuUpdaterListener } from './use-menu-updater-listener'
import { useUpdaterStore } from '@/stores/updater-store'
import { listen } from '@tauri-apps/api/event'
import { cleanupTauriListener, isTauriContext } from '@/lib/tauri-runtime'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

vi.mock('@/lib/tauri-runtime', () => ({
  cleanupTauriListener: vi.fn(),
  isTauriContext: vi.fn()
}))

const mockInitializeUpdater = vi.fn(async () => {})
const mockCheckForUpdates = vi.fn(async () => {})
const mockUnlisten = vi.fn()

let menuCallback: (() => void) | undefined

beforeEach(() => {
  vi.clearAllMocks()
  menuCallback = undefined

  vi.mocked(isTauriContext).mockReturnValue(true)
  vi.mocked(listen).mockImplementation(async (_event, callback) => {
    menuCallback = callback as () => void
    return mockUnlisten
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
    autoUpdateEnabled: true,
    releaseNotes: null,
    hasActiveTerminals: false,
    initializeUpdater: mockInitializeUpdater,
    checkForUpdates: mockCheckForUpdates
  })
})

describe('useMenuUpdaterListener', () => {
  it('should initialize updater with autoCheck false on mount', async () => {
    renderHook(() => useMenuUpdaterListener())

    await waitFor(() => {
      expect(mockInitializeUpdater).toHaveBeenCalledWith({ autoCheck: false })
    })
  })

  it('should listen for Tauri menu events and trigger manual update checks', async () => {
    renderHook(() => useMenuUpdaterListener())

    await waitFor(() => {
      expect(listen).toHaveBeenCalledWith(
        'updater:check-for-updates-triggered',
        expect.any(Function)
      )
    })

    menuCallback?.()

    await waitFor(() => {
      expect(mockCheckForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  it('should clean up the Tauri menu listener on unmount', async () => {
    const { unmount } = renderHook(() => useMenuUpdaterListener())

    await waitFor(() => {
      expect(listen).toHaveBeenCalled()
    })

    unmount()

    expect(cleanupTauriListener).toHaveBeenCalledTimes(1)
  })

  it('should skip listener registration outside Tauri runtime', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)

    renderHook(() => useMenuUpdaterListener())

    await waitFor(() => {
      expect(mockInitializeUpdater).toHaveBeenCalledWith({ autoCheck: false })
    })

    expect(listen).not.toHaveBeenCalled()
  })

  it('should not throw on mount and unmount', () => {
    const { unmount } = renderHook(() => useMenuUpdaterListener())

    expect(() => unmount()).not.toThrow()
  })
})
