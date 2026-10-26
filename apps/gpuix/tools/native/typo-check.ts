/**
 * Typography against Chromium: paints `typo-samples.ts` in GPUIX (Xvfb +
 * lavapipe, whatever addon NAPI_RS_NATIVE_LIBRARY_PATH picks) and in
 * Playwright Chromium with the web client's Inter Variable, then compares the
 * two frames:
 *
 *   pitch   the mean distance between the ink bands of wrapped lines
 *           (13px/19.5 and Tailwind text-xs leading-relaxed); Chromium sets
 *           them 19.5 px apart, rounding each line at paint
 *   lines   the top of every line's ink, GPUIX minus Chromium
 *   run     the ink width of one line at 12, 13 and 14 px
 *
 * `--hinting` is Chromium's --font-render-hinting. Headless Chromium
 * defaults to `full`, which lays text out on FreeType-hinted whole-pixel
 * advances; desktop Chrome follows fontconfig, `slight` on stock GNOME and
 * Ubuntu, and lays out the font's own fractional advances.
 *
 * bun tools/native/typo-check.ts [--out DIR] [--hinting full|slight|...]
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import {
  grabFrame,
  LAVAPIPE_ICD,
  SCREEN_MARGIN,
  startXvfb,
  windowOrigin
} from '../parity/shoot-gpuix'
import {
  FULLSCREEN_TABLE_SAMPLE,
  MARKER_LINE,
  MARKER_SAMPLES,
  TABLE_SAMPLE,
  TEXT_SAMPLES,
  type TextSample,
  TYPO_WINDOW,
  type TypoReady,
  type TypoRow,
  typoHtml,
  WASH_LEFT,
  WASH_SAMPLES,
  type WashSample
} from './typo-samples'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-native-typo-check' },
    hinting: { type: 'string', default: 'slight' }
  }
})
const out = path.resolve(values.out as string)
mkdirSync(out, { recursive: true })
const INTER_WOFF2 = path.resolve(
  import.meta.dir,
  '../../../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'
)
const PAPER_MONO_WOFF2 = path.resolve(
  import.meta.dir,
  '../../../../src/renderer/assets/fonts/paper-mono/PaperMono[wght].woff2'
)
const { width: W, height: H } = TYPO_WINDOW

async function shootGpuix(): Promise<{ png: string; ready: TypoReady }> {
  const readyFile = path.join(out, 'ready.json')
  const png = path.join(out, 'gpuix.png')
  if (existsSync(readyFile)) unlinkSync(readyFile)
  const xvfb = await startXvfb(W + SCREEN_MARGIN, H + SCREEN_MARGIN)
  const scene = Bun.spawn(['bun', path.join(import.meta.dir, 'typo-scene.tsx'), readyFile], {
    env: {
      ...process.env,
      DISPLAY: xvfb.display,
      VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
      GPUIX_BACKGROUND: '1'
    },
    stdout: 'inherit',
    stderr: 'inherit'
  })
  try {
    const deadline = Date.now() + 60_000
    while (!existsSync(readyFile)) {
      if (scene.exitCode !== null) throw new Error(`typo scene exited ${scene.exitCode}`)
      if (Date.now() > deadline) throw new Error('typo scene never wrote its ready file')
      await Bun.sleep(50)
    }
    await Bun.sleep(300)
    await grabFrame(xvfb.display, W, H, png, await windowOrigin(xvfb.display, W, H))
    return { png, ready: JSON.parse(readFileSync(readyFile, 'utf8')) as TypoReady }
  } finally {
    scene.kill()
    await scene.exited
    xvfb.stop()
  }
}

async function shootWeb(hinting: string): Promise<string> {
  const png = path.join(out, `web-${hinting}.png`)
  const browser = await chromium.launch({ args: [`--font-render-hinting=${hinting}`] })
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
    const font = (file: string) => `data:font/woff2;base64,${readFileSync(file).toString('base64')}`
    await page.setContent(typoHtml(font(INTER_WOFF2), font(PAPER_MONO_WOFF2)))
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: png })
  } finally {
    await browser.close()
  }
  return png
}

type Png = PNG
const lit = (png: Png, x: number, y: number) => {
  const i = (y * png.width + x) * 4
  return (png.data[i] ?? 0) + (png.data[i + 1] ?? 0) + (png.data[i + 2] ?? 0) > 3 * 96
}

/** The region a sample can paint in; the same rectangle in both frames. */
function box(s: TextSample): { x0: number; y0: number; x1: number; y1: number } {
  const lines = s.stack ?? (s.width ? 10 : 1)
  return {
    x0: s.left,
    y0: s.top,
    x1: Math.min(W, s.left + (s.width ?? W - s.left - 8)),
    y1: Math.min(H, Math.ceil(s.top + lines * s.lineHeight + 4))
  }
}

