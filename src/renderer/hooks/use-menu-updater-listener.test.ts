import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useMenuUpdaterListener } from './use-menu-updater-listener'
import { useUpdaterStore } from '@/stores/updater-store'

const mockInitializeUpdater = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()

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
    initializeUpdater: mockInitializeUpdater
  })
})

describe('useMenuUpdaterListener', () => {
  it('should initialize updater with autoCheck false on mount', async () => {
    renderHook(() => useMenuUpdaterListener())

    await waitFor(() => {
      expect(mockInitializeUpdater).toHaveBeenCalledWith({ autoCheck: false })
    })
  })

  it('should not throw on mount and unmount', () => {
    const { unmount } = renderHook(() => useMenuUpdaterListener())

    expect(() => unmount()).not.toThrow()
  })
})
