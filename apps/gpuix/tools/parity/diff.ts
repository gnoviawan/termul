/**
 * Pixel diff of two same-sized PNGs. Two counts are reported: `exact`, where
 * any channel difference counts, and `perceptual`, pixelmatch's YIQ distance
 * above {@link PERCEPTUAL_THRESHOLD}. The perceptual count ignores small
 * shade differences, which on a dark theme is most of the frame, so the exact
 * count is the one that says how much of the frame really matches.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

export interface DiffCount {
  mismatched: number
  percent: number
}

export interface DiffResult {
  width: number
  height: number
  total: number
  exact: DiffCount
  perceptual: DiffCount
}

/** pixelmatch's 0..1 colour distance below which two pixels count as equal. */
export const PERCEPTUAL_THRESHOLD = 0.1

export function diffPngs(aPath: string, bPath: string, outPath: string): DiffResult {
  const a = PNG.sync.read(readFileSync(aPath))
  const b = PNG.sync.read(readFileSync(bPath))
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `size mismatch: ${aPath} is ${a.width}x${a.height}, ${bPath} is ${b.width}x${b.height}`
    )
  }
  const total = a.width * a.height
  const count = (mismatched: number): DiffCount => ({
    mismatched,
    percent: (mismatched / total) * 100
  })

  const diff = new PNG({ width: a.width, height: a.height })
  const perceptual = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: PERCEPTUAL_THRESHOLD
  })
  writeFileSync(outPath, PNG.sync.write(diff))

  let exact = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    ) {
      exact++
    }
  }
  return {
    width: a.width,
    height: a.height,
    total,
    exact: count(exact),
    perceptual: count(perceptual)
  }
}
