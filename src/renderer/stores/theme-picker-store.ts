import { create } from 'zustand'
import { applyColorTheme } from '@/lib/themes'

interface ThemePickerState {
  isOpen: boolean
  initialEffectiveThemeId: string | null
  highlightedThemeId: string | null
  open: (effectiveThemeId: string) => void
  close: () => void
  toggle: (effectiveThemeId: string) => void
  preview: (themeId: string) => void
  cancel: () => void
}

export const useThemePickerStore = create<ThemePickerState>((set, get) => ({
  isOpen: false,
  initialEffectiveThemeId: null,
  highlightedThemeId: null,

  open: (effectiveThemeId: string) => {
    set({
      isOpen: true,
      initialEffectiveThemeId: effectiveThemeId,
      highlightedThemeId: effectiveThemeId
    })
  },

  close: () => {
    set({
      isOpen: false,
      initialEffectiveThemeId: null,
      highlightedThemeId: null
    })
  },

  toggle: (effectiveThemeId: string) => {
    const { isOpen } = get()
    if (isOpen) {
      get().cancel()
      return
    }
    get().open(effectiveThemeId)
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
