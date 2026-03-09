import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { IpcResult } from '@shared/types/ipc.types'
import {
  useAppSettingsLoader,
  useResetAppSettings,
  useUpdateAppSetting,
  useUpdatePanelVisibility,
  waitForPendingAppSettingsPersistence,
  resetAppSettingsPersistenceQueueForTests
} from './use-app-settings'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useSidebarStore } from '@/stores/sidebar-store'
import { APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS } from '@/types/settings'

const { mockPersistenceRead, mockPersistenceWrite, mockPersistenceWriteDebounced, mockUpdateOrphanDetection } = vi.hoisted(() => ({
  mockPersistenceRead: vi.fn(),
  mockPersistenceWrite: vi.fn(),
  mockPersistenceWriteDebounced: vi.fn(),
  mockUpdateOrphanDetection: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: mockPersistenceRead,
    write: mockPersistenceWrite,
    writeDebounced: mockPersistenceWriteDebounced
  },
  terminalApi: {
    updateOrphanDetection: mockUpdateOrphanDetection
  }
}))

describe('use-app-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAppSettingsPersistenceQueueForTests()

    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS },
      isLoaded: false
    })
    useSidebarStore.setState({ isVisible: true })
    useFileExplorerStore.setState({ isVisible: true })

    mockPersistenceRead.mockResolvedValue({ success: true, data: null })
    mockPersistenceWrite.mockResolvedValue({ success: true, data: undefined })
    mockPersistenceWriteDebounced.mockResolvedValue({ success: true, data: undefined })
    mockUpdateOrphanDetection.mockResolvedValue({ success: true, data: undefined })
  })

  it('hydrates sidebar and file explorer visibility from persisted app settings', async () => {
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: {
        ...DEFAULT_APP_SETTINGS,
        sidebarVisible: false,
        fileExplorerVisible: true
      }
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(useAppSettingsStore.getState().isLoaded).toBe(true)
      expect(useSidebarStore.getState().isVisible).toBe(false)
      expect(useFileExplorerStore.getState().isVisible).toBe(true)
    })
  })

  it('updates panel visibility with immediate persistence write', async () => {
    const { result } = renderHook(() => useUpdatePanelVisibility())

    await result.current('sidebarVisible', false)

    expect(useAppSettingsStore.getState().settings.sidebarVisible).toBe(false)
    expect(useSidebarStore.getState().isVisible).toBe(false)
    expect(mockPersistenceWrite).toHaveBeenCalledWith(
      APP_SETTINGS_KEY,
      expect.objectContaining({ sidebarVisible: false })
    )
    expect(mockPersistenceWriteDebounced).not.toHaveBeenCalled()
  })

  it('serializes rapid panel writes and keeps last state', async () => {
    const deferredResolvers: Array<(result: IpcResult<void>) => void> = []
    mockPersistenceWrite.mockImplementation(
      () =>
        new Promise<IpcResult<void>>((resolve) => {
          deferredResolvers.push(resolve)
        })
    )

    const { result } = renderHook(() => useUpdatePanelVisibility())

    const first = result.current('sidebarVisible', false)
    const second = result.current('sidebarVisible', true)

    await waitFor(() => {
      expect(mockPersistenceWrite).toHaveBeenCalledTimes(1)
    })

    deferredResolvers[0]?.({ success: true, data: undefined })
    await first

    await waitFor(() => {
      expect(mockPersistenceWrite).toHaveBeenCalledTimes(2)
    })

    deferredResolvers[1]?.({ success: true, data: undefined })
    await second

    expect(useAppSettingsStore.getState().settings.sidebarVisible).toBe(true)
    expect(useSidebarStore.getState().isVisible).toBe(true)
  })

  it('reverts panel visibility in stores when immediate persistence fails', async () => {
    mockPersistenceWrite.mockResolvedValueOnce({
      success: false,
      error: 'write failed',
      code: 'WRITE_FAILED'
    })

    const { result } = renderHook(() => useUpdatePanelVisibility())

    let thrown: unknown
    try {
      await result.current('sidebarVisible', false)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('write failed')
    expect(useAppSettingsStore.getState().settings.sidebarVisible).toBe(true)
    expect(useSidebarStore.getState().isVisible).toBe(true)
  })

  it('keeps newer panel value when older queued write fails', async () => {
    mockPersistenceWrite
      .mockResolvedValueOnce({ success: false, error: 'first failed', code: 'WRITE_FAILED' })
      .mockResolvedValueOnce({ success: true, data: undefined })

    const { result } = renderHook(() => useUpdatePanelVisibility())

    let firstError: unknown
    const first = result.current('fileExplorerVisible', false).catch((error) => {
      firstError = error
    })
    const second = result.current('fileExplorerVisible', true)

    await first
    await second

    expect(firstError).toBeInstanceOf(Error)
    expect((firstError as Error).message).toBe('first failed')

    expect(useAppSettingsStore.getState().settings.fileExplorerVisible).toBe(true)
    expect(useFileExplorerStore.getState().isVisible).toBe(true)
  })

  it('keeps debounced writes for non-panel app settings', async () => {
    const { result } = renderHook(() => useUpdateAppSetting())

    await result.current('terminalFontSize', 16)

    expect(useAppSettingsStore.getState().settings.terminalFontSize).toBe(16)
    expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
      APP_SETTINGS_KEY,
      expect.objectContaining({ terminalFontSize: 16 })
    )
  })

  it('resets panel stores when app settings are reset', async () => {
    useSidebarStore.setState({ isVisible: false })
    useFileExplorerStore.setState({ isVisible: false })

    const { result } = renderHook(() => useResetAppSettings())

    await result.current()

    expect(useSidebarStore.getState().isVisible).toBe(DEFAULT_APP_SETTINGS.sidebarVisible)
    expect(useFileExplorerStore.getState().isVisible).toBe(
      DEFAULT_APP_SETTINGS.fileExplorerVisible
    )
    expect(mockPersistenceWrite).toHaveBeenCalledWith(APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS)
  })

  it('waits for queued panel writes before close-flow synchronization', async () => {
    let resolveWrite: ((result: IpcResult<void>) => void) | undefined
    mockPersistenceWrite.mockImplementationOnce(
      () =>
        new Promise<IpcResult<void>>((resolve) => {
          resolveWrite = resolve
        })
    )

    const { result } = renderHook(() => useUpdatePanelVisibility())
    const pendingWrite = result.current('sidebarVisible', false)

    const waiter = waitForPendingAppSettingsPersistence()

    let waiterResolved = false
    void waiter.then(() => {
      waiterResolved = true
    })

    await Promise.resolve()
    expect(waiterResolved).toBe(false)

    resolveWrite?.({ success: true, data: undefined })
    await pendingWrite
    await waiter

    expect(waiterResolved).toBe(true)
  })
})
