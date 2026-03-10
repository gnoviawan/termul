import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  useContextBarSettings,
  useUpdateContextBarSetting
} from './use-context-bar-settings'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import {
  CONTEXT_BAR_SETTINGS_KEY,
  DEFAULT_CONTEXT_BAR_SETTINGS,
  type ContextBarSettings
} from '@/types/settings'

const { mockPersistenceRead, mockPersistenceWriteDebounced } = vi.hoisted(() => ({
  mockPersistenceRead: vi.fn(),
  mockPersistenceWriteDebounced: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: mockPersistenceRead,
    writeDebounced: mockPersistenceWriteDebounced
  }
}))

describe('useContextBarSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useContextBarSettingsStore.setState({
      settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS },
      isLoaded: false
    })

    mockPersistenceRead.mockResolvedValue({
      success: false,
      error: 'Key not found',
      code: 'KEY_NOT_FOUND'
    })
    mockPersistenceWriteDebounced.mockResolvedValue({ success: true, data: undefined })
  })

  it('restores persisted settings on startup', async () => {
    const persistedSettings: ContextBarSettings = {
      showGitBranch: false,
      showGitStatus: false,
      showWorkingDirectory: true,
      showExitCode: false
    }

    mockPersistenceRead.mockResolvedValue({ success: true, data: persistedSettings })

    renderHook(() => useContextBarSettings())

    await waitFor(() => {
      expect(useContextBarSettingsStore.getState().settings).toEqual(persistedSettings)
      expect(useContextBarSettingsStore.getState().isLoaded).toBe(true)
    })

    expect(mockPersistenceRead).toHaveBeenCalledWith(CONTEXT_BAR_SETTINGS_KEY)
  })

  it('keeps defaults when no persisted key exists', async () => {
    renderHook(() => useContextBarSettings())

    await waitFor(() => {
      expect(useContextBarSettingsStore.getState().settings).toEqual(
        DEFAULT_CONTEXT_BAR_SETTINGS
      )
      expect(useContextBarSettingsStore.getState().isLoaded).toBe(true)
    })
  })

  it('keeps defaults when loading settings throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockPersistenceRead.mockRejectedValue(new Error('read failed'))

    renderHook(() => useContextBarSettings())

    await waitFor(() => {
      expect(useContextBarSettingsStore.getState().settings).toEqual(
        DEFAULT_CONTEXT_BAR_SETTINGS
      )
      expect(useContextBarSettingsStore.getState().isLoaded).toBe(true)
    })

    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load context bar settings')
    consoleErrorSpy.mockRestore()
  })

  it('merges partial persisted settings with defaults', async () => {
    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        showGitBranch: false,
        showExitCode: false
      } as ContextBarSettings
    })

    renderHook(() => useContextBarSettings())

    await waitFor(() => {
      expect(useContextBarSettingsStore.getState().settings).toEqual({
        ...DEFAULT_CONTEXT_BAR_SETTINGS,
        showGitBranch: false,
        showExitCode: false
      })
    })
  })
})

describe('useUpdateContextBarSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useContextBarSettingsStore.setState({
      settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS },
      isLoaded: true
    })

    mockPersistenceWriteDebounced.mockResolvedValue({ success: true, data: undefined })
  })

  it('updates the selected setting and persists the latest full snapshot', async () => {
    const { result } = renderHook(() => useUpdateContextBarSetting())

    await act(async () => {
      await result.current('showGitStatus')
    })

    expect(useContextBarSettingsStore.getState().settings).toEqual({
      ...DEFAULT_CONTEXT_BAR_SETTINGS,
      showGitStatus: false
    })
    expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
      CONTEXT_BAR_SETTINGS_KEY,
      {
        ...DEFAULT_CONTEXT_BAR_SETTINGS,
        showGitStatus: false
      }
    )
  })
})
