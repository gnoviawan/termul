/**
 * Browser-pane acceptance in the real GPUIX shell under Xvfb, driven with real X input (XTest)
 * where the webview is involved, because GPUIX automation input never reaches X.
 *
 *   CARGO_TARGET_DIR=... bun run build:webview-host   # once; the check uses dist/termul-webview-host
 *   bun tools/browser/pane-check.ts [--out DIR]
 *
 * Writes PNGs and results.json to DIR (default /tmp/gpuix-b2/pane-check).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient, OUT_DIR } from '../../build'
import { WEBVIEW_HOST_BIN } from '../../src/browser/support'
import { startTestServer } from '../parity/server'
import { READY_TIMEOUT_MS } from '../parity/shoot-gpuix'
import { seedWorkspace } from '../parity/workspace'
import { freePort, openStatusBarTerminal, until } from '../terminal/shell-tree'
import { startPages } from './pages'
import {
  alive,
  childWindows,
  closeWindow,
  descendants,
  isPageGreen,
  mapState,
  pixelAt,
  processTable,
  type Rect,
  stats,
  xinput
} from './probes'
import { type App, startSession } from './session'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: '/tmp/gpuix-b2/pane-check' } }
})
const OUT = values.out!
const SIZE = { width: 1280, height: 800 }
const sameRect = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
const results: { check: string; ok: boolean; detail: unknown }[] = []
const measures: Record<string, unknown> = {}
function check(name: string, ok: boolean, detail: unknown = {}): void {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}

if (!existsSync(path.join(OUT_DIR, WEBVIEW_HOST_BIN))) {
  throw new Error(`build the helper first: CARGO_TARGET_DIR=... bun run build:webview-host`)
}
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const build = await buildClient()
if (!build.ok) throw new Error(build.logs.join('\n'))
const server = await startTestServer({
  port: freePort(),
  token: 'b2-pane-token',
  stateDir: path.join(OUT, 'server')
})
const pages = startPages()
const logFile = path.join(OUT, 'app.log')
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
const logged = (pattern: RegExp) => until(`log ${pattern}`, async () => pattern.exec(log()), 20_000)

await seedWorkspace(server)
const s = await startSession({
  server,
  entry: build.entry,
  ...SIZE,
  clientStateDir: path.join(OUT, 'client'),
  logFile,
  env: process.env.B2_WEBKIT_ENV
    ? Object.fromEntries([process.env.B2_WEBKIT_ENV.split('=') as [string, string]])
    : {}
})
const app: App = s.app
const shot = (name: string) => s.grab(path.join(OUT, `${name}.png`))
const painted = async () => (await app.call('getAllText', {})).text as string[]
const paintedHas = (text: string, ms = 15_000) =>
  until(`painted "${text}"`, async () => (await painted()).some((t) => t.includes(text)), ms)
const X = (...args: string[]) => xinput(s.display, ...args)

try {
  await app.getByText('What should we do in alpha?').waitFor({ timeoutMs: READY_TIMEOUT_MS })
  const origin = await s.origin()
  const rootPoint = (x: number, y: number): [string, string] => [
    String(origin.x + x),
    String(origin.y + y)
  ]
  const click = (x: number, y: number) => X('click', ...rootPoint(x, y))
  /** The URL bar's text, copied out of it with real keys (GPUIX does not expose input values). */
  const urlBar = async (rect: Rect): Promise<string> => {
    click(rect.x + 300, rect.y - 19)
    await Bun.sleep(600)
    X('key', 'Control_L+a')
    X('key', 'Control_L+c')
    await Bun.sleep(300)
    const text = X('clipboard')
    X('key', 'Escape')
    return text
  }
  await openStatusBarTerminal(app as never, SIZE.height)

  // 1. A browser tab from the New tab menu.
  await app.mouse.click({ x: 1248, y: 28 })
  await app.getByText('New browser tab').click()
  const tabId = (await logged(/created tab (\S+)/))[1]
  const parentXid = (await logged(/attached to window (0x[0-9a-f]+)/))[1]
  const helperPid = Number((await logged(/started webview host (\d+)/))[1])
  const container = async (): Promise<{ id: string; rect: Rect }> =>
    until('webview container window', async () => childWindows(s.display, parentXid)[0])
  const slot = () => container().then((c) => c.rect)
  const slotElement = (rect: Rect) =>
    app.call('getTree', {}).then(({ tree }) => {
      let found: number | null = null
      const walk = (node: { id: number; bounds?: Rect; children?: unknown[] } | null) => {
        if (!node || found !== null) return
        const b = node.bounds
        if (
          b &&
          b.x === rect.x &&
          b.y === rect.y &&
          b.width === rect.width &&
          b.height === rect.height
        )
          found = node.id
        for (const child of (node.children ?? []) as never[]) walk(child)
      }
      walk(tree as never)
      return found
    })
  /** The webview mapped exactly over a GPUIX element: the browser slot. */
  const placed = (accept: (rect: Rect) => boolean = () => true) =>
    until('webview placed over its slot', async () => {
      const { id, rect } = await container()
      if (mapState(s.display, id) !== 'IsViewable' || !accept(rect)) return null
      const element = await slotElement(rect)
      return element === null ? null : { id, rect, element }
    })
  const webview = await placed()
  check('New browser tab creates a webview inside the GPUIX window, mapped over the slot', true, {
    tabId,
    parentXid,
    helperPid,
    container: webview
  })

  // 2. Type a URL and Enter.
  let r = webview.rect
  click(r.x + 300, r.y - 19)
  await Bun.sleep(800)
  X('key', 'Control_L+a')
  await Bun.sleep(300)
  const one = `${pages.origin}/one`
  X('type', one)
  // Software rendering commits React state a few hundred ms behind the keys (see report).
  await Bun.sleep(1200)
  const typedAt = Date.now()
  X('type', '\n')
  await app.getByText('B2 page one').waitFor({ timeoutMs: 15_000 })
  measures.urlBarEnterToTitleMs = Date.now() - typedAt
  await logged(new RegExp(`\\[${tabId}\\] log: b2-page-one-loaded`))
  const loadedAt = Date.now()
  const greenAfter = await until(
    'page one painted in the slot',
    async () => {
      await s.grab(path.join(OUT, '01-page-one.png'))
      return isPageGreen(pixelAt(path.join(OUT, '01-page-one.png'), r.x + 600, r.y + 500))
        ? Date.now() - loadedAt
        : null
    },
    30_000
  )
  measures.loadedToPaintedMs = greenAfter
  const urlAfterEnter = await urlBar(r)
  check(
    'URL bar + Enter navigates and paints; tab title and URL bar follow; console captured',
    urlAfterEnter === one,
    {
      titleMs: measures.urlBarEnterToTitleMs,
      paintMs: greenAfter,
      urlBar: urlAfterEnter
    }
  )

  // 3. A link click inside the page, then Back and Forward.
  r = await slot()
  let t0 = Date.now()
  click(r.x + 100, r.y + 55)
  await app.getByText('B2 page two').waitFor({ timeoutMs: 15_000 })
  measures.linkClickToTitleMs = Date.now() - t0
  const urlAfterLink = await urlBar(r)
  await logged(new RegExp(`\\[${tabId}\\] log: b2-page-two-loaded`))
  check('a link click navigates and the URL bar follows', urlAfterLink === `${pages.origin}/two`, {
    ms: measures.linkClickToTitleMs,
    urlBar: urlAfterLink
  })
  t0 = Date.now()
  click(r.x + 21, r.y - 19)
  await app.getByText('B2 page one').waitFor({ timeoutMs: 15_000 })
  const backMs = Date.now() - t0
  const urlAfterBack = await urlBar(r)
  click(r.x + 53, r.y - 19)
  await app.getByText('B2 page two').waitFor({ timeoutMs: 15_000 })
  click(r.x + 21, r.y - 19)
  await app.getByText('B2 page one').waitFor({ timeoutMs: 15_000 })
  check('Back and Forward move through history', urlAfterBack === one, {
    backMs,
    urlBar: urlAfterBack
  })

  // 4. Split: drag the browser tab to the right edge, then drag the pane divider.
  await app.mouse.drag({ x: 633, y: 28 }, { x: 1200, y: 420 }, { steps: 12 })
  await logged(new RegExp(`destroyed tab ${tabId}[\\s\\S]*created tab ${tabId}`))
  await app.getByText('B2 page one').waitFor({ timeoutMs: 15_000 })
  r = await until('webview settles in the right pane', async () => {
    const rect = await slot()
    return rect.x > 700 ? rect : null
  })
  await shot('02-split')
  check('the tab moves into a split and its webview follows', true, { rect: r })

  const split = await placed((rect) => rect.x === r.x && rect.width === r.width)
  const gpuixBounds = async () =>
    (await app.call('getBounds', { elementId: split.element })).bounds as Rect
  const steps: { gpuixMs: number; xMs: number; lagMs: number }[] = []
  const divider = r.x - 1
  await app.mouse.down({ x: divider, y: 400 })
  for (let i = 1; i <= 10; i++) {
    const before = r.x
    const moved = Date.now()
    await app.mouse.move({ x: divider - i * 20, y: 400 })
    let gpuixAt = 0
    let xAt = 0
    const deadline = Date.now() + 5000
    while ((!gpuixAt || !xAt) && Date.now() < deadline) {
      if (!gpuixAt && (await gpuixBounds()).x !== before) gpuixAt = Date.now()
      if (!xAt && (await slot()).x !== before) xAt = Date.now()
    }
    r = await slot()
    steps.push({ gpuixMs: gpuixAt - moved, xMs: xAt - moved, lagMs: xAt - gpuixAt })
  }
  await app.mouse.up({ x: divider - 200, y: 400 })
  await Bun.sleep(1000)
  measures.dividerSteps = steps
  measures.dividerLagMs = stats(steps.map((step) => step.lagMs))
  measures.dividerMoveToGpuixPaintMs = stats(steps.map((step) => step.gpuixMs))
  const settled = { gpuix: await gpuixBounds(), x: await slot() }
  const viewport = [
    ...log().matchAll(new RegExp(`\\[${tabId}\\] log: b2-viewport (\\d+)x(\\d+)`, 'g'))
  ].pop()
  await shot('03-divider-dragged')
  check(
    'dragging the divider: the webview follows each step and settles on the slot exactly',
    steps.every((step) => step.gpuixMs > 0 && step.xMs > 0) &&
      sameRect(settled.gpuix, settled.x) &&
      viewport?.[1] === String(settled.x.width),
    {
      lagMs: measures.dividerLagMs,
      moveToGpuixPaintMs: measures.dividerMoveToGpuixPaintMs,
      settled,
      pageViewport: viewport?.slice(1)
    }
  )

  // 5. Preferences over the webview, and a dropdown inside it.
  click(24, 777)
  await app.getByText('Appearance').waitFor({ timeoutMs: 10_000 })
  await Bun.sleep(800)
  await shot('04-preferences')
} catch (error) {
  check('run', false, String(error))
  await shot('zz-failure').catch(() => {})
} finally {
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, measures }, null, 2))
  await s.stop()
  pages.stop()
  await server.stop()
}
const failed = results.filter((result) => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed; results in ${OUT}`)
process.exit(failed.length ? 1 : 0)
