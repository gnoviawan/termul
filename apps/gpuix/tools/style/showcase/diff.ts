/**
 * Pixel diff of two 1280x800 PNGs, whole frame and per swatch cell.
 *   bun tools/style/showcase/diff.ts <web.png> <gpuix.png> <diff.png> [tolerance]
 * A pixel differs when any channel differs by more than `tolerance` (0-255).
 * Writes a diff image: differing pixels red, the rest a dim copy of the web frame.
 */
import { spawnSync } from 'node:child_process'
import { cellRect, SWATCHES } from './swatches'

const W = 1280
const H = 800

function decode(png: string): Uint8Array {
  const out = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    {
      maxBuffer: W * H * 3 + 1024
    }
  )
  if (out.status !== 0 || out.stdout.length !== W * H * 3) {
    throw new Error(`could not decode ${png} as ${W}x${H}: ${out.stderr}`)
  }
  return out.stdout
}

function encode(rgb: Uint8Array, png: string): void {
  const out = spawnSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${W}x${H}`,
      '-i',
      '-',
      png
    ],
    { input: rgb }
  )
  if (out.status !== 0) throw new Error(`could not write ${png}: ${out.stderr}`)
}

export interface DiffResult {
  total: number
  differing: number
  percent: number
  cells: { id: string; percent: number; differing: number }[]
}

export function diffImages(
  webPng: string,
  gpuixPng: string,
  diffPng: string,
  tolerance = 0
): DiffResult {
  const a = decode(webPng)
  const b = decode(gpuixPng)
  const mask = new Uint8Array(W * H)
  const out = new Uint8Array(W * H * 3)
  let differing = 0
  for (let p = 0; p < W * H; p++) {
    const i = p * 3
    const delta = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2])
    )
    if (delta > tolerance) {
      mask[p] = 1
      differing++
      out[i] = 255
    } else {
      out[i] = a[i] >> 2
      out[i + 1] = a[i + 1] >> 2
      out[i + 2] = a[i + 2] >> 2
    }
  }
  encode(out, diffPng)
  const cells = SWATCHES.map((swatch, index) => {
    const r = cellRect(index)
    let n = 0
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) n += mask[y * W + x]
    return { id: swatch.id, differing: n, percent: (100 * n) / (r.width * r.height) }
  })
  return { total: W * H, differing, percent: (100 * differing) / (W * H), cells }
}

if (import.meta.main) {
  const [web, gpuix, diff, tol = '0'] = process.argv.slice(2)
  const result = diffImages(web, gpuix, diff, Number(tol))
  console.log(
    `tolerance ${tol}: ${result.differing}/${result.total} px differ (${result.percent.toFixed(2)}%)`
  )
  for (const cell of result.cells)
    console.log(
      `  ${cell.id.padEnd(20)} ${cell.percent.toFixed(2).padStart(6)}%  (${cell.differing} px)`
    )
  console.log(`wrote ${diff}`)
}
