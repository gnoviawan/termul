/**
 * `bun tools/parity/zoom-check.ts [--port N] [--out DIR]`
 *
 * UI zoom in both clients on the seeded workspace. The web client zooms in
 * with its keymap (Alt+=), GPUIX with the desktop one (Ctrl+=); both frames
 * are diffed against each other and against their unzoomed frames, and
 * GPUIX's Ctrl+0 must bring back its unzoomed frame. Needs `bun run
 * build:web` at the repo root. Exits non-zero on a failed assertion.
 */

import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import { buildClient } from '../../build'
import { cropPng, diffPngs, type Rect } from './diff'
import { startTestServer } from './server'
import { type Point, READY_TIMEOUT_MS, windowOrigin, withGpuix } from './shoot-gpuix'
import { withWeb } from './shoot-web'
import { seedWorkspace } from './workspace'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string', default: '8195' },
    'state-dir': { type: 'string' },
    out: { type: 'string', default: path.join(import.meta.dir, '../../parity-out/zoom-check') }
  }
})
const stateDir = values['state-dir'] ?? path.join(os.tmpdir(), 'gpuix-zoom-check', values.port)
const out = values.out
const size = { width: 1280, height: 800 }
const HEADING = 'What should we do in alpha?'
const READY = 'Current checkout'
const ZOOM_SETTLE_MS = 1500
/**
 * The rail and the side panel's top, where the zoomed frames are compared.
 * The web client zooms with CSS `zoom` on the root; `tools/parity/
 * web-zoom-check.ts` checks that its shell and menus stay in place.
 */
const CORNER: Rect = { x: 0, y: 0, width: 520, height: 400 }

const X11_CLICK = path.join(import.meta.dir, '../matrix/x11-click.py')

const png = (name: string) => path.join(out, `${name}.png`)

/** A real X click (XTEST) at a window point: GPUIX automation clicks in window px and would bypass the zoom. */
async function x11Click(
  display: string,
  origin: Point,
  point: Point,
  button: 1 | 3
): Promise<void> {
  const argv = ['uv', 'run', '--quiet', '--with', 'python-xlib==0.33', 'python', '-I', X11_CLICK]
  const proc = Bun.spawn(
    [...argv, String(origin.x + point.x), String(origin.y + point.y), String(button)],
    {
      env: { ...process.env, DISPLAY: display },
      stdout: 'ignore',
      stderr: 'pipe'
    }
  )
  if ((await proc.exited) !== 0)
    throw new Error(`x11-click failed: ${await new Response(proc.stderr).text()}`)
}
let failed = false
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed = true
}
function pct(
  a: string,
  b: string,
  diffName: string,
  region?: Rect
): { exact: number; perceptual: number } {
  if (region) {
    cropPng(png(a), region, png(`${a}-corner`))
    cropPng(png(b), region, png(`${b}-corner`))
    return pct(`${a}-corner`, `${b}-corner`, diffName)
  }
  const result = diffPngs(png(a), png(b), png(diffName))
  return { exact: result.exact.percent, perceptual: result.perceptual.percent }
}

/** The rail's right edge: the first column right of the rail's middle whose pixel differs from it, on row `y`. */
function railEdge(name: string, y = 600): number {
  const image = PNG.sync.read(readFileSync(png(name)))
  const at = (x: number) => image.data.readUInt32BE((y * image.width + x) * 4)
  const fill = at(100)
  for (let x = 101; x < image.width; x++) if (at(x) !== fill) return x
  return -1
}

