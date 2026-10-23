/**
 * Web vs GPUIX shot of the same workspace terminal tab at 1280x800: the DOM
 * web client (this worktree's dist-web, Playwright chromium) opens a terminal
 * from the tab bar's New tab menu; the GPUIX pane scene opens one through
 * spawnTerminalInPane with its pane body at the box the web pane occupies.
 * Both shells then `cat` T1's recorded fixture up to its `done` checkpoint,
 * so both grids hold the same bytes at the same size. The pane box is
 * cropped from both window shots and diffed (exact and perceptual).
 *
 * bun tools/terminal/pane-parity.ts [--out /tmp/gpuix-o1/parity]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launch } from '@gpuix/react/automation'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { APP_DIR } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { diffPngs } from '../parity/diff'
import { addProject, startTestServer } from '../parity/server'
import { grabFrame, LAVAPIPE_ICD, SCREEN_MARGIN, windowOrigin } from '../parity/shoot-gpuix'
import { DIST_WEB } from '../parity/shoot-web'
import { FIXTURE_BYTES, FIXTURE_CHECKPOINTS } from './fixture'
import { buildScene } from './scene/build'
import type { PaneSceneState } from './scene/contract'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-o1/parity' },
    root: { type: 'string', default: '/tmp/gpuix-o1/parity-state' },
    checkpoint: { type: 'string', default: 'done' }
  }
})
const OUT = values.out!
const ROOT = values.root!
mkdirSync(OUT, { recursive: true })
if (!existsSync(path.join(DIST_WEB, 'index.html')))
  throw new Error(`${DIST_WEB} has no index.html: run \`bun run build:web\` at the repo root`)

function freePort(): number {
  const listening = Bun.spawnSync(['ss', '-ltnH']).stdout.toString()
  for (let port = 8190; port <= 8199; port++) if (!listening.includes(`:${port} `)) return port
  throw new Error('no free port in 8190-8199')
}

function freeDisplay(): number {
  for (let n = 150; n < 250; n++)
    if (!existsSync(`/tmp/.X${n}-lock`) && !existsSync(`/tmp/.X11-unix/X${n}`)) return n
  throw new Error('no free X display in :150-:249')
}

function crop(
  file: string,
  box: { x: number; y: number; width: number; height: number },
  out: string
) {
  const source = PNG.sync.read(readFileSync(file))
  const target = new PNG({ width: box.width, height: box.height })
  PNG.bitblt(source, target, box.x, box.y, box.width, box.height, 0, 0)
  writeFileSync(out, PNG.sync.write(target))
}

const token = 'o1-parity-token'
const server = await startTestServer({
  port: freePort(),
  token,
  stateDir: path.join(ROOT, 'server')
})
const project = { id: 'o1-parity', name: 'Parity', path: path.join(ROOT, 'project'), color: 'blue' }
await addProject(server, project)
const offsets = JSON.parse(readFileSync(FIXTURE_CHECKPOINTS, 'utf8')) as Record<string, number>
const limit = offsets[values.checkpoint!]
if (limit === undefined) throw new Error(`no checkpoint ${values.checkpoint}`)
const fixture = path.join(project.path, 'fixture.out')
writeFileSync(fixture, new Uint8Array(readFileSync(FIXTURE_BYTES)).subarray(0, limit))
const COMMAND = 'clear; cat fixture.out'
const SETTLE_MS = 2500

// Web: the real app shell, New tab -> Terminal.
const browser = await chromium.launch({
  args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks']
})
let box: { x: number; y: number; width: number; height: number }
const webPng = path.join(OUT, 'web-window.png')
try {
  const context = await browser.newContext({
    viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block'
  })
  await context.route(`${server.baseUrl}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const file = path.join(DIST_WEB, url.pathname === '/' ? 'index.html' : url.pathname)
    if (
      request.method() === 'GET' &&
      file.startsWith(DIST_WEB) &&
      existsSync(file) &&
      !file.endsWith(path.sep)
    ) {
      await route.fulfill({ path: file })
      return
    }
    await route.continue()
  })
  await context.addInitScript((t) => localStorage.setItem('termul.webAuthToken', t), token)
  const page = await context.newPage()
  await page.goto(server.baseUrl)
  const projectButton = page.getByText(project.name, { exact: true }).first()
  await projectButton.waitFor({ timeout: 30_000 })
  await projectButton.click()
  await page.getByRole('button', { name: 'New tab' }).first().click()
  await page.getByRole('group', { name: 'Terminal' }).getByRole('menuitem').first().click()
  const pane = page.locator('div.bg-terminal-bg:has(.xterm)').first()
  await pane.waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  await page.locator('.xterm').first().click()
  await page.keyboard.type(COMMAND)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(SETTLE_MS)
  await page.mouse.move(0, 0)
  const rect = (await pane.boundingBox())!
  box = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
  await page.screenshot({ path: webPng })
} finally {
  await browser.close()
}

// GPUIX: the pane scene with its body at the web pane's box.
const entry = await buildScene()
const control = path.join(ROOT, 'control.json')
const stateFile = path.join(ROOT, 'state.json')
rmSync(control, { force: true })
rmSync(stateFile, { force: true })
const display = `:${freeDisplay()}`
const xvfb = Bun.spawn(
  [
    'Xvfb',
    display,
    '-nocursor',
    '-screen',
    '0',
    `${WINDOW_WIDTH + SCREEN_MARGIN}x${WINDOW_HEIGHT + SCREEN_MARGIN}x24`
  ],
  {
    stdout: 'ignore',
    stderr: 'ignore'
  }
)
const gpuixPng = path.join(OUT, 'gpuix-window.png')
let rows: string[] = []
try {
  while (!existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) await Bun.sleep(50)
  const app = await launch({
    command: 'bun',
    args: [entry],
    cwd: APP_DIR,
    env: {
      ...process.env,
      DISPLAY: display,
      VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
      GPUIX_BACKGROUND: '1',
      TERMUL_SERVER_URL: server.baseUrl,
      TERMUL_SERVER_TOKEN: token,
      TERMUL_GPUIX_STATE_DIR: path.join(ROOT, 'client'),
      PANE_CONTROL: control,
      PANE_STATE: stateFile,
      PANE_BOX: `${box.x},${box.y},${box.width},${box.height}`
    }
  })
  try {
    writeFileSync(
      control,
      JSON.stringify({ seq: 1, open: { projectId: project.id, cwd: project.path } })
    )
    const read = () => {
      try {
        return JSON.parse(readFileSync(stateFile, 'utf8')) as PaneSceneState
      } catch {
        return null
      }
    }
    const deadline = Date.now() + 30_000
    let terminal = read()?.terminals[0]
    while (!terminal?.grid || !terminal.visibleText.some((r) => r.trim())) {
      if (Date.now() > deadline) throw new Error('GPUIX terminal never showed a prompt')
      await Bun.sleep(100)
      terminal = read()?.terminals[0]
    }
    const node = await app.getByTestId(`terminal-${terminal.storeId}`).element()
    const keys = [...COMMAND].map((ch) => (ch === ' ' ? 'space' : ch)).join(' ')
    await app.call('keystrokes', { elementId: node.id, keys: `${keys} enter` })
    await Bun.sleep(SETTLE_MS)
    rows = read()?.terminals[0]?.visibleText ?? []
    const origin = await windowOrigin(display, WINDOW_WIDTH, WINDOW_HEIGHT)
    await grabFrame(display, WINDOW_WIDTH, WINDOW_HEIGHT, gpuixPng, origin)
  } finally {
    await app.close()
  }
} finally {
  xvfb.kill()
  await server.stop()
}

const webCrop = path.join(OUT, 'web.png')
const gpuixCrop = path.join(OUT, 'gpuix.png')
crop(webPng, box, webCrop)
crop(gpuixPng, box, gpuixCrop)
const pixels = diffPngs(webCrop, gpuixCrop, path.join(OUT, 'diff.png'))
const report = {
  box,
  checkpoint: values.checkpoint,
  gpuixRows: rows.filter((r) => r.trim()).length,
  pixels: {
    size: [pixels.width, pixels.height],
    exactPercent: Number(pixels.exact.percent.toFixed(2)),
    perceptualPercent: Number(pixels.perceptual.percent.toFixed(2))
  },
  png: {
    web: webCrop,
    gpuix: gpuixCrop,
    diff: path.join(OUT, 'diff.png'),
    webWindow: webPng,
    gpuixWindow: gpuixPng
  }
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