/** Top row of each contiguous band of rows holding ink. */
function bandTops(png: Png, s: TextSample): number[] {
  const { x0, y0, x1, y1 } = box(s)
  const tops: number[] = []
  let inBand = false
  for (let y = y0; y < y1; y++) {
    let ink = false
    for (let x = x0; x < x1 && !ink; x++) ink = lit(png, x, y)
    if (ink && !inBand) tops.push(y)
    inBand = ink
  }
  return tops
}

function inkWidth(png: Png, s: TextSample): number {
  const { x0, y0, x1, y1 } = box(s)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (lit(png, x, y)) {
        min = Math.min(min, x)
        max = Math.max(max, x)
      }
  return max >= min ? max - min + 1 : 0
}

const pitchOf = (tops: number[]) =>
  tops.length > 1 ? ((tops.at(-1) ?? 0) - (tops[0] ?? 0)) / (tops.length - 1) : 0
const round2 = (n: number) => Math.round(n * 100) / 100

const gpuix = await shootGpuix()
const webPng = await shootWeb(values.hinting as string)
const g = PNG.sync.read(readFileSync(gpuix.png))
const w = PNG.sync.read(readFileSync(webPng))

const rows: TypoRow[] = []
for (const s of TEXT_SAMPLES) {
  if (s.id.startsWith('run')) {
    const gw = inkWidth(g, s)
    const ww = inkWidth(w, s)
    const ratio = gw / Math.max(1, ww)
    rows.push({
      patch: 'run-width',
      what: `${s.id} ink width, GPUIX ${gw} / Chromium ${ww} (within 0.3%)`,
      value: round2(ratio),
      ok: Math.abs(ratio - 1) <= 0.003
    })
    continue
  }
  const gt = bandTops(g, s)
  const wt = bandTops(w, s)
  const pitch = pitchOf(gt)
  rows.push({
    patch: '0005-fractional-line-height',
    what: `${s.id} line pitch ${s.fontSize}px/${s.lineHeight} over ${gt.length} lines (Chromium ${round2(pitchOf(wt))} over ${wt.length})`,
    value: round2(pitch),
    ok: Math.abs(pitch - s.lineHeight) <= 0.1
  })
  const offsets = gt.map((top, i) => top - (wt[i] ?? Number.NaN))
  rows.push({
    patch: '0005-fractional-line-height',
    what: `${s.id} line tops, GPUIX minus Chromium (each within 1 px)`,
    value: offsets,
    ok: gt.length === wt.length && offsets.every((d) => Math.abs(d) <= 1)
  })
}
/** x where each header label's ink starts: ink runs on the header row, split at gaps over 12 px. */
function headerStarts(
  png: Png,
  { left, top, width }: { left: number; top: number; width: number }
): number[] {
  const x0 = left + 2
  const x1 = left + width - 2
  const tops = bandTops(png, {
    id: 'table',
    left: x0,
    top: top + 2,
    width: x1 - x0,
    fontSize: 14,
    lineHeight: 20,
    text: '',
    stack: 1
  })
  const y0 = tops[0] ?? top
  const starts: number[] = []
  let last = Number.NEGATIVE_INFINITY
  for (let x = x0; x < x1; x++) {
    let ink = false
    for (let y = y0; y < y0 + 12 && !ink; y++) ink = lit(png, x, y)
    if (!ink) continue
    if (x - last > 12) starts.push(x)
    last = x
  }
  return starts
}
for (const [name, sample] of [
  ['transcript', TABLE_SAMPLE],
  ['fullscreen', FULLSCREEN_TABLE_SAMPLE]
] as const) {
  const gh = headerStarts(g, sample)
  const wh = headerStarts(w, sample)
  const dx = gh.map((x, i) => x - (wh[i] ?? Number.NaN))
  rows.push({
    patch: 'table-columns',
    what: `${name} table header labels start at ${JSON.stringify(gh)} (Chromium ${JSON.stringify(wh)}), GPUIX minus Chromium (each within 1 px)`,
    value: dx,
    ok: gh.length === wh.length && dx.every((d) => Math.abs(d) <= 1)
  })
}
type Channel = 0 | 1 | 2
/** Rows of a table where its rule colour (one channel lit) spans most of its width. */
function ruleRows(
  png: Png,
  { left, top, width }: { left: number; top: number; width: number },
  channel: Channel
): number[] {
  const out: number[] = []
  for (let y = top - 2; y < Math.min(H, top + 240); y++) {
    let n = 0
    for (let x = left; x < left + width; x++) {
      const i = (y * png.width + x) * 4
      const on = (png.data[i + channel] ?? 0) > 150
      const off = ([0, 1, 2] as const).every((c) => c === channel || (png.data[i + c] ?? 0) < 90)
      if (on && off) n++
    }
    if (n > width / 2) out.push(y)
  }
  return out
}
for (const [name, sample, channel, patch] of [
  ['fullscreen table rules (outer border and body rules)', FULLSCREEN_TABLE_SAMPLE, 1, 'table-rules'],
  ['transcript table rules, 30.6 px apart in Chromium', TABLE_SAMPLE, 2, '0014-table-fractional-cell-padding']
] as const) {
  const gr = ruleRows(g, sample, channel)
  const wr = ruleRows(w, sample, channel)
  const dr = gr.map((y, i) => y - (wr[i] ?? Number.NaN))
  rows.push({
    patch,
    what: `${name} at y ${JSON.stringify(gr)} (Chromium ${JSON.stringify(wr)}), GPUIX minus Chromium (each within 1 px)`,
    value: dr,
    ok: gr.length === wr.length && gr.length > 0 && dr.every((d) => Math.abs(d) <= 1)
  })
}
/** The last column holding ink on a marker sample's line. */
function inkRight(png: Png, { left, top }: { left: number; top: number }): number {
  let right = -1
  for (let y = top; y < top + MARKER_LINE; y++)
    for (let x = left; x < Math.min(W, left + 200); x++) if (lit(png, x, y)) right = Math.max(right, x)
  return right
}
for (const s of MARKER_SAMPLES) {
  const gx = inkRight(g, s)
  const wx = inkRight(w, s)
  rows.push({
    patch: '0015-markdown-lead-tabular-nums',
    what: `ordered item "${s.n}. ${s.text}" ink ends at x ${gx} (Chromium ${wx}), GPUIX minus Chromium (within 1 px)`,
    value: gx - wx,
    ok: gx > 0 && wx > 0 && Math.abs(gx - wx) <= 1
  })
}
/**
 * [left, right] of each run of columns holding the wash colour on a third of
 * the sample's line or more (subpixel text fringes are red for a pixel or two).
 */
