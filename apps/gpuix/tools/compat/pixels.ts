/**
 * `bun tools/compat/pixels.ts <png> <x> <y0> <y1> [<png>…]`
 *
 * The luminance (0-255, Rec. 601) of one pixel column from y0 to y1 in each
 * PNG: how the matrix notes measure an edge (the composer card's bottom
 * border, a scrim over the status bar) in the web and GPUIX frames.
 */

import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const args = Bun.argv.slice(2)
const files = args.filter((a) => a.endsWith('.png'))
const [x, y0, y1] = args.filter((a) => !a.endsWith('.png')).map(Number)
if (files.length === 0 || ![x, y0, y1].every(Number.isFinite)) {
  console.error('usage: bun tools/compat/pixels.ts <png>... <x> <y0> <y1>')
  process.exit(2)
}
for (const file of files) {
  const png = PNG.sync.read(readFileSync(file))
  const column: number[] = []
  for (let y = y0; y <= y1; y++) {
    const i = (y * png.width + x) * 4
    column.push(Math.round(0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]))
  }
  console.log(`${file} x=${x} y=${y0}..${y1}: ${column.join(' ')}`)
}
