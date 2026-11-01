import { MONO_FONT_FAMILY, SYMBOLS_FONT_FAMILY } from '@/lib/font-stacks'
import { logFrontendError } from '@/lib/log-api'

/** Stop waiting so a stuck FontFaceSet.load cannot block the terminal. */
export const MONO_FONT_LOAD_TIMEOUT_MS = 3000

function monoFontLoadSpec(fontSizePx: number): string {
  return `${fontSizePx}px ${MONO_FONT_FAMILY[0]}`
}

/** A probe from the symbol face: Nerd Font Powerline branch, absent from Paper Mono. */
const SYMBOLS_PROBE_SPEC = `14px ${SYMBOLS_FONT_FAMILY}`

/**
 * True when Paper Mono AND the Termul Symbols fallback can be measured.
 * Checking the fallback matters: xterm measures cell width from Paper Mono alone,
 * but a slow or failed symbol face means icons paint as tofu until it arrives.
 */
export function isMonoFontReady(fontSizePx: number): boolean {
  if (typeof document === 'undefined' || typeof document.fonts?.check !== 'function') return true
  try {
    return (
      document.fonts.check(monoFontLoadSpec(fontSizePx)) && document.fonts.check(SYMBOLS_PROBE_SPEC)
    )
  } catch {
    return true
  }
}

/**
 * Load Paper Mono and its symbol fallback before xterm measures glyph width.
 * Both loads are awaited even when one fails: a fast symbol failure must not end
 * the wait while Paper Mono is still loading, or the terminal measures the
 * monospace fallback and never re-measures. Only a Paper Mono failure is fatal.
 */
export async function ensureMonoFontLoaded(fontSizePx: number): Promise<void> {
  if (typeof document === 'undefined' || typeof document.fonts?.load !== 'function') return
  const [mono, symbols] = await Promise.allSettled([
    document.fonts.load(monoFontLoadSpec(fontSizePx)),
    document.fonts.load(SYMBOLS_PROBE_SPEC, '\ue0b0')
  ])
  if (symbols.status === 'rejected') {
    const detail = symbols.reason instanceof Error ? symbols.reason.message : String(symbols.reason)
    void logFrontendError({
      level: 'warn',
      source: 'mono-font.symbols',
      message: `Termul Symbols failed to load — PUA icons may render as blank boxes (${detail})`
    })
  }
  if (mono.status === 'rejected') throw mono.reason
}
