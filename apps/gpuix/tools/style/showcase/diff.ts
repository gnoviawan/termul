/**
 * Per-swatch breakdown on top of the parity harness's whole-frame diff.
 *   bun tools/style/showcase/diff.ts <web.png> <gpuix.png> <diff.png> [tolerance]
 * A pixel differs when any channel differs by more than `tolerance` (0-255).
 */
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { diffPngs } from '../../parity/diff'
import { cellRect, SWATCHES } from './swatches'

export interface CellDiff {
  id: string
  differing: number
  percent: number
}

export interface ToleranceDiff {
  differing: number
  percent: number
  cells: CellDiff[]
}

export function diffWithTolerance(
  webPng: string,
  gpuixPng: string,
  tolerance: number
): ToleranceDiff {
  const a = PNG.sync.read(readFileSync(webPng))
  const b = PNG.sync.read(readFileSync(gpuixPng))
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  const mask = new Uint8Array(a.width * a.height)
  let differing = 0
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2])
    )
    if (delta > tolerance) {
      mask[p] = 1
      differing++
    }
  }
  const cells = SWATCHES.map((swatch, index) => {
    const r = cellRect(index)
    let n = 0
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) n += mask[y * a.width + x]
    return { id: swatch.id, differing: n, percent: (100 * n) / (r.width * r.height) }
  })
  return { differing, percent: (100 * differing) / mask.length, cells }
}

export function printDiff(webPng: string, gpuixPng: string, diffPng: string): void {
  const frame = diffPngs(webPng, gpuixPng, diffPng)
  console.log(
    `  exact ${frame.exact.percent.toFixed(2)}%  perceptual ${frame.perceptual.percent.toFixed(2)}%  (${diffPng})`
  )
  for (const tolerance of [8, 16]) {
    const result = diffWithTolerance(webPng, gpuixPng, tolerance)
    console.log(`  tolerance ${String(tolerance).padStart(2)}: ${result.percent.toFixed(2)}%`)
    if (tolerance === 8)
      for (const cell of result.cells)
        console.log(`    ${cell.id.padEnd(20)} ${cell.percent.toFixed(2).padStart(6)}%`)
  }
}

if (import.meta.main) {
  const [web, gpuix, diff] = process.argv.slice(2)
  printDiff(web, gpuix, diff)
}
