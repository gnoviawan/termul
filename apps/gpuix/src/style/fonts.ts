import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { styleLog } from './log'

const FONT_DIR = join(import.meta.dir, '../../assets/fonts')
const WEIGHTS = ['Regular', 'Medium', 'SemiBold', 'Bold'] as const

/**
 * Static TTF instances of the faces the web client loads as variable WOFF2
 * (built by tools/style/build-fonts.py). Family names match font-stacks.ts.
 */
export const FONT_FILES: readonly string[] = ['Inter', 'InterTabular', 'PaperMono'].flatMap(
  (face) => WEIGHTS.map((weight) => join(FONT_DIR, `${face}-${weight}.ttf`))
)

/** Register Inter Variable, its tabular-figure twin and Paper Mono. Returns the count. */
export function registerTermulFonts(renderer: { registerFont?: (data: Buffer) => void }): number {
  if (!renderer.registerFont) {
    styleLog.warn('registerFont unavailable; text falls back to system fonts')
    return 0
  }
  for (const file of FONT_FILES) renderer.registerFont(readFileSync(file))
  styleLog.info('fonts registered', { count: FONT_FILES.length })
  return FONT_FILES.length
}