const build = await buildClient()
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
await mkdir(out, { recursive: true })
let betaAt110: Point = { x: 0, y: 0 }
const server = await startTestServer({
  port: Number(values.port),
  token: 'zoom-token',
  stateDir: path.join(stateDir, 'server')
})
try {
  await seedWorkspace(server)
  await withWeb({ server, ...size }, async ({ page, grab }) => {
    await page.getByText(HEADING).waitFor({ timeout: 30_000 })
    await page.getByText(READY).waitFor({ timeout: 30_000 })
    await grab(png('web-100'))
    await page.keyboard.press('Alt+Equal')
    await page.waitForTimeout(ZOOM_SETTLE_MS)
    await grab(png('web-110'))
    const box = await page.getByText('beta', { exact: true }).first().boundingBox()
    if (!box) throw new Error('web: no beta row at 110%')
    betaAt110 = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.click(betaAt110.x, betaAt110.y, { button: 'right' })
    await page.waitForTimeout(ZOOM_SETTLE_MS)
    await grab(png('web-110-menu'))
    await page.keyboard.press('Escape')
    const zoom = await page.evaluate(() => document.documentElement.style.zoom)
    check(zoom === '1.1', `web Alt+= sets the root zoom to 1.1 (got ${JSON.stringify(zoom)})`)
    await page.keyboard.press('Alt+Digit0')
    await page.waitForTimeout(ZOOM_SETTLE_MS)
  })
  await withGpuix(
    { server, entry: build.entry, clientStateDir: path.join(stateDir, 'client'), ...size },
    async ({ app, display, grab }) => {
      await app.getByText(HEADING).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      await app.getByText(READY).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      await Bun.sleep(ZOOM_SETTLE_MS)
      await grab(png('gpuix-100'))
      await app.call('keystrokes', { keys: 'ctrl-=' })
      await Bun.sleep(ZOOM_SETTLE_MS)
      await grab(png('gpuix-110'))
      const origin = await windowOrigin(display, size.width, size.height)
      await x11Click(display, origin, betaAt110, 1)
      const beta = app.getByText('What should we do in beta?')
      await beta.waitFor({ timeoutMs: 5000 }).catch(() => {})
      check(
        (await beta.count()) === 1,
        `a real click where the zoomed web paints beta (${Math.round(betaAt110.x)},${Math.round(betaAt110.y)}) opens beta in GPUIX`
      )
      await x11Click(display, origin, betaAt110, 3)
      await Bun.sleep(ZOOM_SETTLE_MS)
      await grab(png('gpuix-110-menu'))
      await app.call('keystrokes', { keys: 'escape' })
      await Bun.sleep(400)
      await app.getByTestId('project-item-parity-alpha').click()
      await app.getByText(HEADING).waitFor({ timeoutMs: 5000 })
      await app.call('keystrokes', { keys: 'ctrl-0' })
      await Bun.sleep(ZOOM_SETTLE_MS)
      await grab(png('gpuix-reset'))
      check(
        (await app.getByText(HEADING).count()) === 1,
        'GPUIX dashboard still painted after Ctrl+0'
      )
    }
  )
  const base = pct('web-100', 'gpuix-100', 'diff-100', CORNER)
  const zoomed = pct('web-110', 'gpuix-110', 'diff-110', CORNER)
  const gpuixMoved = pct('gpuix-100', 'gpuix-110', 'diff-gpuix-zoom')
  const webMoved = pct('web-100', 'web-110', 'diff-web-zoom')
  const reset = pct('gpuix-100', 'gpuix-reset', 'diff-gpuix-reset')
  console.log(
    `    web vs GPUIX corner at 100%: ${base.exact.toFixed(1)}% / ${base.perceptual.toFixed(2)}%`
  )
  console.log(
    `    web vs GPUIX corner at 110%: ${zoomed.exact.toFixed(1)}% / ${zoomed.perceptual.toFixed(2)}%`
  )
  console.log(
    `    zoom moved web ${webMoved.perceptual.toFixed(2)}%, GPUIX ${gpuixMoved.perceptual.toFixed(2)}% (perceptual)`
  )
  console.log(
    `    GPUIX Ctrl+0 vs start: ${reset.exact.toFixed(2)}% / ${reset.perceptual.toFixed(2)}%`
  )
  check(
    gpuixMoved.perceptual > webMoved.perceptual / 2,
    'GPUIX Ctrl+= rescales the window about as much as the web zoom does'
  )
  const edges = {
    web100: railEdge('web-100'),
    gpuix100: railEdge('gpuix-100'),
    web110: railEdge('web-110'),
    gpuix110: railEdge('gpuix-110')
  }
  console.log(
    `    rail edge x: web ${edges.web100} -> ${edges.web110}, GPUIX ${edges.gpuix100} -> ${edges.gpuix110}`
  )
  check(Math.abs(edges.web110 - edges.gpuix110) <= 1, 'zoomed rail is as wide in both clients')
  check(edges.gpuix110 > edges.gpuix100, 'GPUIX zoom widens the rail')
  check(
    zoomed.perceptual < 5,
    'zoomed corners stay close (text rasterizes at fractional positions)'
  )
  check(reset.perceptual < 0.2, 'GPUIX Ctrl+0 restores the unzoomed frame')
  console.log(`    frames: ${out}`)
} catch (error) {
  failed = true
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server.stop()
  await rm(stateDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
