import { MONO_FONT_FAMILY } from '@/lib/font-stacks'

/** Stop waiting so a stuck FontFaceSet.load cannot block the terminal. */
export const MONO_FONT_LOAD_TIMEOUT_MS = 3000

function monoFontLoadSpec(fontSizePx: number): string {
  return `${fontSizePx}px ${MONO_FONT_FAMILY[0]}`
}

/** True when Paper Mono can be measured, or when this runtime cannot load fonts. */
export function isMonoFontReady(fontSizePx: number): boolean {
  if (typeof document === 'undefined' || typeof document.fonts?.check !== 'function') return true
  try {
    return document.fonts.check(monoFontLoadSpec(fontSizePx))
  } catch {
    return true
  }
}

/** Load Paper Mono before xterm measures glyph width. Rejects when the load fails. */
export async function ensureMonoFontLoaded(fontSizePx: number): Promise<void> {
  if (typeof document === 'undefined' || typeof document.fonts?.load !== 'function') return
  await document.fonts.load(monoFontLoadSpec(fontSizePx))
}
