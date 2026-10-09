import { create } from 'zustand'
import type { TocSettings } from '@/types/settings'
import { DEFAULT_TOC_SETTINGS, TOC_MAX_WIDTH, TOC_MIN_WIDTH } from '@/types/settings'

/** Collapsed outline parents, keyed by file path. Session memory only. */
export type TocCollapsedByFile = Record<string, string[]>

const EMPTY_COLLAPSED: readonly string[] = Object.freeze([])

interface TocSettingsState {
  settings: TocSettings
  isLoaded: boolean
  loadFailed: boolean
  /**
   * Not part of `settings`, so `useTocSettings` does not write it to disk.
   * Heading ids change between sessions (BlockNote block ids, line numbers),
   * so the collapse state lives for the app session only.
   */
  collapsedByFile: TocCollapsedByFile
  setSettings: (settings: TocSettings) => void
  toggleVisibility: () => void
  setCollapsedKeys: (filePath: string, keys: string[]) => void
  toggleCollapsedKey: (filePath: string, key: string) => void
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

/** Copy of `byFile` with `keys` for `filePath`; an empty list drops the file. */
function withCollapsedKeys(
  byFile: TocCollapsedByFile,
  filePath: string,
  keys: string[]
): TocCollapsedByFile {
  const next = { ...byFile }
  if (keys.length === 0) {
    delete next[filePath]
  } else {
    next[filePath] = keys
  }
  return next
}

export const useTocSettingsStore = create<TocSettingsState>((set) => ({
  settings: { ...DEFAULT_TOC_SETTINGS },
  isLoaded: false,
  loadFailed: false,
  collapsedByFile: {},

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

  setCollapsedKeys: (filePath, keys) =>
    set((state) => ({
      collapsedByFile: withCollapsedKeys(state.collapsedByFile, filePath, Array.from(new Set(keys)))
    })),

  toggleCollapsedKey: (filePath, key) =>
    set((state) => {
      const current = state.collapsedByFile[filePath] ?? []
      const keys = current.includes(key)
        ? current.filter((existing) => existing !== key)
        : [...current, key]
      return { collapsedByFile: withCollapsedKeys(state.collapsedByFile, filePath, keys) }
    }),

  setLoaded: (loaded) => set({ isLoaded: loaded }),
  setLoadFailed: (failed) => set({ loadFailed: failed })
}))

export const useTocIsVisible = (): boolean =>
  useTocSettingsStore((state) => state.settings.isVisible)

export const useTocMaxHeadingLevel = (): number =>
  useTocSettingsStore((state) => state.settings.maxHeadingLevel)

export const useTocWidth = (): number => useTocSettingsStore((state) => state.settings.width)

export const useTocSettings = (): TocSettings => useTocSettingsStore((state) => state.settings)

export const useTocSettingsLoaded = (): boolean => useTocSettingsStore((state) => state.isLoaded)

export const useTocSettingsHydrated = (): boolean =>
  useTocSettingsStore((state) => state.isLoaded || state.loadFailed)

/** Collapsed outline keys for one file. Returns a stable empty array when none. */
export const useTocCollapsedKeys = (filePath: string): readonly string[] =>
  useTocSettingsStore((state) => state.collapsedByFile[filePath] ?? EMPTY_COLLAPSED)
