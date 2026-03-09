import { create } from 'zustand'
import type { TocSettings } from '@/types/settings'
import { DEFAULT_TOC_SETTINGS, TOC_MAX_WIDTH, TOC_MIN_WIDTH } from '@/types/settings'

interface TocSettingsState {
  settings: TocSettings
  isLoaded: boolean
  setSettings: (settings: TocSettings) => void
  toggleVisibility: () => void
  setMaxHeadingLevel: (level: number) => void
  setWidth: (width: number) => void
  setLoaded: (loaded: boolean) => void
}

function clampHeadingLevel(level: number): number {
  return Math.min(6, Math.max(1, Math.round(level)))
}

function clampWidth(width: number): number {
  return Math.min(TOC_MAX_WIDTH, Math.max(TOC_MIN_WIDTH, Math.round(width)))
}

export const useTocSettingsStore = create<TocSettingsState>((set) => ({
  settings: { ...DEFAULT_TOC_SETTINGS },
  isLoaded: false,

  setSettings: (settings) =>
    set({
      settings: {
        isVisible: settings.isVisible,
        maxHeadingLevel: clampHeadingLevel(settings.maxHeadingLevel),
        width: clampWidth(settings.width)
      }
    }),

  toggleVisibility: () =>
    set((state) => ({
      settings: {
        ...state.settings,
        isVisible: !state.settings.isVisible
      }
    })),

  setMaxHeadingLevel: (level) =>
    set((state) => ({
      settings: {
        ...state.settings,
        maxHeadingLevel: clampHeadingLevel(level)
      }
    })),

  setWidth: (width) =>
    set((state) => ({
      settings: {
        ...state.settings,
        width: clampWidth(width)
      }
    })),

  setLoaded: (loaded) => set({ isLoaded: loaded })
}))

export const useTocIsVisible = (): boolean =>
  useTocSettingsStore((state) => state.settings.isVisible)

export const useTocMaxHeadingLevel = (): number =>
  useTocSettingsStore((state) => state.settings.maxHeadingLevel)

export const useTocWidth = (): number =>
  useTocSettingsStore((state) => state.settings.width)

export const useTocSettings = (): TocSettings =>
  useTocSettingsStore((state) => state.settings)

export const useTocSettingsLoaded = (): boolean =>
  useTocSettingsStore((state) => state.isLoaded)
