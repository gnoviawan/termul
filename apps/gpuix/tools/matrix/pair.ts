/**
 * `bun tools/matrix/pair.ts [surface-id...] [--scale 0.5] [--crop x,y,w,h]`
 *
 * Review aid: writes `pair.png` next to each step's frames, web on the left
 * and GPUIX on the right, box-downscaled, so one image shows a whole pair.
 * Without ids it pairs every step of every surface in `results.json`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import { APP_DIR } from '../../build'
import type { SurfaceResult } from './types'

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    out: { type: 'string', default: path.join(APP_DIR, 'parity-out/matrix') },
    scale: { type: 'string', default: '0.5' },
    crop: { type: 'string' }
  }
})

const GAP = 8

function scaled(file: string, scale: number, crop?: number[]): PNG {
  const src = PNG.sync.read(readFileSync(file))
  const [cx, cy, cw, ch] = crop ?? [0, 0, src.width, src.height]
  const width = Math.max(1, Math.round(cw * scale))
  const height = Math.max(1, Math.round(ch * scale))
  const out = new PNG({ width, height })
  const step = 1 / scale
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0]
      let n = 0
      for (
        let yy = Math.floor(cy + y * step);
        yy < Math.min(cy + ch, Math.floor(cy + (y + 1) * step));
        yy++
      ) {
        for (
          let xx = Math.floor(cx + x * step);
          xx < Math.min(cx + cw, Math.floor(cx + (x + 1) * step));
          xx++
        ) {
          const i = (yy * src.width + xx) * 4
          for (let c = 0; c < 4; c++) sum[c] += src.data[i + c]
          n++
        }
      }
      const o = (y * width + x) * 4
      for (let c = 0; c < 4; c++) out.data[o + c] = n ? Math.round(sum[c] / n) : 0
    }
  }
  return out
}

export function writePair(dir: string, scale: number, crop?: number[]): string | null {
  const web = path.join(dir, 'web.png')
  const gpuix = path.join(dir, 'gpuix.png')
  if (!existsSync(web) || !existsSync(gpuix)) return null
  const a = scaled(web, scale, crop)
  const b = scaled(gpuix, scale, crop)
  const out = new PNG({ width: a.width + GAP + b.width, height: Math.max(a.height, b.height) })
  out.data.fill(255)
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0)
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + GAP, 0)
  const file = path.join(dir, crop ? 'pair-crop.png' : 'pair.png')
  writeFileSync(file, PNG.sync.write(out))
  return file
}

if (import.meta.main) {
  const out = path.resolve(values.out as string)
  const results = JSON.parse(readFileSync(path.join(out, 'results.json'), 'utf8')) as Record<
    string,
    SurfaceResult
  >
  const crop = values.crop?.split(',').map(Number)
  for (const [id, result] of Object.entries(results)) {
    if (positionals.length && !positionals.includes(id)) continue
    for (const frame of result.web?.frames ?? []) {
      const file = writePair(path.dirname(frame), Number(values.scale), crop)
      if (file) console.log(file)
    }
  }
}
