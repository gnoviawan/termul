/** Pixel reads on frames grabbed by the session. */

import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import type { Rect } from '../browser/probes'

/** Distinct RGB colours inside `rect` (window coordinates), sampled every `step` pixels. */
export function regionColors(file: string, rect: Rect, step = 2): number {
  const png = PNG.sync.read(readFileSync(file))
  const seen = new Set<number>()
  const x1 = Math.min(png.width, rect.x + rect.width)
  const y1 = Math.min(png.height, rect.y + rect.height)
  for (let y = Math.max(0, rect.y); y < y1; y += step) {
    for (let x = Math.max(0, rect.x); x < x1; x += step) {
      const i = (png.width * y + x) * 4
      seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2])
    }
  }
  return seen.size
}
