/**
 * `bun tools/chat/mermaid-controls-check.ts [--port N] [--state DIR]`
 *
 * Behaviour checks of the mermaid card's controls in the launched GPUIX app,
 * on the matrix world's scripted router reply with the webview helper in `dist/`:
 *
 * 1. Zoom in grows the diagram by a tenth of its natural size about the
 *    frame's centre; Zoom out undoes it; Reset returns to the fit.
 * 2. A drag moves the diagram by the pointer travel; the wheel zooms.
 * 3. Download saves `diagram.svg` (an SVG document), `diagram.png` (a PNG
 *    at five times the diagram size) and `diagram.mmd` (the fence source) in
 *    the Downloads folder (`XDG_DOWNLOAD_DIR`).
 *    A second press on Download closes its menu.
 * 4. View fullscreen covers the window with the diagram at its own size
 *    (it fits), and Escape closes it.
 *
 * Exits non-zero on the first failed assertion.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import { APP_DIR, buildClient } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { gpuiKeystrokes } from '../matrix/drive'
import { hostLocalTokenPath } from '../matrix/host-local'
import { createWorld, prepareDevice, setTheme } from '../matrix/world'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import { pickPort } from '../shared/seed'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string' },
    state: { type: 'string', default: '/tmp/gpuix-mermaid-controls' }
  }
})

function assert(check: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${check}: ${detail}`)
  if (!ok) throw new Error(`check failed: ${check} (${detail})`)
}

const FAILURE_PNG = path.join(APP_DIR, 'parity-out/chat/mermaid-controls-failure.png')
const near = (a: number, b: number, tolerance = 1.5) => Math.abs(a - b) <= tolerance
const round = (n: number) => Math.round(n * 10) / 10

type Box = { x: number; y: number; width: number; height: number }

/**
 * The diagram's bounds once they differ from `before` and hold still for 300 ms (a drag's moves
 * render over several frames after the input), or after 3 s.
 */
async function settled(read: () => Promise<Box>, before: Box): Promise<Box> {
  const same = (a: Box, b: Box) => JSON.stringify(a) === JSON.stringify(b)
  let box = await read()
  let still = 0
  for (let i = 0; i < 30 && (same(box, before) || still < 3); i++) {
    await Bun.sleep(100)
    const next = await read()
    still = same(next, box) ? still + 1 : 0
    box = next
  }
  return box
}

