import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS } from '@/types/settings'
import {
  useAppSettingsLoader,
  useResetAppSettings,
  useUpdateAppSetting,
  useUpdateAppSettings,
  useUpdatePanelVisibility
} from './use-app-settings'

const {
  mockPersistenceRead,
  mockPersistenceWrite,
  mockPersistenceWriteDebounced,
  mockSetTurnTimeout,
  mockSetTurnIdleTimeout,
  mockSetSessionNewTimeout,
  mockSetSessionReopenTimeout
} = vi.hoisted(() => ({
  mockPersistenceRead: vi.fn(),
  mockPersistenceWrite: vi.fn(),
  mockPersistenceWriteDebounced: vi.fn(),
  mockSetTurnTimeout: vi.fn(),
  mockSetTurnIdleTimeout: vi.fn(),
  mockSetSessionNewTimeout: vi.fn(),
  mockSetSessionReopenTimeout: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  acpApi: {
    setTurnTimeout: mockSetTurnTimeout,
    setTurnIdleTimeout: mockSetTurnIdleTimeout,
    setSessionNewTimeout: mockSetSessionNewTimeout,
    setSessionReopenTimeout: mockSetSessionReopenTimeout
  },
  persistenceApi: {
    read: mockPersistenceRead,
    write: mockPersistenceWrite,
    writeDebounced: mockPersistenceWriteDebounced
  }
}))

