import { create } from 'zustand'
import { applyColorTheme } from '@/lib/themes'
import type { AppearanceMode } from '@/lib/themes/theme-appearance'

interface ThemePickerState {
  isOpen: boolean
  initialEffectiveThemeId: string | null
  initialAppearanceMode: AppearanceMode | null
  highlightedThemeId: string | null
  open: (effectiveThemeId: string, appearanceMode: AppearanceMode) => void
  close: () => void
  preview: (themeId: string) => void
  cancel: () => void
}

export const useThemePickerStore = create<ThemePickerState>((set, get) => ({
  isOpen: false,
  initialEffectiveThemeId: null,
  initialAppearanceMode: null,
  highlightedThemeId: null,

  open: (effectiveThemeId: string, appearanceMode: AppearanceMode) => {
    set({
      isOpen: true,
      initialEffectiveThemeId: effectiveThemeId,
      initialAppearanceMode: appearanceMode,
      highlightedThemeId: effectiveThemeId
    })
  },

  close: () => {
    set({
      isOpen: false,
      initialEffectiveThemeId: null,
      initialAppearanceMode: null,
      highlightedThemeId: null
    })
  },

  preview: (themeId: string) => {
    set({ highlightedThemeId: themeId })
    applyColorTheme(themeId)
  },

  cancel: () => {
    const { initialEffectiveThemeId } = get()
    if (initialEffectiveThemeId) {
      applyColorTheme(initialEffectiveThemeId)
    }
    get().close()
  }
}))

export const useThemePickerOpen = () => useThemePickerStore((state) => state.isOpen)
