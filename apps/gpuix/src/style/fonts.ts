import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log'

const FONT_DIR = join(import.meta.dir, '../../assets/fonts')
const WEIGHTS = ['Regular', 'Medium', 'SemiBold', 'Bold'] as const
const ITALICS = ['Italic', 'MediumItalic', 'SemiBoldItalic', 'BoldItalic'] as const

/**
 * Static TTF instances of the faces the web client loads as variable WOFF2
 * (built by tools/style/build-fonts.py). Family names match font-stacks.ts.
 * The italic faces serve markdown emphasis and, on the patched addon,
 * `fontStyle: 'italic'`; the tabular twin has none, as the web never
 * italicises figures.
 */
export const FONT_FILES: readonly string[] = [
  ...['Inter', 'InterTabular', 'PaperMono'].flatMap((face) =>
    WEIGHTS.map((weight) => join(FONT_DIR, `${face}-${weight}.ttf`))
  ),
  ...['Inter', 'PaperMono'].flatMap((face) =>
    ITALICS.map((style) => join(FONT_DIR, `${face}-${style}.ttf`))
  )
]

/** Register Inter Variable, its tabular-figure twin and Paper Mono. Returns the count. */
export function registerTermulFonts(renderer: { registerFont?: (data: Buffer) => void }): number {
  if (!renderer.registerFont) {
    log.warn('fonts', 'registerFont unavailable; text falls back to system fonts')
    return 0
  }
  for (const file of FONT_FILES) renderer.registerFont(readFileSync(file))
  log.info('fonts', `registered ${FONT_FILES.length} faces`)
  return FONT_FILES.length
}
