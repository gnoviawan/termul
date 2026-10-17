import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { MONO_STACK } from '@/lib/font-stacks'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import {
  useAppearanceMode,
  useAppSettingsStore,
  useColorTheme,
  useTerminalScreenReaderMode,
  useTerminalUrlOpenMode
} from './app-settings-store'

describe('app-settings-store', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS },
      isLoaded: false
    })
  })

  describe('initial state', () => {
    it('should have default font family', () => {
      const { settings } = useAppSettingsStore.getState()
      // Stored default matches the bundled Paper Mono stack. The terminal
      // renders that stack and does not read a saved family.
      expect(settings.terminalFontFamily).toBe(MONO_STACK)
    })

    it('should have default font size of 14', () => {
      const { settings } = useAppSettingsStore.getState()
      expect(settings.terminalFontSize).toBe(14)
    })

    it('enables terminal idle notifications by default (GH-645)', () => {
      const { settings } = useAppSettingsStore.getState()
      expect(settings.notifyOnTerminalIdle).toBe(true)
    })

    it('enables agent chat notifications by default (issue #865)', () => {
      const { settings } = useAppSettingsStore.getState()
      expect(settings.notifyOnAgentChatTurnFinished).toBe(true)
      expect(settings.notifyOnAgentChatNeedsYou).toBe(true)
    })

    it('should have empty default shell (system default)', () => {
      const { settings } = useAppSettingsStore.getState()
      expect(settings.defaultShell).toBe('')
    })

    it('should have isLoaded as false initially', () => {
      const { isLoaded } = useAppSettingsStore.getState()
      expect(isLoaded).toBe(false)
    })

    it('should default terminal URL open mode to system', () => {
      const { settings } = useAppSettingsStore.getState()
      expect(settings.terminalUrlOpenMode).toBe('system')
    })
  })

  describe('updateSetting', () => {
    it('should update terminalFontFamily', () => {
      const { updateSetting } = useAppSettingsStore.getState()

      updateSetting('terminalFontFamily', 'Consolas, "Courier New", monospace')

      const { settings } = useAppSettingsStore.getState()
      expect(settings.terminalFontFamily).toBe('Consolas, "Courier New", monospace')
    })

    it('should update terminalFontSize', () => {
      const { updateSetting } = useAppSettingsStore.getState()

      updateSetting('terminalFontSize', 18)

      const { settings } = useAppSettingsStore.getState()
      expect(settings.terminalFontSize).toBe(18)
    })

    it('should update defaultShell', () => {
      const { updateSetting } = useAppSettingsStore.getState()

      updateSetting('defaultShell', 'powershell')

      const { settings } = useAppSettingsStore.getState()
      expect(settings.defaultShell).toBe('powershell')
    })

    it('should not affect other settings when updating one', () => {
      const { updateSetting } = useAppSettingsStore.getState()

      updateSetting('terminalFontSize', 20)

      const { settings } = useAppSettingsStore.getState()
      expect(settings.terminalFontSize).toBe(20)
      expect(settings.terminalFontFamily).toBe(MONO_STACK)
      expect(settings.defaultShell).toBe('')
    })

    it('should update terminalUrlOpenMode', () => {
      const { updateSetting } = useAppSettingsStore.getState()

      updateSetting('terminalUrlOpenMode', 'termul')

      const { settings } = useAppSettingsStore.getState()
      expect(settings.terminalUrlOpenMode).toBe('termul')
    })
  })

  describe('updateSettings', () => {
    it('should update multiple settings in one state change', () => {
      const { updateSettings } = useAppSettingsStore.getState()

      updateSettings({ colorTheme: 'dracula', appearanceMode: 'light' })

      const { settings } = useAppSettingsStore.getState()
      expect(settings.colorTheme).toBe('dracula')
      expect(settings.appearanceMode).toBe('light')
      expect(settings.terminalFontSize).toBe(DEFAULT_APP_SETTINGS.terminalFontSize)
    })
  })

  describe('setSettings', () => {
    it('should replace all settings and set isLoaded to true', () => {
      const newSettings = {
        terminalFontFamily: 'Monaco, Menlo, "Courier New", monospace',
        terminalFontSize: 16,
        defaultShell: 'bash',
        terminalBufferSize: 10000,
        terminalRenderer: 'auto' as const,
        defaultProjectColor: 'blue',
        confirmTerminalClose: true,
        terminalUrlOpenMode: 'termul' as const,
        remoteBindMode: 'localhost' as const,
        colorTheme: 'dracula',
        appearanceMode: 'dark' as const,
        uiZoomLevel: 1
      }

      const { setSettings } = useAppSettingsStore.getState()
      setSettings(newSettings)

      const { settings, isLoaded } = useAppSettingsStore.getState()
      expect(settings).toEqual(newSettings)
      expect(isLoaded).toBe(true)
    })
  })

  describe('resetToDefaults', () => {
    it('should reset all settings to defaults', () => {
      // First modify settings
      useAppSettingsStore.setState({
        settings: {
          terminalFontFamily: 'Fira Code',
          terminalFontSize: 20,
          defaultShell: 'zsh',
          terminalBufferSize: 5000,
          terminalRenderer: 'dom' as const,
          defaultProjectColor: 'red',
          confirmTerminalClose: false,
          terminalUrlOpenMode: 'termul',
          remoteBindMode: 'all' as const,
          colorTheme: 'nord',
          appearanceMode: 'light' as const,
          uiZoomLevel: 1.2
        },
        isLoaded: true
      })

      const { resetToDefaults } = useAppSettingsStore.getState()
      resetToDefaults()

      const { settings } = useAppSettingsStore.getState()
      expect(settings).toEqual(DEFAULT_APP_SETTINGS)
    })
  })

  describe('terminal screen reader mode (L-28)', () => {
    it('defaults to off', () => {
      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(false)
      expect(DEFAULT_APP_SETTINGS.terminalScreenReaderMode).toBe(false)

      const { result } = renderHook(() => useTerminalScreenReaderMode())
      expect(result.current).toBe(false)
    })

    it('selects true only after the setting is turned on', () => {
      const { result } = renderHook(() => useTerminalScreenReaderMode())
      expect(result.current).toBe(false)

      act(() => {
        useAppSettingsStore.getState().updateSetting('terminalScreenReaderMode', true)
      })
      expect(result.current).toBe(true)

      act(() => {
        useAppSettingsStore.getState().updateSetting('terminalScreenReaderMode', false)
      })
      expect(result.current).toBe(false)
    })

    it('treats a corrupt persisted value as off (strict true only)', () => {
      const { result } = renderHook(() => useTerminalScreenReaderMode())
      act(() => {
        useAppSettingsStore.setState((state) => ({
          settings: {
            ...state.settings,
            terminalScreenReaderMode: 'true' as unknown as boolean
          }
        }))
      })
      expect(result.current).toBe(false)
    })

    it('resetToDefaults returns it to false', () => {
      useAppSettingsStore.getState().updateSetting('terminalScreenReaderMode', true)
      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(true)

      useAppSettingsStore.getState().resetToDefaults()
      expect(useAppSettingsStore.getState().settings.terminalScreenReaderMode).toBe(false)
    })
  })

  describe('selectors', () => {
    it('useAppSettings should return settings object', () => {
      const settings = useAppSettingsStore.getState().settings
      expect(settings).toEqual(DEFAULT_APP_SETTINGS)
    })

    it('useTerminalUrlOpenMode should select the terminal URL mode', () => {
      useAppSettingsStore.setState((state) => ({
        ...state,
        settings: { ...state.settings, terminalUrlOpenMode: 'termul' }
      }))

      const { result } = renderHook(() => useTerminalUrlOpenMode())
      expect(result.current).toBe('termul')
    })

    it('useColorTheme should select the app color theme', () => {
      useAppSettingsStore.setState((state) => ({
        ...state,
        settings: { ...state.settings, colorTheme: 'dracula' }
      }))

      const { result } = renderHook(() => useColorTheme())
      expect(result.current).toBe('dracula')
    })

    it('useAppearanceMode should select the app appearance mode', () => {
      useAppSettingsStore.setState((state) => ({
        ...state,
        settings: { ...state.settings, appearanceMode: 'light' }
      }))

      const { result } = renderHook(() => useAppearanceMode())
      expect(result.current).toBe('light')
    })
  })
})
