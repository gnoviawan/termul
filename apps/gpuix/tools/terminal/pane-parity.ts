/**
 * Web vs GPUIX shot of the same workspace terminal tab at 1280x800, both in
 * the real app shell. Each client gets a fresh test server seeded the same way
 * (same state dir, so the same prompt and cwd), opens a terminal from the
 * status-bar Terminal button, clicks into it, and `cat`s T1's recorded fixture
 * up to a checkpoint. The terminal pane box the web client paints is cropped
 * from both window shots and diffed (exact and perceptual).
 *
 * The web client is this worktree's dist-web (`bun run build:web` at the repo root).
 *
 * bun tools/terminal/pane-parity.ts [--out DIR] [--state-dir DIR] [--checkpoint done]
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient } from '../../build'
import { cropPng, diffPngs, type Rect } from '../parity/diff'
import { startTestServer, type TestServer } from '../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import { withWeb } from '../parity/shoot-web'
import { seedWorkspace } from '../parity/workspace'
import { FIXTURE_BYTES, FIXTURE_CHECKPOINTS } from './fixture'
import { freePort, openStatusBarTerminal, terminals } from './shell-tree'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-o1/parity' },
    'state-dir': { type: 'string', default: '/tmp/gpuix-o1/parity-state' },
    checkpoint: { type: 'string', default: 'done' }
  }
})
const OUT = values.out!
const STATE = values['state-dir']!
const SIZE = { width: 1280, height: 800 }
const COMMAND = 'clear; cat fixture.out'
const SETTLE_MS = 2500
const READY_TEXT = 'What should we do in alpha?'

const offsets = JSON.parse(await readFile(FIXTURE_CHECKPOINTS, 'utf8')) as Record<string, number>
const limit = offsets[values.checkpoint!]
if (limit === undefined) throw new Error(`no checkpoint ${values.checkpoint}`)
const fixtureBytes = new Uint8Array(await readFile(FIXTURE_BYTES)).subarray(0, limit)

/** A fresh server at the same state path, seeded with the workspace projects and the fixture. */
async function withSeededServer<T>(body: (server: TestServer) => Promise<T>): Promise<T> {
  await rm(STATE, { recursive: true, force: true })
  const server = await startTestServer({
    port: freePort(),
    token: 'o1-parity-token',
    stateDir: path.join(STATE, 'server')
  })
  try {
    await seedWorkspace(server)
    await writeFile(path.join(server.stateDir, 'projects', 'alpha', 'fixture.out'), fixtureBytes)
    return await body(server)
  } finally {
    await server.stop()
  }
}

await mkdir(OUT, { recursive: true })
const webPng = path.join(OUT, 'web-window.png')
const gpuixPng = path.join(OUT, 'gpuix-window.png')

const STTY_FILE = '.stty'
/** `rows cols` as the shell saw them, written by `stty size > .stty` in the project dir. */
async function readStty(server: TestServer): Promise<string> {
  const file = path.join(server.stateDir, 'projects', 'alpha', STTY_FILE)
  const deadline = Date.now() + 10_000
  for (;;) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (/^\d+ \d+$/.test(text.trim())) return text.trim()
    if (Date.now() > deadline) throw new Error('stty size never written')
    await Bun.sleep(100)
  }
}
const grids: Record<'web' | 'gpuix', { stty?: string; cellWidth?: number; cellHeight?: number }> = {
  web: {},
  gpuix: {}
}

const box: Rect = await withSeededServer((server) =>
  withWeb({ server, ...SIZE }, async ({ page, grab }) => {
    await page.getByText(READY_TEXT, { exact: true }).first().waitFor({ timeout: READY_TIMEOUT_MS })
    await page.locator('[data-status-bar] button', { hasText: 'Terminal' }).first().click()
    const pane = page.locator('div.bg-terminal-bg:has(.xterm)').first()
    await pane.waitFor({ timeout: READY_TIMEOUT_MS })
    await page.waitForTimeout(1500)
    const rect = (await pane.boundingBox())!
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.keyboard.type(`stty size > ${STTY_FILE}`)
    await page.keyboard.press('Enter')
    const stty = await readStty(server)
    const screen = (await page.locator('.xterm-screen').first().boundingBox())!
    const [rows, cols] = stty.split(' ').map(Number) as [number, number]
    grids.web = { stty, cellWidth: screen.width / cols, cellHeight: screen.height / rows }
    await page.keyboard.type(COMMAND)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(SETTLE_MS)
    await page.mouse.move(0, 0)
    await grab(webPng)
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  })
)

const build = await buildClient()
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
await withSeededServer((server) =>
  withGpuix(
    { server, entry: build.entry, clientStateDir: path.join(STATE, 'client'), ...SIZE },
    async ({ app, grab }) => {
      await app.getByText(READY_TEXT).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      const testId = await openStatusBarTerminal(app, SIZE.height)
      await Bun.sleep(1500)
      await app.mouse.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
      const node = await app.getByTestId(testId).element()
      const sttyKeys = [...`stty size > ${STTY_FILE}`].map((ch) => (ch === ' ' ? 'space' : ch))
      await app.call('keystrokes', { elementId: node.id, keys: `${sttyKeys.join(' ')} enter` })
      const stty = await readStty(server)
      const term = (await terminals(app)).find((x) => x.testId === testId)
      const row = term?.rows.find((r) => r.cellWidth !== null)
      grids.gpuix = { stty, cellWidth: row?.cellWidth ?? undefined, cellHeight: row?.height }
      const keys = [...COMMAND].map((ch) => (ch === ' ' ? 'space' : ch)).join(' ')
      await app.call('keystrokes', { elementId: node.id, keys: `${keys} enter` })
      await Bun.sleep(SETTLE_MS)
      await app.mouse.move({ x: 0, y: 0 })
      await grab(gpuixPng)
    }
  )
)

const webCrop = path.join(OUT, 'web.png')
const gpuixCrop = path.join(OUT, 'gpuix.png')
cropPng(webPng, box, webCrop)
cropPng(gpuixPng, box, gpuixCrop)
const pane = diffPngs(webCrop, gpuixCrop, path.join(OUT, 'diff.png'))
const window = diffPngs(webPng, gpuixPng, path.join(OUT, 'window-diff.png'))
const pct = (n: number) => Number(n.toFixed(2))
const report = {
  checkpoint: values.checkpoint,
  box,
  grids,
  pane: { exactPercent: pct(pane.exact.percent), perceptualPercent: pct(pane.perceptual.percent) },
  window: {
    exactPercent: pct(window.exact.percent),
    perceptualPercent: pct(window.perceptual.percent)
  },
  png: {
    web: webCrop,
    gpuix: gpuixCrop,
    diff: path.join(OUT, 'diff.png'),
    webWindow: webPng,
    gpuixWindow: gpuixPng
  }
}
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
