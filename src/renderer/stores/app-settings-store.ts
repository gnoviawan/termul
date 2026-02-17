import { create } from 'zustand'
import type { AppSettings } from '@/types/settings'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'

interface AppSettingsState {
  settings: AppSettings
  isLoaded: boolean
  setSettings: (settings: AppSettings) => void
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  resetToDefaults: () => void
}

export const useAppSettingsStore = create<AppSettingsState>((set) => ({
  settings: DEFAULT_APP_SETTINGS,
  isLoaded: false,

  setSettings: (settings) => set({ settings, isLoaded: true }),

  updateSetting: (key, value) =>
    set((state) => ({
      settings: { ...state.settings, [key]: value }
    })),

  resetToDefaults: () => set({ settings: DEFAULT_APP_SETTINGS })
}))

// Selectors
export const useAppSettings = () => useAppSettingsStore((state) => state.settings)
export const useAppSettingsLoaded = () => useAppSettingsStore((state) => state.isLoaded)
export const useTerminalFontFamily = () =>
  useAppSettingsStore((state) => state.settings.terminalFontFamily)
export const useTerminalFontSize = () =>
  useAppSettingsStore((state) => state.settings.terminalFontSize)
export const useDefaultShell = () =>
  useAppSettingsStore((state) => state.settings.defaultShell)
export const useDefaultProjectColor = () =>
  useAppSettingsStore((state) => state.settings.defaultProjectColor)
export const useTerminalBufferSize = () =>
  useAppSettingsStore((state) => state.settings.terminalBufferSize)
export const useMaxTerminalsPerProject = () =>
  useAppSettingsStore((state) => state.settings.maxTerminalsPerProject)
export const useOrphanDetectionEnabled = () =>
  useAppSettingsStore((state) => state.settings.orphanDetectionEnabled)
export const useOrphanDetectionTimeout = () =>
  useAppSettingsStore((state) => state.settings.orphanDetectionTimeout)
