import { useEffect, useCallback } from 'react'
import { useCustomFontStore } from '@/stores/custom-font-store'
import { persistenceApi } from '@/lib/api'
import { registerFont, unregisterFont, readFontFile, extractFontName } from '@/lib/font-loader'
import type { CustomFont } from '@/types/settings'
import { CUSTOM_FONTS_KEY, MAX_CUSTOM_FONTS, MAX_FONT_FILE_SIZE } from '@/types/settings'

/**
 * Load and register all custom fonts from persistence on app startup
 */
export function useCustomFontsLoader(): void {
  const setFonts = useCustomFontStore((state) => state.setFonts)

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await persistenceApi.read<CustomFont[]>(CUSTOM_FONTS_KEY)
      if (result.success && result.data) {
        const fonts = result.data
        setFonts(fonts)

        // Register all fonts with the browser
        for (const font of fonts) {
          await registerFont(font.fontFamily, font.data)
        }
      } else {
        setFonts([])
      }
    }
    load()
  }, [setFonts])
}

/**
 * Add a custom font from a file input
 * Returns the added font on success, or an error message on failure
 */
export function useAddCustomFont(): (file: File) => Promise<{ success: true; font: CustomFont } | { success: false; error: string }> {
  const addFont = useCustomFontStore((state) => state.addFont)
  const fonts = useCustomFontStore((state) => state.fonts)

  return useCallback(
    async (file: File) => {
      // Validate file type
      if (!file.name.toLowerCase().endsWith('.ttf')) {
        return { success: false, error: 'Only TTF font files are supported.' }
      }

      // Validate file size
      if (file.size > MAX_FONT_FILE_SIZE) {
        const sizeMB = (MAX_FONT_FILE_SIZE / 1024 / 1024).toFixed(0)
        return { success: false, error: `Font file is too large. Maximum size is ${sizeMB}MB.` }
      }

      // Check limit
      if (fonts.length >= MAX_CUSTOM_FONTS) {
        return { success: false, error: `Maximum of ${MAX_CUSTOM_FONTS} custom fonts reached. Remove one first.` }
      }

      try {
        // Read file as base64
        const base64Data = await readFontFile(file)
        const name = extractFontName(file.name)
        const fontFamily = `Custom-${name.replace(/\s+/g, '-')}`

        // Check for duplicate name
        if (fonts.some((f) => f.fontFamily === fontFamily)) {
          return { success: false, error: `A custom font with the name "${name}" already exists.` }
        }

        // Register with browser
        const registered = await registerFont(fontFamily, base64Data)
        if (!registered) {
          return { success: false, error: 'Failed to load font. The file may be corrupted.' }
        }

        const customFont: CustomFont = {
          id: crypto.randomUUID(),
          name,
          fontFamily,
          data: base64Data,
          addedAt: Date.now()
        }

        // Update store and persist
        addFont(customFont)
        const allFonts = [...fonts, customFont]
        await persistenceApi.writeDebounced(CUSTOM_FONTS_KEY, allFonts)

        return { success: true, font: customFont }
      } catch (err) {
        return { success: false, error: `Failed to add font: ${String(err)}` }
      }
    },
    [addFont, fonts]
  )
}

/**
 * Remove a custom font by ID
 */
export function useRemoveCustomFont(): (id: string) => Promise<void> {
  const removeFont = useCustomFontStore((state) => state.removeFont)
  const fonts = useCustomFontStore((state) => state.fonts)

  return useCallback(
    async (id: string) => {
      const font = fonts.find((f) => f.id === id)
      if (font) {
        unregisterFont(font.fontFamily)
      }

      removeFont(id)
      const remaining = fonts.filter((f) => f.id !== id)
      await persistenceApi.writeDebounced(CUSTOM_FONTS_KEY, remaining)
    },
    [removeFont, fonts]
  )
}
