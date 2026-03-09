import { create } from 'zustand'
import type { TocSettings } from '@/types/settings'
import { DEFAULT_TOC_SETTINGS, TOC_MAX_WIDTH, TOC_MIN_WIDTH } from '@/types/settings'

interface TocSettingsState {
  settings: TocSettings
  isLoaded: boolean
  loadFailed: boolean
  setSettings: (settings: TocSettings) => void
  toggleVisibility: () => void
  setMaxHeadingLevel: (level: number) => void
  setWidth: (width: number) => void
  setLoaded: (loaded: boolean) => void
  setLoadFailed: (failed: boolean) => void
}

function getFiniteNumber(value: number, fallback: number): number {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : fallback
}

function clampHeadingLevel(level: number): number {
  const safeLevel = getFiniteNumber(level, DEFAULT_TOC_SETTINGS.maxHeadingLevel)
  return Math.min(6, Math.max(1, Math.round(safeLevel)))
}

function clampWidth(width: number): number {
  const safeWidth = getFiniteNumber(width, DEFAULT_TOC_SETTINGS.width)
  return Math.min(TOC_MAX_WIDTH, Math.max(TOC_MIN_WIDTH, Math.round(safeWidth)))
}

function normalizeVisibility(isVisible: boolean): boolean {
  return typeof isVisible === 'boolean' ? isVisible : DEFAULT_TOC_SETTINGS.isVisible
}

export const useTocSettingsStore = create<TocSettingsState>((set) => ({
  settings: { ...DEFAULT_TOC_SETTINGS },
  isLoaded: false,
  loadFailed: false,

  setSettings: (settings) =>
    set({
      settings: {
        isVisible: normalizeVisibility(settings.isVisible),
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

  setLoaded: (loaded) => set({ isLoaded: loaded }),
  setLoadFailed: (failed) => set({ loadFailed: failed })
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

export const useTocSettingsHydrated = (): boolean =>
  useTocSettingsStore((state) => state.isLoaded || state.loadFailed)
