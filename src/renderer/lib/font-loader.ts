/**
 * Font Loader Utility
 *
 * Handles dynamic registration and unregistration of custom fonts
 * using the CSS FontFace API. Works in both web and Tauri contexts.
 */

const registeredFonts = new Map<string, FontFace>()

/**
 * Register a custom font from base64-encoded TTF data
 */
export async function registerFont(fontFamily: string, base64Data: string): Promise<boolean> {
  try {
    // Unregister existing font with same name first
    if (registeredFonts.has(fontFamily)) {
      unregisterFont(fontFamily)
    }

    const binaryData = base64ToArrayBuffer(base64Data)
    const fontFace = new FontFace(fontFamily, binaryData, {
      style: 'normal',
      weight: '400',
      display: 'swap'
    })

    await fontFace.load()
    document.fonts.add(fontFace)
    registeredFonts.set(fontFamily, fontFace)

    return true
  } catch (err) {
    console.error(`Failed to register font "${fontFamily}":`, err)
    return false
  }
}

/**
 * Unregister a previously registered custom font
 */
export function unregisterFont(fontFamily: string): boolean {
  const fontFace = registeredFonts.get(fontFamily)
  if (fontFace) {
    document.fonts.delete(fontFace)
    registeredFonts.delete(fontFamily)
    return true
  }
  return false
}

/**
 * Check if a custom font is currently registered
 */
export function isFontRegistered(fontFamily: string): boolean {
  return registeredFonts.has(fontFamily)
}

/**
 * Get all registered custom font family names
 */
export function getRegisteredFonts(): string[] {
  return Array.from(registeredFonts.keys())
}

/**
 * Read a TTF file and return base64-encoded data
 */
export function readFontFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the data URL prefix to get pure base64
      const base64 = result.split(',')[1]
      if (!base64) {
        reject(new Error('Failed to read font file as base64'))
        return
      }
      resolve(base64)
    }
    reader.onerror = () => reject(new Error('Failed to read font file'))
    reader.readAsDataURL(file)
  })
}

/**
 * Extract a clean font name from a filename
 * e.g. "MyFont-Regular.ttf" → "MyFont"
 */
export function extractFontName(filename: string): string {
  return filename
    .replace(/\.ttf$/i, '')
    .replace(/-(Regular|Bold|Italic|Light|Medium|SemiBold|ExtraBold|Thin|Black)$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // CamelCase → spaces
    .trim()
}

/**
 * Convert base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes.buffer
}
