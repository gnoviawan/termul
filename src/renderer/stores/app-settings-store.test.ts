import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { useAppSettingsStore, useTerminalUrlOpenMode } from './app-settings-store'

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
      expect(settings.terminalFontFamily).toBe('Menlo, Monaco, "Courier New", monospace')
    })

    it('should have default font size of 14', () => {
      const { settings } = useAppSettingsStore.getState()
      expect(settings.terminalFontSize).toBe(14)
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
      expect(settings.terminalFontFamily).toBe('Menlo, Monaco, "Courier New", monospace')
      expect(settings.defaultShell).toBe('')
    })

    it('should update terminalUrlOpenMode', () => {
      const { updateSetting } = useAppSettingsStore.getState()

      updateSetting('terminalUrlOpenMode', 'termul')

      const { settings } = useAppSettingsStore.getState()
      expect(settings.terminalUrlOpenMode).toBe('termul')
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
        maxTerminalsPerProject: 10,
        orphanDetectionEnabled: true,
        orphanDetectionTimeout: 600000,
        confirmTerminalClose: true,
        terminalUrlOpenMode: 'termul' as const,
        sidebarVisible: false,
        fileExplorerVisible: true,
        sshPanelVisible: true,
        remoteBindMode: 'localhost' as const
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
          maxTerminalsPerProject: 5,
          orphanDetectionEnabled: false,
          orphanDetectionTimeout: 300000,
          confirmTerminalClose: false,
          terminalUrlOpenMode: 'termul',
          sidebarVisible: false,
          fileExplorerVisible: false,
          sshPanelVisible: false,
          remoteBindMode: 'all' as const
        },
        isLoaded: true
      })

      const { resetToDefaults } = useAppSettingsStore.getState()
      resetToDefaults()

      const { settings } = useAppSettingsStore.getState()
      expect(settings).toEqual(DEFAULT_APP_SETTINGS)
    })
  })

  describe('panel visibility settings', () => {
    it('should default sidebar and file explorer visibility to true', () => {
      const { settings } = useAppSettingsStore.getState()
      expect(settings.sidebarVisible).toBe(true)
      expect(settings.fileExplorerVisible).toBe(true)
    })

    it('should update sidebar visibility setting', () => {
      const { updateSetting } = useAppSettingsStore.getState()
      updateSetting('sidebarVisible', false)
      const { settings } = useAppSettingsStore.getState()
      expect(settings.sidebarVisible).toBe(false)
    })

    it('should update file explorer visibility setting', () => {
      const { updateSetting } = useAppSettingsStore.getState()
      updateSetting('fileExplorerVisible', false)
      const { settings } = useAppSettingsStore.getState()
      expect(settings.fileExplorerVisible).toBe(false)
    })
  })

  describe('orphan detection settings', () => {
    it('should have correct default values', () => {
      const { settings } = useAppSettingsStore.getState()
      expect(settings.orphanDetectionEnabled).toBe(true)
      expect(settings.orphanDetectionTimeout).toBe(600000)
    })

    it('should update orphanDetectionEnabled', () => {
      const { updateSetting } = useAppSettingsStore.getState()
      updateSetting('orphanDetectionEnabled', false)
      const { settings } = useAppSettingsStore.getState()
      expect(settings.orphanDetectionEnabled).toBe(false)
    })

    it('should update orphanDetectionTimeout', () => {
      const { updateSetting } = useAppSettingsStore.getState()
      updateSetting('orphanDetectionTimeout', 300000)
      const { settings } = useAppSettingsStore.getState()
      expect(settings.orphanDetectionTimeout).toBe(300000)
    })

    it('should update orphanDetectionTimeout to null', () => {
      const { updateSetting } = useAppSettingsStore.getState()
      updateSetting('orphanDetectionTimeout', null)
      const { settings } = useAppSettingsStore.getState()
      expect(settings.orphanDetectionTimeout).toBe(null)
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
  })
})