function washSpans(png: Png, s: WashSample): Array<[number, number]> {
  const red = (x: number, y: number) => {
    const i = (y * png.width + x) * 4
    return (png.data[i] ?? 0) > 120 && (png.data[i + 1] ?? 0) < 70 && (png.data[i + 2] ?? 0) < 70
  }
  const spans: Array<[number, number]> = []
  for (let x = WASH_LEFT; x < W - 8; x++) {
    let rows = 0
    for (let y = s.top; y < s.top + s.lineHeight; y++) if (red(x, y)) rows++
    if (rows < s.lineHeight / 3) continue
    const last = spans.at(-1)
    if (last && x - last[1] <= 1) last[1] = x
    else spans.push([x, x])
  }
  return spans.filter(([l, r]) => r - l >= 3)
}
for (const s of WASH_SAMPLES) {
  const gs = washSpans(g, s)
  const ws = washSpans(w, s)
  const dx = gs.flatMap(([l, r], i) => [
    l - (ws[i]?.[0] ?? Number.NaN),
    r - (ws[i]?.[1] ?? Number.NaN)
  ])
  rows.push({
    patch: 'inline-code-wash',
    what: `${s.id} chip washes span ${JSON.stringify(gs)} (Chromium ${JSON.stringify(ws)}), left and right edges GPUIX minus Chromium (each within 1 px)`,
    value: dx,
    ok: gs.length === ws.length && gs.length > 0 && dx.every((d) => Math.abs(d) <= 1)
  })
}
for (const row of rows)
  console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.what}: ${JSON.stringify(row.value)}`)
console.log(`screenshots ${gpuix.png} ${webPng}`)
writeFileSync(path.join(out, 'rows.json'), JSON.stringify(rows))
if (rows.some((row) => !row.ok)) process.exit(1)
