import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMenuUpdaterListener } from './use-menu-updater-listener'
import { useUpdaterStore } from '@/stores/updater-store'

// Spy on console.debug to verify the no-op behavior
const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

beforeEach(() => {
  vi.clearAllMocks()
  consoleDebugSpy.mockClear()

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
})

describe('useMenuUpdaterListener (Tauri POC)', () => {
  it('should log debug message on mount (no-op implementation)', () => {
    renderHook(() => useMenuUpdaterListener())

    expect(consoleDebugSpy).toHaveBeenCalledWith(
      '[MenuUpdater] Menu updater listener not implemented in Tauri POC'
    )
  })

  it('should not throw error on mount', () => {
    expect(() => {
      renderHook(() => useMenuUpdaterListener())
    }).not.toThrow()
  })

  it('should cleanup without errors on unmount', () => {
    const { unmount } = renderHook(() => useMenuUpdaterListener())

    expect(() => {
      unmount()
    }).not.toThrow()
  })

  it('should not interact with window.electron (Electron API not used)', () => {
    renderHook(() => useMenuUpdaterListener())

    // In Tauri implementation, window.electron should not be accessed
    expect((window as any).electron).toBeUndefined()
  })

  it('should work even without window.api defined', () => {
    // Ensure window.api is not defined
    delete (window as any).api

    expect(() => {
      renderHook(() => useMenuUpdaterListener())
    }).not.toThrow()
  })
})
