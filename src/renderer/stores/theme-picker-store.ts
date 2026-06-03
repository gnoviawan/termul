import { create } from 'zustand'
import { applyColorTheme } from '@/lib/themes'

interface ThemePickerState {
  isOpen: boolean
  initialThemeId: string | null
  highlightedThemeId: string | null
  open: (appliedThemeId: string) => void
  close: () => void
  preview: (themeId: string) => void
  cancel: () => void
}

export const useThemePickerStore = create<ThemePickerState>((set, get) => ({
  isOpen: false,
  initialThemeId: null,
  highlightedThemeId: null,

  open: (appliedThemeId: string) => {
    set({
      isOpen: true,
      initialThemeId: appliedThemeId,
      highlightedThemeId: appliedThemeId
    })
  },

  close: () => {
    set({
      isOpen: false,
      initialThemeId: null,
      highlightedThemeId: null
    })
  },

  preview: (themeId: string) => {
    set({ highlightedThemeId: themeId })
    applyColorTheme(themeId)
  },

  cancel: () => {
    const { initialThemeId } = get()
    if (initialThemeId) {
      applyColorTheme(initialThemeId)
    }
    get().close()
  }
}))

export const useThemePickerOpen = () => useThemePickerStore((state) => state.isOpen)
