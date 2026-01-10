import { describe, it, expect, beforeEach } from 'vitest'
import { useAppSettingsStore } from './app-settings-store'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'

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
  })

  describe('setSettings', () => {
    it('should replace all settings and set isLoaded to true', () => {
      const newSettings = {
        terminalFontFamily: 'Monaco, Menlo, "Courier New", monospace',
        terminalFontSize: 16,
        defaultShell: 'bash',
        terminalBufferSize: 10000,
        defaultProjectColor: 'blue',
        maxTerminalsPerProject: 10
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
          defaultProjectColor: 'red',
          maxTerminalsPerProject: 5
        },
        isLoaded: true
      })

      const { resetToDefaults } = useAppSettingsStore.getState()
      resetToDefaults()

      const { settings } = useAppSettingsStore.getState()
      expect(settings).toEqual(DEFAULT_APP_SETTINGS)
    })
  })

  describe('selectors', () => {
    it('useAppSettings should return settings object', () => {
      const settings = useAppSettingsStore.getState().settings
      expect(settings).toEqual(DEFAULT_APP_SETTINGS)
    })
  })
})