const root = values.state as string
const downloads = path.join(root, 'downloads')
await rm(root, { recursive: true, force: true })
mkdirSync(downloads, { recursive: true })
const build = await buildClient()
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
const world = await createWorld({
  port: await pickPort(values.port ? Number(values.port) : undefined),
  root: path.join(root, 'world')
})
try {
  const deviceId = 'mermaid-controls'
  await prepareDevice(world, deviceId)
  await setTheme(world, 'termul', 'dark')
  const clientStateDir = path.join(root, 'client')
  const host = new URL(world.server.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
  mkdirSync(path.join(clientStateDir, 'web-storage'), { recursive: true })
  await Bun.write(
    path.join(clientStateDir, 'web-storage', `${host}.json`),
    JSON.stringify({ 'termul.deviceId': deviceId })
  )
  await withGpuix(
    {
      server: world.server,
      entry: build.entry,
      clientStateDir,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      env: {
        TERMUL_GPUIX_DATA_DIR: path.dirname(hostLocalTokenPath(world)),
        XDG_DOWNLOAD_DIR: downloads
      }
    },
    async ({ app, grab }) => {
      try {
        await app.getByText('What should we do in alpha?').waitFor({ timeoutMs: READY_TIMEOUT_MS })
        // The scripted reply to this prompt ends with the router flowchart, in view.
        await app.getByTestId('composer-editor').click()
        await app.call('keystrokes', { keys: gpuiKeystrokes('Explain the router') })
        await app.call('keystrokes', { keys: 'enter' })
        const diagram = app.getByTestId('chat-mermaid-diagram')
        await diagram.waitFor({ timeoutMs: 30_000 })
        const stage = await app.getByTestId('mermaid-stage-inline').bounds()
        const fit = await diagram.bounds()
        assert(
          'fit',
          near(fit.width, stage.width) && near(fit.height, stage.height),
          `diagram ${round(fit.width)}x${round(fit.height)} in a ${round(stage.width)}x${round(stage.height)} frame`
        )
        const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
        // Automation bounds are clipped to the frame, so every reading below is of a diagram smaller than it.
        const bounds = () => diagram.bounds()

        await app.getByTestId('mermaid-zoom-out').click()
        const smaller = await settled(bounds, fit)
        const ratio = smaller.width / fit.width
        // One step takes 0.1 off the fit zoom, so the ratio gives the fit and the diagram's own width.
        const fitZoom = 0.1 / (1 - ratio)
        const naturalWidth = fit.width / fitZoom
        assert(
          'zoom out',
          smaller.width < fit.width &&
            near(centre(smaller).x, centre(fit).x) &&
            near(centre(smaller).y, centre(fit).y),
          `width ${round(fit.width)} -> ${round(smaller.width)}, fit zoom ${fitZoom.toFixed(3)}, centre kept`
        )

        const from = { x: centre(stage).x + 100, y: centre(stage).y }
        await app.mouse.drag(from, { x: from.x + 40, y: from.y - 8 }, { steps: 4 })
        const dragged = await settled(bounds, smaller)
        assert(
          'drag pans',
          near(dragged.x - smaller.x, 40, 2) && near(dragged.y - smaller.y, -8, 2),
          `moved by ${round(dragged.x - smaller.x)},${round(dragged.y - smaller.y)}`
        )

        // A GPUI wheel delta is the content's motion: negative is the DOM's wheel toward the user.
        await app.mouse.wheel(centre(stage), 0, -1)
        const wheeled = await settled(bounds, dragged)
        assert(
          'wheel toward the user zooms out, to half size at most',
          near(wheeled.width, naturalWidth * Math.max(0.5, fitZoom - 0.2)),
          `width ${round(dragged.width)} -> ${round(wheeled.width)}`
        )
        await app.getByTestId('mermaid-zoom-in').click()
        const larger = await settled(bounds, wheeled)
        assert(
          'zoom in',
          near(larger.width, naturalWidth * (Math.max(0.5, fitZoom - 0.2) + 0.1)),
          `width ${round(wheeled.width)} -> ${round(larger.width)}`
        )
        await app.getByTestId('mermaid-reset-zoom-and-pan').click()
        const reset = await settled(bounds, larger)
        assert(
          'reset',
          near(reset.x, fit.x) && near(reset.y, fit.y) && near(reset.width, fit.width),
          `at ${round(reset.x)},${round(reset.y)}, ${round(reset.width)} wide`
        )

        for (const format of ['SVG', 'PNG', 'MMD']) {
          await app.getByTestId('mermaid-download-diagram').click()
          await app.getByTestId(`mermaid-download-${format.toLowerCase()}`).click()
        }
        const file = (ext: string) => path.join(downloads, `diagram.${ext}`)
        const wait = async (f: string) => {
          for (let i = 0; i < 100 && !existsSync(f); i++) await Bun.sleep(100)
        }
        for (const ext of ['svg', 'png', 'mmd']) await wait(file(ext))
        const svg = existsSync(file('svg')) ? readFileSync(file('svg'), 'utf8') : ''
        assert(
          'download svg',
          svg.startsWith('<svg') && svg.includes('createHashRouter'),
          `${svg.length} chars, starts ${JSON.stringify(svg.slice(0, 20))}`
        )
        const png = existsSync(file('png')) ? PNG.sync.read(readFileSync(file('png'))) : null
        assert(
          'download png',
          png !== null && near(png.width, 5 * naturalWidth, 8),
          png ? `${png.width}x${png.height} px, diagram ${round(naturalWidth)} px wide` : 'missing'
        )
        const mmd = existsSync(file('mmd')) ? readFileSync(file('mmd'), 'utf8') : ''
        assert('download mmd', mmd.startsWith('flowchart LR'), JSON.stringify(mmd.slice(0, 40)))

        const menu = app.getByTestId('mermaid-download-menu')
        await app.getByTestId('mermaid-download-diagram').click()
        const opened = await menu.count()
        await app.getByTestId('mermaid-download-diagram').click()
        for (let i = 0; i < 10 && (await menu.count()) > 0; i++) await Bun.sleep(100)
        assert(
          'download toggles its menu',
          opened === 1 && (await menu.count()) === 0,
          `open ${opened}, after a second press ${await menu.count()}`
        )

        await app.getByTestId('mermaid-view-fullscreen').click()
        const full = app.getByTestId('chat-mermaid-fullscreen')
        await full.waitFor({ timeoutMs: 5000 })
        const fullDiagram = await app.getByTestId('mermaid-stage-fullscreen').bounds()
        assert(
          'fullscreen opens',
          near(fullDiagram.width, WINDOW_WIDTH - 32) &&
            near(fullDiagram.height, WINDOW_HEIGHT - 32),
          `stage ${round(fullDiagram.width)}x${round(fullDiagram.height)}`
        )
        await app.call('keystrokes', { keys: 'escape' })
        for (let i = 0; i < 30 && (await full.count()) > 0; i++) await Bun.sleep(100)
        assert('escape closes fullscreen', (await full.count()) === 0, `${await full.count()} left`)
      } catch (error) {
        await grab(FAILURE_PNG)
        console.log(`frame at the failure: ${FAILURE_PNG}`)
        throw error
      }
    }
  )
} finally {
  await world.server.stop()
  await rm(root, { recursive: true, force: true })
}
