/**
 * Parity check: the recorded fixture rendered by xterm.js in headless
 * Chromium and by TerminalView in GPUIX at the same grid, font, size and
 * theme. Asserts the visible text of every row is identical and reports the
 * pixel mismatch between the two grids.
 *
 * bun tools/terminal/parity.ts [outDir]
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  TERMINAL_FONT_FILES,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT
} from '../../src/terminal/fonts'
import { terminalThemeFor } from '../../src/terminal/theme'
import { FIXTURE_BYTES, FIXTURE_COLS, FIXTURE_ROWS } from './fixture'
import { crop, diffImages, type RgbImage, readPng, writePng } from './pixels'
import { renderWithXtermJs } from './xterm-chromium'
import { shootEntry } from './xvfb'

interface GpuixReady {
  rows: string[]
  cursor: { x: number; y: number }
  cell: { width: number; height: number }
  grid: { x: number; y: number; width: number; height: number } | null
  bufferLength: number
}

/** Where the GPUIX window sits on the X screen: GPUI bounds are window-relative and Xvfb has no window manager. */
function windowOrigin(img: RgbImage): { x: number; y: number } {
  const lit = (x: number, y: number) => {
    const i = (y * img.width + x) * 3
    return img.data[i]! + img.data[i + 1]! + img.data[i + 2]! > 0
  }
  let x = 0
  while (x < img.width && !lit(x, Math.floor(img.height / 2))) x++
  let y = 0
  while (y < img.height && !lit(Math.floor(img.width / 2), y)) y++
  return { x, y }
}

export async function runParity(outDir = '/tmp/gpuix-t1/parity', bytesPath = FIXTURE_BYTES) {
  mkdirSync(outDir, { recursive: true })
  const bytes = new Uint8Array(await Bun.file(bytesPath).arrayBuffer())
  const theme = terminalThemeFor('termul') as Record<string, string>
  const webPng = resolve(outDir, 'web.png')
  const web = await renderWithXtermJs({
    bytes,
    cols: FIXTURE_COLS,
    rows: FIXTURE_ROWS,
    fontFamily: 'Paper Mono',
    fontFiles: [
      { family: 'Paper Mono', path: TERMINAL_FONT_FILES.regular, weight: 400 },
      { family: 'Paper Mono', path: TERMINAL_FONT_FILES.bold, weight: 700 }
    ],
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    theme,
    scrollback: 10000,
    renderer: (process.env.PARITY_RENDERER as 'dom' | 'webgl' | undefined) ?? 'webgl',
    outPng: webPng
  })
  const readyFile = resolve(outDir, 'gpuix-ready.json')
  if (existsSync(readyFile)) unlinkSync(readyFile)
  const fullPng = resolve(outDir, 'gpuix-window.png')
  const gpuix = await shootEntry<GpuixReady>({
    entry: resolve(import.meta.dir, 'parity-gpuix.tsx'),
    args: [
      bytesPath,
      readyFile,
      String(FIXTURE_COLS),
      String(FIXTURE_ROWS),
      String(web.cellWidth),
      String(web.cellHeight)
    ],
    readyFile,
    outPng: fullPng,
    settleMs: 800
  })
  if (!gpuix.grid) throw new Error('GPUIX did not report its grid box')
  const gpuixPng = resolve(outDir, 'gpuix.png')
  const window = await readPng(fullPng)
  const origin = windowOrigin(window)
  await writePng(
    gpuixPng,
    crop(
      window,
      origin.x + Math.round(gpuix.grid.x),
      origin.y + Math.round(gpuix.grid.y),
      Math.round(gpuix.grid.width),
      Math.round(gpuix.grid.height)
    )
  )
  const diffPng = resolve(outDir, 'diff.png')
  const diff = await diffImages(await readPng(webPng), await readPng(gpuixPng), {
    threshold: 24,
    outDiff: diffPng
  })

  const mismatches: string[] = []
  for (let y = 0; y < FIXTURE_ROWS; y++) {
    if (web.rows[y] !== gpuix.rows[y])
      mismatches.push(
        `row ${y}: web=${JSON.stringify(web.rows[y])} gpuix=${JSON.stringify(gpuix.rows[y])}`
      )
  }
  const cursorEqual = web.cursor.x === gpuix.cursor.x && web.cursor.y === gpuix.cursor.y
  const result = {
    bytes: bytes.length,
    cell: { web: [web.cellWidth, web.cellHeight], gpuix: [gpuix.cell.width, gpuix.cell.height] },
    bufferLength: { web: web.bufferLength, gpuix: gpuix.bufferLength },
    cursor: { web: web.cursor, gpuix: gpuix.cursor, equal: cursorEqual },
    windowOrigin: origin,
    textRowsEqual: mismatches.length === 0,
    mismatches,
    pixels: diff,
    png: { web: webPng, gpuix: gpuixPng, diff: diffPng, window: fullPng }
  }
  console.log(JSON.stringify(result, null, 2))
  if (mismatches.length || !cursorEqual) {
    console.error('TEXT PARITY FAILED')
    process.exitCode = 1
  }
  return result
}

if (import.meta.main) {
  await runParity(process.argv[2])
  process.exit(process.exitCode ?? 0)
}
