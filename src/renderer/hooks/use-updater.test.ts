import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useUpdateCheck } from './use-updater'
import { useUpdaterStore } from '@/stores/updater-store'

const mockCheckForUpdates = vi.fn(async () => {})
const mockInitializeUpdater = vi.fn(async () => {})
const mockStopPeriodicChecks = vi.fn(() => {})

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
    checkForUpdates: mockCheckForUpdates,
    initializeUpdater: mockInitializeUpdater,
    stopPeriodicChecks: mockStopPeriodicChecks
  })
})

describe('useUpdateCheck', () => {
  it('should initialize updater with autoCheck true by default', async () => {
    renderHook(() => useUpdateCheck())

    await waitFor(() => {
      expect(mockInitializeUpdater).toHaveBeenCalledWith({ autoCheck: true })
    })
  })

  it('should initialize updater with provided autoCheck value', async () => {
    renderHook(() => useUpdateCheck(false))

    await waitFor(() => {
      expect(mockInitializeUpdater).toHaveBeenCalledWith({ autoCheck: false })
    })
  })

  it('should stop periodic checks on unmount', async () => {
    const { unmount } = renderHook(() => useUpdateCheck(false))

    await waitFor(() => {
      expect(mockInitializeUpdater).toHaveBeenCalledTimes(1)
    })

    unmount()

    expect(mockStopPeriodicChecks).toHaveBeenCalledTimes(1)
  })

  it('should call checkForUpdates when check action is invoked', () => {
    const { result } = renderHook(() => useUpdateCheck(false))

    act(() => {
      result.current.check()
    })

    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1)
  })

  it('should return empty version string when version is null', () => {
    const { result } = renderHook(() => useUpdateCheck(false))

    expect(result.current.version).toBe('')
  })

  it('should expose updater state values from store', () => {
    useUpdaterStore.setState({
      updateAvailable: true,
      version: '2.0.0',
      isChecking: true,
      error: 'network error'
    })

    const { result } = renderHook(() => useUpdateCheck(false))

    expect(result.current.updateAvailable).toBe(true)
    expect(result.current.version).toBe('2.0.0')
    expect(result.current.isChecking).toBe(true)
    expect(result.current.error).toBe('network error')
  })
})
