/**
 * Paper Mono for GPUI. The app ships a variable `PaperMono[wght].woff2`;
 * GPUI on Linux resolved that family to DejaVu Sans when registered as a
 * variable TTF (measured 2026-10-23: 'M' advanced 12.08px instead of
 * 8.484px), so the static Regular and Bold instances live here, produced by
 * `tools/terminal/fonts.ts`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { log } from '../log'
import boldFile from './fonts/PaperMono-Bold.ttf' with { type: 'file' }
import regularFile from './fonts/PaperMono-Regular.ttf' with { type: 'file' }

export const TERMINAL_FONT_FAMILY = 'Paper Mono'
export const TERMINAL_FONT_SIZE = 14
export const TERMINAL_LINE_HEIGHT = 1.2
export const TERMINAL_FONT_WEIGHT_BOLD = 700

/** Bun's file loader yields an absolute path from source and a bundle-relative one from a bundle. */
export const TERMINAL_FONT_FILES = {
  regular: resolve(import.meta.dir, regularFile),
  bold: resolve(import.meta.dir, boldFile)
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
    log.error('terminal', `fonts.register-failed ${JSON.stringify({ error: String(error) })}`)
    throw error
  }
  registered = true
  log.info(
    'terminal',
    `fonts.registered ${JSON.stringify({ ms: Math.round(performance.now() - started) })}`
  )
}

export interface CellMetrics {
  width: number
  height: number
}

/** Ascent and descent in font units, as Skia reads them (OS/2 typo metrics when USE_TYPO_METRICS is set). */
export function verticalMetrics(font: Buffer): {
  ascent: number
  descent: number
  unitsPerEm: number
} {
  const tables = new Map<string, number>()
  for (let i = 0, n = font.readUInt16BE(4); i < n; i++) {
    const record = 12 + i * 16
    tables.set(font.toString('latin1', record, record + 4), font.readUInt32BE(record + 8))
  }
  const head = tables.get('head')
  const hhea = tables.get('hhea')
  if (head === undefined || hhea === undefined) throw new Error('font has no head or hhea table')
  const unitsPerEm = font.readUInt16BE(head + 18)
  const os2 = tables.get('OS/2')
  if (os2 !== undefined && (font.readUInt16BE(os2 + 62) & 0x80) !== 0) {
    return { ascent: font.readInt16BE(os2 + 68), descent: -font.readInt16BE(os2 + 70), unitsPerEm }
  }
  return { ascent: font.readInt16BE(hhea + 4), descent: -font.readInt16BE(hhea + 6), unitsPerEm }
}

let regularMetrics: ReturnType<typeof verticalMetrics> | null = null

/**
 * The glyph box height Chromium reports for the terminal font
 * (`fontBoundingBoxAscent + fontBoundingBoxDescent`): Blink rounds the
 * ascent and the descent to whole pixels separately.
 */
export function terminalCharHeight(fontSize: number): number {
  regularMetrics ??= verticalMetrics(readFileSync(TERMINAL_FONT_FILES.regular))
  const { ascent, descent, unitsPerEm } = regularMetrics
  return (
    Math.round((ascent * fontSize) / unitsPerEm) + Math.round((descent * fontSize) / unitsPerEm)
  )
}

/**
 * xterm.js cell geometry (CharSizeService + the WebGL renderer's dimensions):
 * `floor(advance)` wide, `floor(ceil(charHeight) * lineHeight)` tall.
 */
export function cellMetrics(advance: number, charHeight: number, lineHeight: number): CellMetrics {
  return { width: Math.floor(advance), height: Math.floor(Math.ceil(charHeight) * lineHeight) }
}
