import { create } from 'zustand'
import type { CustomFont } from '@/types/settings'

interface CustomFontState {
  fonts: CustomFont[]
  isLoaded: boolean
  setFonts: (fonts: CustomFont[]) => void
  addFont: (font: CustomFont) => void
  removeFont: (id: string) => void
}

export const useCustomFontStore = create<CustomFontState>((set) => ({
  fonts: [],
  isLoaded: false,

  setFonts: (fonts) => set({ fonts, isLoaded: true }),

  addFont: (font) =>
    set((state) => ({
      fonts: [...state.fonts, font]
    })),

  removeFont: (id) =>
    set((state) => ({
      fonts: state.fonts.filter((f) => f.id !== id)
    }))
}))

// Selectors
export const useCustomFonts = () => useCustomFontStore((state) => state.fonts)
export const useCustomFontsLoaded = () => useCustomFontStore((state) => state.isLoaded)
