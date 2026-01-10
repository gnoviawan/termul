import { describe, it, expect, beforeEach } from 'vitest'
import { useContextBarSettingsStore } from './context-bar-settings-store'
import { DEFAULT_CONTEXT_BAR_SETTINGS } from '@/types/settings'

describe('context-bar-settings-store', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useContextBarSettingsStore.setState({
      settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS },
      isLoaded: false
    })
  })

  describe('initial state', () => {
    it('should have all elements visible by default', () => {
      const { settings } = useContextBarSettingsStore.getState()

      expect(settings.showGitBranch).toBe(true)
      expect(settings.showGitStatus).toBe(true)
      expect(settings.showWorkingDirectory).toBe(true)
      expect(settings.showExitCode).toBe(true)
    })

    it('should have isLoaded as false initially', () => {
      const { isLoaded } = useContextBarSettingsStore.getState()
      expect(isLoaded).toBe(false)
    })
  })

  describe('toggleElement', () => {
    it('should toggle showGitBranch from true to false', () => {
      const { toggleElement } = useContextBarSettingsStore.getState()

      toggleElement('showGitBranch')

      const { settings } = useContextBarSettingsStore.getState()
      expect(settings.showGitBranch).toBe(false)
    })

    it('should toggle showGitBranch from false to true', () => {
      useContextBarSettingsStore.setState({
        settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS, showGitBranch: false }
      })

      const { toggleElement } = useContextBarSettingsStore.getState()
      toggleElement('showGitBranch')

      const { settings } = useContextBarSettingsStore.getState()
      expect(settings.showGitBranch).toBe(true)
    })

    it('should toggle showGitStatus', () => {
      const { toggleElement } = useContextBarSettingsStore.getState()

      toggleElement('showGitStatus')

      const { settings } = useContextBarSettingsStore.getState()
      expect(settings.showGitStatus).toBe(false)
    })

    it('should toggle showWorkingDirectory', () => {
      const { toggleElement } = useContextBarSettingsStore.getState()

      toggleElement('showWorkingDirectory')

      const { settings } = useContextBarSettingsStore.getState()
      expect(settings.showWorkingDirectory).toBe(false)
    })

    it('should toggle showExitCode', () => {
      const { toggleElement } = useContextBarSettingsStore.getState()

      toggleElement('showExitCode')

      const { settings } = useContextBarSettingsStore.getState()
      expect(settings.showExitCode).toBe(false)
    })

    it('should not affect other settings when toggling one', () => {
      const { toggleElement } = useContextBarSettingsStore.getState()

      toggleElement('showGitBranch')

      const { settings } = useContextBarSettingsStore.getState()
      expect(settings.showGitBranch).toBe(false)
      expect(settings.showGitStatus).toBe(true)
      expect(settings.showWorkingDirectory).toBe(true)
      expect(settings.showExitCode).toBe(true)
    })
  })

  describe('setSettings', () => {
    it('should replace all settings', () => {
      const newSettings = {
        showGitBranch: false,
        showGitStatus: false,
        showWorkingDirectory: true,
        showExitCode: false
      }

      const { setSettings } = useContextBarSettingsStore.getState()
      setSettings(newSettings)

      const { settings } = useContextBarSettingsStore.getState()
      expect(settings).toEqual(newSettings)
    })
  })

  describe('setLoaded', () => {
    it('should set isLoaded to true', () => {
      const { setLoaded } = useContextBarSettingsStore.getState()

      setLoaded(true)

      const { isLoaded } = useContextBarSettingsStore.getState()
      expect(isLoaded).toBe(true)
    })

    it('should set isLoaded to false', () => {
      useContextBarSettingsStore.setState({ isLoaded: true })

      const { setLoaded } = useContextBarSettingsStore.getState()
      setLoaded(false)

      const { isLoaded } = useContextBarSettingsStore.getState()
      expect(isLoaded).toBe(false)
    })
  })
})
