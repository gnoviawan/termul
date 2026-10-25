/**
 * Parity check: the recorded fixture rendered by xterm.js in headless
 * Chromium (the app's WebGL renderer by default) and by TerminalView in GPUIX
 * at the same grid, cell size, font, size and theme. For each checkpoint of
 * the recording it asserts that every visible cell (chars, width, colours,
 * attributes) and the cursor are identical, and reports the pixel mismatch
 * between the two grids with P0's `diffPngs`.
 *
 * bun tools/terminal/parity.ts [--out DIR] [--renderer webgl|dom] [--checkpoint NAME ...]
 * bun tools/terminal/parity.ts --bytes FILE   (one checkpoint, "all", over a raw byte stream)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import {
  TERMINAL_FONT_FILES,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT
} from '../../src/terminal/fonts'
import { terminalThemeFor } from '../../src/terminal/theme'
import { diffPngs } from '../parity/diff'
import { FIXTURE_BYTES, FIXTURE_CHECKPOINTS, FIXTURE_COLS, FIXTURE_ROWS } from './fixture'
import { runEntry } from './headless'
import { renderWithXtermJs } from './xterm-chromium'

interface GpuixReady {
  rows: string[]
  cells: string[]
  cursor: { x: number; y: number }
  grid: { x: number; y: number; width: number; height: number }
  bufferLength: number
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-t1/parity' },
    renderer: { type: 'string', default: 'webgl' },
    checkpoint: { type: 'string', multiple: true },
    bytes: { type: 'string' }
  }
})
const bytesFile = values.bytes ? path.resolve(values.bytes) : FIXTURE_BYTES
const checkpoints = values.checkpoint ?? (values.bytes ? ['all'] : ['less', 'vim', 'done'])
const renderer = values.renderer === 'dom' ? 'dom' : 'webgl'

/**
 * GPUI bounds are window relative, and with no window manager Xvfb places the
 * window a few pixels off the screen origin. The root window is pure black
 * and the theme background is not, so the first lit pixel is the window edge.
 */
function windowOrigin(png: PNG): { x: number; y: number } {
  const lit = (x: number, y: number) => {
    const i = (y * png.width + x) * 4
    return png.data[i]! + png.data[i + 1]! + png.data[i + 2]! > 0
  }
  let x = 0
  while (x < png.width && !lit(x, png.height >> 1)) x++
  let y = 0
  while (y < png.height && !lit(png.width >> 1, y)) y++
  return { x, y }
}

function cropPng(inPath: string, outPath: string, rect: GpuixReady['grid']): void {
  const source = PNG.sync.read(readFileSync(inPath))
  const origin = windowOrigin(source)
  const x0 = origin.x + Math.round(rect.x)
  const y0 = origin.y + Math.round(rect.y)
  const out = new PNG({ width: Math.round(rect.width), height: Math.round(rect.height) })
  PNG.bitblt(source, out, x0, y0, out.width, out.height, 0, 0)
  writeFileSync(outPath, PNG.sync.write(out))
}

async function checkpoint(name: string, limit: number, bytes: Uint8Array) {
  const outDir = path.join(values.out, name)
  mkdirSync(outDir, { recursive: true })
  const webPng = path.join(outDir, 'web.png')
  const web = await renderWithXtermJs({
    bytes: bytes.subarray(0, limit),
    cols: FIXTURE_COLS,
    rows: FIXTURE_ROWS,
    fontFamily: 'Paper Mono',
    fontFiles: [
      { family: 'Paper Mono', path: TERMINAL_FONT_FILES.regular, weight: 400 },
      { family: 'Paper Mono', path: TERMINAL_FONT_FILES.bold, weight: 700 }
    ],
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    theme: terminalThemeFor('termul') as Record<string, string>,
    scrollback: 10000,
    renderer,
    outPng: webPng
  })
  const windowPng = path.join(outDir, 'gpuix-window.png')
  const gpuix = await runEntry<GpuixReady>({
    entry: 'parity-gpuix',
    args: [
      bytesFile,
      String(limit),
      path.join(outDir, 'gpuix-ready.json'),
      String(FIXTURE_COLS),
      String(FIXTURE_ROWS),
      String(web.cellWidth),
      String(web.cellHeight)
    ],
    readyFile: path.join(outDir, 'gpuix-ready.json'),
    outPng: windowPng,
    settleMs: 500
  })
  const gpuixPng = path.join(outDir, 'gpuix.png')
  cropPng(windowPng, gpuixPng, gpuix.grid)
  const diffPng = path.join(outDir, 'diff.png')
  const pixels = diffPngs(webPng, gpuixPng, diffPng)

  const cellMismatches: string[] = []
  for (let y = 0; y < FIXTURE_ROWS; y++) {
    if (web.cells[y] !== gpuix.cells[y])
      cellMismatches.push(`row ${y}: ${JSON.stringify(web.rows[y])}`)
  }
  const textMismatches = web.rows.flatMap((row, y) =>
    row === gpuix.rows[y]
      ? []
      : [`row ${y}: web=${JSON.stringify(row)} gpuix=${JSON.stringify(gpuix.rows[y])}`]
  )
  const cursorEqual = web.cursor.x === gpuix.cursor.x && web.cursor.y === gpuix.cursor.y
  return {
    checkpoint: name,
    bytes: limit,
    cell: [web.cellWidth, web.cellHeight],
    cellsCompared: FIXTURE_COLS * FIXTURE_ROWS,
    cellRowsEqual: cellMismatches.length === 0,
    cellMismatches,
    textRowsEqual: textMismatches.length === 0,
    textMismatches,
    cursor: { web: web.cursor, gpuix: gpuix.cursor, equal: cursorEqual },
    bufferLength: { web: web.bufferLength, gpuix: gpuix.bufferLength },
    pixels: {
      size: [pixels.width, pixels.height],
      exactPercent: Number(pixels.exact.percent.toFixed(2)),
      perceptualPercent: Number(pixels.perceptual.percent.toFixed(2))
    },
    png: { web: webPng, gpuix: gpuixPng, diff: diffPng },
    firstRows: web.rows.slice(0, 3)
  }
}

const bytes = new Uint8Array(await Bun.file(bytesFile).arrayBuffer())
const offsets = values.bytes
  ? { all: bytes.length }
  : (JSON.parse(readFileSync(FIXTURE_CHECKPOINTS, 'utf8')) as Record<string, number>)
const results = []
for (const name of checkpoints) {
  const limit = offsets[name]
  if (limit === undefined) throw new Error(`no checkpoint ${name} in ${FIXTURE_CHECKPOINTS}`)
  results.push(await checkpoint(name, limit, bytes))
}
const report = { renderer, grid: [FIXTURE_COLS, FIXTURE_ROWS], results }
mkdirSync(values.out, { recursive: true })
writeFileSync(path.join(values.out, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
const failed = results.filter((r) => !r.cellRowsEqual || !r.textRowsEqual || !r.cursor.equal)
if (failed.length) {
  console.error(`CELL PARITY FAILED at ${failed.map((r) => r.checkpoint).join(', ')}`)
  process.exit(1)
}
process.exit(0)
