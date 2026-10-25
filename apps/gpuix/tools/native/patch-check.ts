/**
 * On-screen check of Termul's @gpuix/native patches. Runs `patch-scene.tsx`
 * under Xvfb + lavapipe with whatever addon NAPI_RS_NATIVE_LIBRARY_PATH picks,
 * grabs the window and asserts what each patch paints:
 *
 *   0001-font-style        `fontStyle: 'italic'` slants Paper Mono strokes
 *   0002-markdown-theme    a markdown link paints in `theme.link`;
 *                          `mdInlineCodeScale: 0.5` halves inline-code glyphs
 *   0003-window-handle     `getNativeWindowHandle()` names this X11 window
 *
 * On the published addon every assertion fails, which is what makes it a test.
 *
 * NAPI_RS_NATIVE_LIBRARY_PATH=native/gpuix-native/build/gpuix-native.linux-x64-gnu.node \
 *   bun tools/native/patch-check.ts [--out DIR]
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import { grabFrame, LAVAPIPE_ICD, SCREEN_MARGIN, startXvfb, windowOrigin } from '../parity/shoot-gpuix'
import { SCENE, type Sample, type SceneReady } from './samples'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: '/tmp/gpuix-native-patch-check' } }
})
const out = path.resolve(values.out as string)
mkdirSync(out, { recursive: true })
const readyFile = path.join(out, 'ready.json')
const shot = path.join(out, 'scene.png')
if (existsSync(readyFile)) unlinkSync(readyFile)

const xvfb = await startXvfb(SCENE.width + SCREEN_MARGIN, SCENE.height + SCREEN_MARGIN)
const scene = Bun.spawn(['bun', path.join(import.meta.dir, 'patch-scene.tsx'), readyFile], {
  env: {
    ...process.env,
    DISPLAY: xvfb.display,
    VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
    GPUIX_BACKGROUND: '1'
  },
  stdout: 'inherit',
  stderr: 'inherit'
})
let ready: SceneReady
let xwininfo: string
try {
  const deadline = Date.now() + 60_000
  while (!existsSync(readyFile)) {
    if (scene.exitCode !== null) throw new Error(`patch scene exited ${scene.exitCode}`)
    if (Date.now() > deadline) throw new Error('patch scene never wrote its ready file')
    await Bun.sleep(50)
  }
  await Bun.sleep(300)
  const origin = await windowOrigin(xvfb.display, SCENE.width, SCENE.height)
  await grabFrame(xvfb.display, SCENE.width, SCENE.height, shot, origin)
  ready = JSON.parse(readFileSync(readyFile, 'utf8')) as SceneReady
  xwininfo = Bun.spawnSync(['xwininfo', '-root', '-tree', '-display', xvfb.display]).stdout.toString()
} finally {
  scene.kill()
  await scene.exited
  xvfb.stop()
}

const png = PNG.sync.read(readFileSync(shot))
const pixel = (x: number, y: number) => {
  const i = (y * png.width + x) * 4
  return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0] as const
}
function region(sample: Sample) {
  const b = ready.bounds[sample]
  if (!b) throw new Error(`${sample} has no bounds`)
  return { x0: Math.round(b.x), y0: Math.round(b.y), x1: Math.round(b.x + b.width), y1: Math.round(b.y + b.height) }
}
const lit = ([r, g, b]: readonly [number, number, number]) => r + g + b > 384

/** Mean x of lit pixels in the top third of the ink minus the bottom third, per pixel of height. */
function slant(sample: Sample): number {
  const { x0, y0, x1, y1 } = region(sample)
  const rows: Array<{ y: number; xs: number[] }> = []
  for (let y = y0; y < y1; y++) {
    const xs: number[] = []
    for (let x = x0; x < x1; x++) if (lit(pixel(x, y))) xs.push(x)
    if (xs.length) rows.push({ y, xs })
  }
  const third = Math.max(1, Math.floor(rows.length / 3))
  const mean = (part: typeof rows) => {
    const xs = part.flatMap((r) => r.xs)
    return xs.reduce((a, b) => a + b, 0) / xs.length
  }
  const top = rows.slice(0, third)
  const bottom = rows.slice(-third)
  const dy = (bottom.at(-1)?.y ?? 0) - (top[0]?.y ?? 0) - third
  return (mean(top) - mean(bottom)) / Math.max(1, dy)
}

function count(sample: Sample, test: (rgb: readonly [number, number, number]) => boolean): number {
  const { x0, y0, x1, y1 } = region(sample)
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (test(pixel(x, y))) n++
  return n
}

function inkWidth(sample: Sample): number {
  const { x0, y0, x1, y1 } = region(sample)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (lit(pixel(x, y))) {
        min = Math.min(min, x)
        max = Math.max(max, x)
      }
  return max >= min ? max - min + 1 : 0
}

const uprightSlant = slant('upright')
const italicSlant = slant('italic')
const linkRed = count('link', ([r, g, b]) => r > 160 && g < 90 && b < 90)
const codeRatio = inkWidth('codeHalf') / Math.max(1, inkWidth('codeFull'))
const handleId = ready.handle?.kind === 'x11' ? ready.handle.id : null
const handleWindow =
  typeof handleId === 'number'
    ? (xwininfo.match(new RegExp(`0x${handleId.toString(16)} "termul-native-patch-check".*${SCENE.width}x${SCENE.height}`)) ?? null)
    : null

const checks = [
  { patch: '0001-font-style', what: 'upright strokes stand straight', value: uprightSlant, ok: Math.abs(uprightSlant) < 0.05 },
  { patch: '0001-font-style', what: "fontStyle 'italic' slants strokes (Blink oblique is 0.25)", value: italicSlant, ok: italicSlant > 0.15 && italicSlant < 0.35 },
  { patch: '0002-markdown-theme', what: 'link pixels in theme.link red', value: linkRed, ok: linkRed > 100 },
  { patch: '0002-markdown-theme', what: 'mdInlineCodeScale 0.5 halves the code ink width', value: codeRatio, ok: codeRatio > 0.4 && codeRatio < 0.6 },
  { patch: '0003-window-handle', what: 'getNativeWindowHandle names the scene window', value: ready.handle, ok: handleWindow !== null }
]
for (const check of checks)
  console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.patch} ${check.what}: ${JSON.stringify(check.value)}`)
console.log(`screenshot ${shot}`)
if (checks.some((check) => !check.ok)) process.exit(1)
