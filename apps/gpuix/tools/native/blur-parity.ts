/**
 * Backdrop parity of matrix runs: mean absolute channel difference, web
 * against GPUIX, over the scrim strip left of every dialog (x < 120 px, full
 * height), for each surface's last step in a before and an after run of
 * `bun run parity:matrix --out DIR`.
 *
 * bun tools/native/blur-parity.ts <before dir> <after dir> <surface id>...
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'

const STRIP_WIDTH = 120
const [before, after, ...surfaces] = Bun.argv.slice(2)
if (!before || !after || !surfaces.length)
  throw new Error('usage: blur-parity.ts <before> <after> <surface>...')

function lastStep(dir: string, surface: string): string {
  const root = path.join(dir, surface.replaceAll('.', '-'))
  const steps = readdirSync(root).sort()
  return path.join(root, steps.at(-1) as string)
}

function stripMad(step: string): number {
  const web = PNG.sync.read(readFileSync(path.join(step, 'web.png')))
  const gpuix = PNG.sync.read(readFileSync(path.join(step, 'gpuix.png')))
  let sum = 0
  let n = 0
  for (let y = 0; y < web.height; y++)
    for (let x = 0; x < STRIP_WIDTH; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * web.width + x) * 4 + c
        sum += Math.abs((web.data[i] ?? 0) - (gpuix.data[i] ?? 0))
        n++
      }
  return sum / n
}

for (const surface of surfaces) {
  const b = stripMad(lastStep(before, surface))
  const a = stripMad(lastStep(after, surface))
  console.log(`${surface}: scrim strip MAD ${b.toFixed(2)} -> ${a.toFixed(2)} (0-255 per channel)`)
}