describe('use-app-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS },
      isLoaded: false
    })
    resetShellLayoutStoreForTests()
    useShellLayoutStore.setState({ status: 'ready' })

    mockPersistenceRead.mockResolvedValue({ success: true, data: null })
    mockPersistenceWrite.mockResolvedValue({ success: true, data: undefined })
    mockPersistenceWriteDebounced.mockResolvedValue({ success: true, data: undefined })
    mockSetTurnTimeout.mockResolvedValue(undefined)
    mockSetTurnIdleTimeout.mockResolvedValue(undefined)
    mockSetSessionNewTimeout.mockResolvedValue(undefined)
    mockSetSessionReopenTimeout.mockResolvedValue(undefined)
  })

  it('does not push legacy AppSettings panel visibility into the shell layout on load', async () => {
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: {
        ...DEFAULT_APP_SETTINGS,
        sidebarVisible: true,
        fileExplorerVisible: true,
        sshPanelVisible: true
      }
    })
    // An upgraded user: the shell-layout migration already collapsed the rail.
    useShellLayoutStore.setState({
      status: 'ready',
      railExpanded: false,
      sidePanelVisible: false,
      sshSectionVisible: false
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(useAppSettingsStore.getState().isLoaded).toBe(true)
    })
    const layout = useShellLayoutStore.getState()
    expect(layout.railExpanded).toBe(false)
    expect(layout.sidePanelVisible).toBe(false)
    expect(layout.sshSectionVisible).toBe(false)
  })

  it('pushes the ACP timeout overrides to the backend on load', async () => {
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: {
        ...DEFAULT_APP_SETTINGS,
        acpTurnTimeoutSecs: 7200,
        acpTurnIdleTimeoutSecs: 1800,
        acpSessionNewTimeoutSecs: 120,
        acpSessionReopenTimeoutSecs: 300,
        // Stale key from an old settings blob (story 8 removed the warmup
        // machinery): the merge keeps it inert — nothing reads or pushes it.
        acpFirstPromptWarmupSecs: 0
      }
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(useAppSettingsStore.getState().isLoaded).toBe(true)
      expect(mockSetTurnTimeout).toHaveBeenCalledWith(7200)
      expect(mockSetTurnIdleTimeout).toHaveBeenCalledWith(1800)
      expect(mockSetSessionNewTimeout).toHaveBeenCalledWith(120)
      expect(mockSetSessionReopenTimeout).toHaveBeenCalledWith(300)
    })
  })

  it('defaults agent chat notification switches when persisted settings omit them', async () => {
    const {
      notifyOnAgentChatTurnFinished: _turn,
      notifyOnAgentChatNeedsYou: _needs,
      ...legacySettings
    } = DEFAULT_APP_SETTINGS
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: legacySettings
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(useAppSettingsStore.getState().isLoaded).toBe(true)
      expect(useAppSettingsStore.getState().settings.notifyOnAgentChatTurnFinished).toBe(true)
      expect(useAppSettingsStore.getState().settings.notifyOnAgentChatNeedsYou).toBe(true)
    })
  })

  it('defaults terminal URL open mode when persisted settings are missing the key', async () => {
    const { terminalUrlOpenMode: _terminalUrlOpenMode, ...legacySettings } = DEFAULT_APP_SETTINGS
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: legacySettings
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(useAppSettingsStore.getState().isLoaded).toBe(true)
      expect(useAppSettingsStore.getState().settings.terminalUrlOpenMode).toBe('system')
    })
  })

  it('loads an old persisted per-project terminal limit and drops the retired key', async () => {
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: { ...DEFAULT_APP_SETTINGS, maxTerminalsPerProject: 5 }
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(useAppSettingsStore.getState().isLoaded).toBe(true)
    })
    expect(useAppSettingsStore.getState().settings).toEqual(DEFAULT_APP_SETTINGS)
    expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
      APP_SETTINGS_KEY,
      DEFAULT_APP_SETTINGS
    )
  })

  it('loads old persisted orphan-detection keys and drops them', async () => {
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: {
        ...DEFAULT_APP_SETTINGS,
        orphanDetectionEnabled: false,
        orphanDetectionTimeout: 60000
      }
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(useAppSettingsStore.getState().isLoaded).toBe(true)
    })
    expect(useAppSettingsStore.getState().settings).toEqual(DEFAULT_APP_SETTINGS)
    expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
      APP_SETTINGS_KEY,
      DEFAULT_APP_SETTINGS
    )
  })

  it('persists normalized legacy light color theme settings', async () => {
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: {
        ...DEFAULT_APP_SETTINGS,
        colorTheme: 'termul-light',
        appearanceMode: undefined
      }
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
        APP_SETTINGS_KEY,
        expect.objectContaining({ colorTheme: 'termul', appearanceMode: 'light' })
      )
    })
  })

  it('persists missing appearance mode defaults', async () => {
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: {
        ...DEFAULT_APP_SETTINGS,
        appearanceMode: undefined
      }
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
        APP_SETTINGS_KEY,
        expect.objectContaining({ appearanceMode: 'dark' })
      )
    })
  })

  it('persists terminal renderer migration from canvas to dom', async () => {
    mockPersistenceRead.mockResolvedValueOnce({
      success: true,
      data: {
        ...DEFAULT_APP_SETTINGS,
        terminalRenderer: 'canvas'
      }
    })

    renderHook(() => useAppSettingsLoader())

    await waitFor(() => {
      expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
        APP_SETTINGS_KEY,
        expect.objectContaining({ terminalRenderer: 'dom' })
      )
    })
  })

  it('dispatches panel visibility to the shell-layout actions without touching AppSettings', async () => {
    const { result } = renderHook(() => useUpdatePanelVisibility())

    await result.current('sidebarVisible', false)
    await result.current('fileExplorerVisible', false)
    await result.current('sshPanelVisible', false)

    const layout = useShellLayoutStore.getState()
    expect(layout.railExpanded).toBe(false)
    expect(layout.sidePanelVisible).toBe(false)
    expect(layout.sshSectionVisible).toBe(false)
    expect(useAppSettingsStore.getState().settings).toEqual(DEFAULT_APP_SETTINGS)
    expect(mockPersistenceWrite).not.toHaveBeenCalledWith(APP_SETTINGS_KEY, expect.anything())
    expect(mockPersistenceWriteDebounced).not.toHaveBeenCalledWith(
      APP_SETTINGS_KEY,
      expect.anything()
    )
    // The shell-layout store persists through its own key (debounced).
    expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
      'shell-layout',
      expect.objectContaining({ railExpanded: false, sidePanelVisible: false })
    )
  })

  it('ignores panel visibility changes until the shell layout is hydrated', async () => {
    resetShellLayoutStoreForTests()
    const { result } = renderHook(() => useUpdatePanelVisibility())

    await expect(result.current('sidebarVisible', false)).resolves.toBeUndefined()

    expect(useShellLayoutStore.getState().railExpanded).toBe(true)
    expect(mockPersistenceWriteDebounced).not.toHaveBeenCalled()
  })

  it('applies panel visibility in memory only when the shell layout is unavailable', async () => {
    useShellLayoutStore.setState({ status: 'unavailable' })
    const { result } = renderHook(() => useUpdatePanelVisibility())

    await result.current('fileExplorerVisible', false)

    expect(useShellLayoutStore.getState().sidePanelVisible).toBe(false)
    expect(mockPersistenceWriteDebounced).not.toHaveBeenCalled()
    expect(mockPersistenceWrite).not.toHaveBeenCalled()
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

  describe('retired shell layout flag and legacy panel fields', () => {
    it('ignores a stored shellLayout and keeps legacy panel fields in the persisted record', async () => {
      const persisted = {
        ...DEFAULT_APP_SETTINGS,
        shellLayout: 'classic',
        sidebarVisible: false,
        fileExplorerVisible: false,
        sshPanelVisible: false
      }
      mockPersistenceRead.mockResolvedValueOnce({ success: true, data: persisted })

      renderHook(() => useAppSettingsLoader())

      await waitFor(() => {
        expect(useAppSettingsStore.getState().isLoaded).toBe(true)
      })
      // The loader still merges over the defaults, so raw legacy values survive
      // in memory until the shell-layout migration has read them.
      expect(useAppSettingsStore.getState().settings).toEqual(persisted)
      expect('shellLayout' in DEFAULT_APP_SETTINGS).toBe(false)
      expect('sidebarVisible' in DEFAULT_APP_SETTINGS).toBe(false)
    })

    it('loads without error when no record exists', async () => {
      mockPersistenceRead.mockResolvedValueOnce({ success: false, code: 'KEY_NOT_FOUND' })

      renderHook(() => useAppSettingsLoader())

      await waitFor(() => {
        expect(useAppSettingsStore.getState().isLoaded).toBe(true)
      })
      expect(useAppSettingsStore.getState().settings).toEqual(DEFAULT_APP_SETTINGS)
    })
  })

  describe('terminal screen reader mode (L-28)', () => {
    it('loads as false when the persisted blob lacks the key', async () => {
      const { terminalScreenReaderMode: _screenReader, ...legacySettings } = DEFAULT_APP_SETTINGS
      mockPersistenceRead.mockResolvedValueOnce({ success: true, data: legacySettings })

      renderHook(() => useAppSettingsLoader())

      await waitFor(() => {
        expect(useAppSettingsStore.getState().isLoaded).toBe(true)
      })
      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(false)
    })

    it('loads a persisted true as true', async () => {
      mockPersistenceRead.mockResolvedValueOnce({
        success: true,
        data: { ...DEFAULT_APP_SETTINGS, terminalScreenReaderMode: true }
      })

      renderHook(() => useAppSettingsLoader())

      await waitFor(() => {
        expect(useAppSettingsStore.getState().isLoaded).toBe(true)
      })
      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(true)
    })

    it('writes the whole blob through the shared persistence facade when turned on', async () => {
      const { result } = renderHook(() => useUpdateAppSetting())

      await result.current('terminalScreenReaderMode', true)

      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(true)
      expect(mockPersistenceWriteDebounced).toHaveBeenCalledTimes(1)
      // The whole settings object, not a patch: every other key rides along.
      expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(APP_SETTINGS_KEY, {
        ...DEFAULT_APP_SETTINGS,
        terminalScreenReaderMode: true
      })
      expect(mockPersistenceWrite).not.toHaveBeenCalled()
    })

    it('persists false again when Reset Settings runs', async () => {
      useAppSettingsStore.setState({
        settings: { ...DEFAULT_APP_SETTINGS, terminalScreenReaderMode: true },
        isLoaded: true
      })

      const { result } = renderHook(() => useResetAppSettings())

      await result.current()

      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(false)
      expect(mockPersistenceWrite).toHaveBeenCalledWith(
        APP_SETTINGS_KEY,
        expect.objectContaining({ terminalScreenReaderMode: false })
      )
    })
  })

  it('writes one snapshot when updating multiple app settings', async () => {
    const { result } = renderHook(() => useUpdateAppSettings())

    await result.current({ colorTheme: 'dracula', appearanceMode: 'light' })

    expect(useAppSettingsStore.getState().settings.colorTheme).toBe('dracula')
    expect(useAppSettingsStore.getState().settings.appearanceMode).toBe('light')
    expect(mockPersistenceWriteDebounced).toHaveBeenCalledTimes(1)
    expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
      APP_SETTINGS_KEY,
      expect.objectContaining({ colorTheme: 'dracula', appearanceMode: 'light' })
    )
  })

  it('reopens all panels through the shell-layout actions when app settings are reset', async () => {
    useShellLayoutStore.setState({
      railExpanded: false,
      sidePanelVisible: false,
      sshSectionVisible: false
    })

    const { result } = renderHook(() => useResetAppSettings())

    await result.current()

    const layout = useShellLayoutStore.getState()
    expect(layout.railExpanded).toBe(true)
    expect(layout.sidePanelVisible).toBe(true)
    expect(layout.sshSectionVisible).toBe(true)
    expect(mockPersistenceWrite).toHaveBeenCalledWith(APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS)
  })

  it('clears all ACP timeout overrides in the backend when app settings are reset', async () => {
    useAppSettingsStore.setState({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        acpTurnTimeoutSecs: 7200,
        acpTurnIdleTimeoutSecs: 1800,
        acpSessionNewTimeoutSecs: 120,
        acpSessionReopenTimeoutSecs: 300
      },
      isLoaded: true
    })

    const { result } = renderHook(() => useResetAppSettings())

    await result.current()

    expect(mockSetTurnTimeout).toHaveBeenCalledWith(null)
    expect(mockSetTurnIdleTimeout).toHaveBeenCalledWith(null)
    expect(mockSetSessionNewTimeout).toHaveBeenCalledWith(null)
    expect(mockSetSessionReopenTimeout).toHaveBeenCalledWith(null)
  })
})
