import { create } from 'zustand'
import type { ContextBarSettings } from '@/types/settings'
import { DEFAULT_CONTEXT_BAR_SETTINGS } from '@/types/settings'

interface ContextBarSettingsState {
  settings: ContextBarSettings
  isLoaded: boolean
  toggleElement: (element: keyof ContextBarSettings) => void
  setSettings: (settings: ContextBarSettings) => void
  setLoaded: (loaded: boolean) => void
}

export const useContextBarSettingsStore = create<ContextBarSettingsState>((set) => ({
  settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS },
  isLoaded: false,

  toggleElement: (element) =>
    set((state) => ({
      settings: { ...state.settings, [element]: !state.settings[element] }
    })),

  setSettings: (settings) => set({ settings }),

  setLoaded: (loaded) => set({ isLoaded: loaded })
}))

// Selectors for individual visibility settings
export const useShowGitBranch = (): boolean =>
  useContextBarSettingsStore((state) => state.settings.showGitBranch)

export const useShowGitStatus = (): boolean =>
  useContextBarSettingsStore((state) => state.settings.showGitStatus)

export const useShowWorkingDirectory = (): boolean =>
  useContextBarSettingsStore((state) => state.settings.showWorkingDirectory)

export const useShowExitCode = (): boolean =>
  useContextBarSettingsStore((state) => state.settings.showExitCode)

// Selector for all settings
export const useContextBarSettings = (): ContextBarSettings =>
  useContextBarSettingsStore((state) => state.settings)
