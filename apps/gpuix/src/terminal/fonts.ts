/**
 * Paper Mono for GPUI. The app ships a variable `PaperMono[wght].woff2`;
 * GPUI on Linux resolved that family to DejaVu Sans when registered as a
 * variable TTF (measured 2026-10-23: 'M' advanced 12.08px instead of
 * 8.484px), so the static Regular and Bold instances live here, produced by
 * `tools/terminal/fonts.ts`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { terminalLog } from './log'

export const TERMINAL_FONT_FAMILY = 'Paper Mono'
export const TERMINAL_FONT_SIZE = 14
export const TERMINAL_LINE_HEIGHT = 1.2
export const TERMINAL_FONT_WEIGHT_BOLD = 700

export const TERMINAL_FONT_FILES = {
  regular: resolve(import.meta.dir, 'fonts/PaperMono-Regular.ttf'),
  bold: resolve(import.meta.dir, 'fonts/PaperMono-Bold.ttf')
} as const

interface FontRegistrar {
  registerFont?: (data: Buffer) => void
}

let registered = false

export function registerTerminalFonts(renderer: FontRegistrar): void {
  if (registered) return
  if (!renderer.registerFont) throw new Error('GPUIX renderer has no registerFont')
  const started = performance.now()
  try {
    renderer.registerFont(readFileSync(TERMINAL_FONT_FILES.regular))
    renderer.registerFont(readFileSync(TERMINAL_FONT_FILES.bold))
  } catch (error) {
    terminalLog('error', 'fonts.register-failed', { error: String(error) })
    throw error
  }
  registered = true
  terminalLog('info', 'fonts.registered', { ms: Math.round(performance.now() - started) })
}

export interface CellMetrics {
  width: number
  height: number
}

/**
 * xterm.js cell geometry (CharSizeService + renderer dimensions): the measured
 * glyph advance, and `floor(charHeight * lineHeight)` for the row.
 */
export function cellMetrics(
  probe: { width: number; height: number; chars: number },
  lineHeight: number
): CellMetrics {
  return { width: probe.width / probe.chars, height: Math.floor(probe.height * lineHeight) }
}
