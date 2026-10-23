/**
 * Throughput bench: time to parse and paint `seq 1 200000` and a 5 MB
 * random-printable file, fed from memory in 64 KB chunks, in GPUIX
 * (TerminalView under Xvfb + lavapipe) and in xterm.js (headless Chromium).
 * Same grid, font, size, theme and chunking on both sides. Runs alternate
 * A, B, A, B so warmup and drift favour neither; the visible rows must match
 * on every run or the run is counted as an error.
 *
 * bun tools/terminal/throughput.ts [outDir] [runs]
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  TERMINAL_FONT_FILES,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT
} from '../../src/terminal/fonts'
import { terminalThemeFor } from '../../src/terminal/theme'
import { FIXTURE_COLS, FIXTURE_ROWS } from './fixture'
import { renderWithXtermJs } from './xterm-chromium'
import { gpuixEnv, startXvfb } from './xvfb'

const CHUNK_BYTES = 65536
const CELL = { width: 8, height: 19 }

interface Sample {
  writeMs: number
  paintMs: number
  rows: string[]
  bufferLength: number
}

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export async function makeInputs(dir: string): Promise<Record<string, string>> {
  mkdirSync(dir, { recursive: true })
  const seqPath = resolve(dir, 'seq-200000.bin')
  if (!existsSync(seqPath)) {
    const proc = Bun.spawn(['seq', '1', '200000'], { stdout: 'pipe' })
    writeFileSync(seqPath, new Uint8Array(await new Response(proc.stdout).arrayBuffer()))
  }
  const randomPath = resolve(dir, 'random-5mb.bin')
  if (!existsSync(randomPath)) {
    const size = 5 * 1024 * 1024
    const out = new Uint8Array(size)
    const next = seeded(0x5eed)
    let column = 0
    let lineLength = 1 + Math.floor(next() * 120)
    for (let i = 0; i < size; i++) {
      if (column >= lineLength) {
        out[i] = 0x0a
        column = 0
        lineLength = 1 + Math.floor(next() * 120)
      } else {
        out[i] = 0x20 + Math.floor(next() * 95)
        column++
      }
    }
    writeFileSync(randomPath, out)
  }
  return { seq: seqPath, random: randomPath }
}

async function runGpuix(input: string, outDir: string): Promise<Sample> {
  const resultFile = resolve(outDir, 'gpuix-result.json')
  if (existsSync(resultFile)) unlinkSync(resultFile)
  const xvfb = await startXvfb()
  const app = Bun.spawn(
    [
      'bun',
      resolve(import.meta.dir, 'throughput-gpuix.tsx'),
      input,
      resultFile,
      String(FIXTURE_COLS),
      String(FIXTURE_ROWS),
      String(CELL.width),
      String(CELL.height),
      String(CHUNK_BYTES)
    ],
    { env: gpuixEnv(xvfb.display), stdout: 'ignore', stderr: 'ignore' }
  )
  try {
    const deadline = Date.now() + 120_000
    while (!existsSync(resultFile)) {
      if (Date.now() > deadline) throw new Error('GPUIX bench timed out')
      if (app.exitCode !== null)
        throw new Error(`GPUIX bench exited ${app.exitCode} without a result`)
      await Bun.sleep(50)
    }
    await Bun.sleep(100)
    return (await Bun.file(resultFile).json()) as Sample
  } finally {
    app.kill()
    xvfb.stop()
  }
}

async function runWeb(input: string, outDir: string): Promise<Sample> {
  const result = await renderWithXtermJs({
    bytes: new Uint8Array(await Bun.file(input).arrayBuffer()),
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
    chunkSize: CHUNK_BYTES,
    renderer: 'webgl',
    timing: true,
    outPng: resolve(outDir, 'web-last.png')
  })
  return {
    writeMs: result.writeMs ?? Number.NaN,
    paintMs: result.renderMs ?? Number.NaN,
    rows: result.rows,
    bufferLength: result.bufferLength
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const summary = (values: number[]) => ({
  median: Math.round(median(values)),
  min: Math.round(Math.min(...values)),
  max: Math.round(Math.max(...values)),
  runs: values.length
})

export async function runThroughput(outDir = '/tmp/gpuix-t1/throughput', runs = 5) {
  mkdirSync(outDir, { recursive: true })
  const inputs = await makeInputs(outDir)
  const load = await new Response(Bun.spawn(['uptime'], { stdout: 'pipe' }).stdout).text()
  const report: Record<string, unknown> = {
    host: { cores: navigator.hardwareConcurrency, uptime: load.trim() },
    chunkBytes: CHUNK_BYTES,
    grid: [FIXTURE_COLS, FIXTURE_ROWS],
    cell: CELL
  }
  for (const [name, input] of Object.entries(inputs)) {
    const gpuix: Sample[] = []
    const web: Sample[] = []
    const errors: string[] = []
    for (let i = 0; i < runs; i++) {
      const order = i % 2 === 0 ? (['gpuix', 'web'] as const) : (['web', 'gpuix'] as const)
      for (const side of order) {
        try {
          const sample =
            side === 'gpuix' ? await runGpuix(input, outDir) : await runWeb(input, outDir)
          ;(side === 'gpuix' ? gpuix : web).push(sample)
          console.error(
            `${name} ${side} run ${i + 1}: write ${Math.round(sample.writeMs)} ms, paint ${Math.round(sample.paintMs)} ms`
          )
        } catch (error) {
          errors.push(`${side} run ${i + 1}: ${String(error)}`)
        }
      }
    }
    const rowsAgree =
      gpuix.length > 0 &&
      web.length > 0 &&
      gpuix.every((g) => g.rows.join('\n') === web[0]!.rows.join('\n')) &&
      web.every((w) => w.rows.join('\n') === web[0]!.rows.join('\n'))
    const bytes = await Bun.file(input).size
    report[name] = {
      bytes,
      bufferLength: { gpuix: gpuix[0]?.bufferLength, web: web[0]?.bufferLength },
      lastRows: web[0]?.rows.slice(-3),
      rowsAgree,
      errors,
      gpuix: {
        writeMs: summary(gpuix.map((s) => s.writeMs)),
        paintMs: summary(gpuix.map((s) => s.paintMs)),
        mbPerSecondPaint: Number(
          (bytes / 1048576 / (median(gpuix.map((s) => s.paintMs)) / 1000)).toFixed(2)
        )
      },
      web: {
        writeMs: summary(web.map((s) => s.writeMs)),
        paintMs: summary(web.map((s) => s.paintMs)),
        mbPerSecondPaint: Number(
          (bytes / 1048576 / (median(web.map((s) => s.paintMs)) / 1000)).toFixed(2)
        )
      }
    }
  }
  const reportPath = resolve(outDir, 'report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  console.log(`report: ${reportPath}`)
  return report
}

if (import.meta.main) {
  await runThroughput(process.argv[2], Number(process.argv[3] ?? 5))
  process.exit(0)
}
