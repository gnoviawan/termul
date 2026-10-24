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
import { waitForQuiet } from '../perf/proc-sampler'
import { seedWorkspace } from '../parity/workspace'
import { freePort, openStatusBarTerminal, until } from '../terminal/shell-tree'
import { startPages } from './pages'
import {
  alive,
  childWindows,
  closeWindow,
  descendants,
  gpuixFramesBehind,
  isPageGreen,
  mapState,
  pixelAt,
  processTable,
  type Rect,
  recordStrip,
  runLengths,
  stats,
  stripFrames,
  xinput
} from './probes'
import { type App, startSession } from './session'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: '/tmp/gpuix-b2/pane-check' } }
})
const OUT = values.out!
const SIZE = { width: 1280, height: 800 }
const STRIP_FPS = 30
const SWEEP_FPS = 60
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
const X = (...args: string[]) => xinput(s.display, ...args)

try {
  await app.getByText('What should we do in alpha?').waitFor({ timeoutMs: READY_TIMEOUT_MS })
  const origin = await s.origin()
  const rootPoint = (x: number, y: number): [string, string] => [
    String(Math.round(origin.x + x)),
    String(Math.round(origin.y + y))
  ]
  const click = (x: number, y: number) => X('click', ...rootPoint(x, y))
  /** Software rendering can paint a control after it is on screen; press again until it reacts. */
  const clickUntilPainted = async (x: number, y: number, text: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await Bun.sleep(500)
      click(x, y)
      const shown = await app
        .getByText(text)
        .waitFor({ timeoutMs: 3000 })
        .then(() => true)
        .catch(() => false)
      if (shown) return
    }
    throw new Error(`clicking ${x},${y} never painted "${text}"`)
  }
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
  await app.getByText('New browser tab').waitFor({ timeoutMs: 10_000 })
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
  const stripDir = path.join(OUT, 'divider-strip')
  await mkdir(stripDir, { recursive: true })
  const stripLeft = 520
  const quiet = await waitForQuiet(200, 120)
  measures.machineBusyPctBeforeDivider = quiet
  const recording = recordStrip(
    s.display,
    { x: origin.x + stripLeft, y: origin.y + r.y + 300, width: SIZE.width - stripLeft - 20 },
    STRIP_FPS,
    stripDir
  )
  await Bun.sleep(500)
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
  await recording.stop()
  const frames = stripFrames(stripDir, [36, 37, 38]).filter(
    (f) => f.divider !== null && f.page !== null
  )
  // A run of consecutive captured frames with the page not flush against the divider.
  const runs = runLengths(frames.map((f) => f.page !== (f.divider as number) + 1))
  const dividerPositions = new Set(frames.map((f) => f.divider)).size
  measures.dividerFrames = {
    capturedFps: STRIP_FPS,
    framesWithBoth: frames.length,
    framesOutOfStep: frames.filter((f) => f.page !== (f.divider as number) + 1).length,
    outOfStepRuns: stats(runs),
    gpuixDividerPositions: dividerPositions,
    maxGapPx: Math.max(
      0,
      ...frames.map((f) => Math.abs((f.page as number) - (f.divider as number) - 1))
    )
  }
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
      // Never more than the step in flight behind GPUIX's divider.
      (measures.dividerFrames as { maxGapPx: number }).maxGapPx <= 20 &&
      sameRect(settled.gpuix, settled.x) &&
      viewport?.[1] === String(settled.x.width),
    {
      lagMs: measures.dividerLagMs,
      moveToGpuixPaintMs: measures.dividerMoveToGpuixPaintMs,
      frames: measures.dividerFrames,
      settled,
      pageViewport: viewport?.slice(1)
    }
  )

  // Continuous drags right then back, one move per automation round trip with no settling,
  // captured faster than GPUIX paints under lavapipe. Only the drag that grows the pane is
  // observable: shrinking it moves GPUIX's divider under a lagging webview, out of sight.
  const sweepDivider = async (name: string, dx: number) => {
    const dir = path.join(OUT, `divider-sweep-${name}`)
    await mkdir(dir, { recursive: true })
    const recorder = recordStrip(
      s.display,
      { x: origin.x + stripLeft, y: origin.y + r.y + 300, width: SIZE.width - stripLeft - 20 },
      SWEEP_FPS,
      dir
    )
    await Bun.sleep(500)
    const from = (await slot()).x - 1
    await app.mouse.down({ x: from, y: 400 })
    for (let i = 1; i <= 40; i++) await app.mouse.move({ x: from + i * dx, y: 400 })
    await app.mouse.up({ x: from + 40 * dx, y: 400 })
    await Bun.sleep(1500)
    await recorder.stop()
    const sweepFrames = stripFrames(dir, [36, 37, 38])
    const behind = gpuixFramesBehind(sweepFrames)
    const end = { gpuix: await gpuixBounds(), x: await slot() }
    return {
      settledOnSlot: sameRect(end.gpuix, end.x) && Math.sign(end.x.x - from - 1) === Math.sign(dx),
      maxBehind: behind.length ? Math.max(...behind) : null,
      capturedFps: SWEEP_FPS,
      framesWithBoth: behind.length,
      gpuixDividerPositions: new Set(sweepFrames.map((f) => f.divider)).size,
      gpuixFramesBehind: stats(behind),
      framesOutOfStep: behind.filter((n) => n > 0).length,
      outOfStepMs: stats(
        runLengths(behind.map((n) => n > 0)).map((n) => Math.round((n * 1000) / SWEEP_FPS))
      ),
      settled: end
    }
  }
  const sweeps = { right: await sweepDivider('right', 5), left: await sweepDivider('left', -5) }
  measures.dividerSweeps = sweeps
  check(
    'continuous divider drags: the webview never trails GPUIX by more than one frame',
    sweeps.right.settledOnSlot &&
      sweeps.left.settledOnSlot &&
      sweeps.left.maxBehind !== null &&
      sweeps.left.maxBehind <= 1,
    sweeps
  )

  // 5. Preferences over the webview, and a dropdown inside it.
  const viewId = split.id
  click(24, 777)
  await app.getByText('Appearance').waitFor({ timeoutMs: 10_000 })
  const hiddenUnderDialog = await until('webview hidden under the dialog', async () =>
    mapState(s.display, viewId) === 'IsUnMapped' ? true : null
  ).catch(() => false)
  await shot('04-preferences')
  click(200, 326)
  await app.getByText('Scrollback').waitFor({ timeoutMs: 10_000 })
  await clickUntilPainted(1046, 438, '50,000 lines')
  await shot('04-preferences-dropdown')
  const dropdownFrame = path.join(OUT, '04-preferences-dropdown.png')
  const coveredSlot = await slot()
  const greenUnderOverlay = [
    [coveredSlot.x + 20, coveredSlot.y + 20],
    [coveredSlot.x + coveredSlot.width / 2, coveredSlot.y + coveredSlot.height / 2],
    [coveredSlot.x + coveredSlot.width - 20, coveredSlot.y + coveredSlot.height - 20]
  ].filter(([px, py]) => isPageGreen(pixelAt(dropdownFrame, px, py))).length
  const stillHidden = mapState(s.display, viewId) === 'IsUnMapped'
  X('key', 'Escape')
  await Bun.sleep(400)
  click(1112, 95)
  const revealed = await until('webview mapped again after Preferences closes', async () =>
    mapState(s.display, viewId) === 'IsViewable' ? true : null
  ).catch(() => false)
  await Bun.sleep(600)
  await shot('05-preferences-closed')
  const closedFrame = path.join(OUT, '05-preferences-closed.png')
  const back = await slot()
  check(
    'Preferences and a dropdown over it stay fully visible; the webview comes back after close',
    hiddenUnderDialog &&
      stillHidden &&
      greenUnderOverlay === 0 &&
      revealed &&
      isPageGreen(pixelAt(closedFrame, back.x + back.width / 2, back.y + back.height - 40)),
    {
      hiddenUnderDialog,
      stillHiddenWithDropdown: stillHidden,
      greenSamplesUnderOverlay: greenUnderOverlay,
      revealed
    }
  )

  // 6. Keys into the page, then back to a GPUIX field.
  const pageKeys = () => (log().match(new RegExp(`\\[${tabId}\\] log: b2-key`, 'g')) ?? []).length
  const keyboardIsApp = () =>
    log().lastIndexOf('keyboard -> app') > log().lastIndexOf('keyboard -> tab')
  /** The focused GPUIX field's text, copied out with real keys (the native composer is not in the tree). */
  const focusedFieldText = async () => {
    X('key', 'Control_L+a')
    X('key', 'Control_L+c')
    await Bun.sleep(300)
    const text = X('clipboard')
    X('key', 'End')
    return text
  }
  r = await slot()
  click(r.x + r.width / 2, r.y + r.height - 60)
  await logged(new RegExp(`keyboard -> tab ${tabId}`))
  X('type', 'abc')
  await app.getByText('B2 keys abc').waitFor({ timeoutMs: 10_000 })
  await logged(new RegExp(`\\[${tabId}\\] log: b2-key c`))
  check('a click into the page gives it the keyboard; typed keys reach the page', true, {
    pageKeys: pageKeys()
  })
  // The left pane's composer: open the agent launcher there.
  await clickUntilPainted(r.x - 23, 28, 'Open canvas')
  const newChat = await until(
    'the left pane menu item',
    async () =>
      (await app.getByText('New chat').all()).find(
        (node) =>
          node.text === 'New chat' && (node.bounds?.x ?? 0) > 480 && (node.bounds?.x ?? 9999) < r.x
      )?.bounds
  )
  await clickUntilPainted(
    newChat.x + 10,
    newChat.y + newChat.height / 2,
    'What should we do in alpha?'
  )
  const composer = await until(
    'composer field',
    async () =>
      (await app.getByText('Ask anything').all()).find((node) => (node.bounds?.x ?? 0) < r.x)
        ?.bounds
  )
  const keysBefore = pageKeys()
  click(composer.x + 40, composer.y + 8)
  await until('keyboard back with the app', async () => (keyboardIsApp() ? true : null))
  await Bun.sleep(600)
  X('type', 'hello')
  await Bun.sleep(800)
  const afterHello = await focusedFieldText()
  // A pointer resting over the webview must not take keys meant for the app (the key gate).
  X('move', ...rootPoint(r.x + r.width / 2, r.y + r.height / 2))
  X('type', 'xyz')
  await Bun.sleep(800)
  const afterXyz = await focusedFieldText()
  const keysAfter = pageKeys()
  await shot('06-composer-typed')
  check(
    'a click back on the GPUIX composer returns the keyboard; the page gets no more keys',
    afterHello === 'hello' && afterXyz === 'helloxyz' && keysAfter === keysBefore,
    {
      composer: afterHello,
      composerWithPointerOverWebview: afterXyz,
      pageKeysBefore: keysBefore,
      pageKeysAfter: keysAfter
    }
  )

  // 7. A second tab, its memory, and closing it ends its WebKit processes.
  const sumPss = (pids: number[]) =>
    Math.round(processTable(pids).reduce((sum, p) => sum + p.pssMb, 0))
  const oneTab = descendants(helperPid)
  measures.memoryOneTab = processTable([helperPid, ...oneTab])
  measures.memoryOneTabPssMb = sumPss([helperPid, ...oneTab])
  await clickUntilPainted(1248, 28, 'Open canvas')
  const browserItem = await until(
    'the right pane menu item',
    async () =>
      (await app.getByText('New browser tab').all()).find((node) => (node.bounds?.x ?? 0) > r.x)
        ?.bounds
  )
  click(browserItem.x + 10, browserItem.y + browserItem.height / 2)
  const secondId = await until('a second tab', async () => {
    const ids = [...log().matchAll(/created tab (\S+)/g)]
      .map((m) => m[1])
      .filter((id) => id !== tabId)
    return ids[0] ?? null
  })
  r = (await placed((rect) => rect.x === r.x)).rect
  click(r.x + 300, r.y - 19)
  await Bun.sleep(800)
  X('key', 'Control_L+a')
  X('type', `${pages.origin}/two`)
  await Bun.sleep(1200)
  X('type', '\n')
  await logged(new RegExp(`\\[${secondId}\\] log: b2-page-two-loaded`))
  // Let the page settle before reading memory: right after load the web process is still growing.
  await Bun.sleep(3000)
  const twoTabs = descendants(helperPid)
  const secondPids = twoTabs.filter((pid) => !oneTab.includes(pid))
  measures.memoryTwoTabs = processTable([helperPid, ...twoTabs])
  const secondTable = processTable(secondPids).map((p) => `${p.pid} ${p.comm}`)
  measures.memoryTwoTabsPssMb = sumPss([helperPid, ...twoTabs])
  measures.secondTabPssDeltaMb =
    (measures.memoryTwoTabsPssMb as number) - (measures.memoryOneTabPssMb as number)
  await shot('07-two-tabs')
  const closeX = await until("the second tab's close button", async () => {
    const { tree } = await app.call('getTree', {})
    let title: Rect | null = null
    const nodes: { id: number; bounds: Rect }[] = []
    const walk = (
      node: { id: number; text?: string; bounds?: Rect; children?: unknown[] } | null
    ) => {
      if (!node) return
      if (node.text === 'B2 page two' && node.bounds && node.bounds.y < 45) title = node.bounds
      if (node.bounds) nodes.push({ id: node.id, bounds: node.bounds })
      for (const child of (node.children ?? []) as never[]) walk(child)
    }
    walk(tree as never)
    if (!title) return null
    const t: Rect = title
    return nodes
      .map((n) => n.bounds)
      .filter(
        (b) => b.width <= 24 && b.height <= 24 && b.x > t.x + t.width && b.x < t.x + t.width + 40
      )
      .filter((b) => Math.abs(b.y + b.height / 2 - (t.y + t.height / 2)) < 6)
      .sort((a, b) => a.width - b.width)[0]
  })
  click(closeX.x + closeX.width / 2, closeX.y + closeX.height / 2)
  await logged(new RegExp(`destroyed tab ${secondId}`))
  const secondGone = await until("the closed tab's WebKit processes exit", async () =>
    secondPids.every((pid) => !alive(pid)) ? true : null
  ).catch(() => false)
  const firstAlive = oneTab.filter(alive)
  await shot('08-second-tab-closed')
  check(
    'two tabs run their own WebKit processes; closing one ends exactly its processes',
    secondPids.length > 0 && secondGone && firstAlive.length === oneTab.length,
    {
      secondTabPids: secondTable,
      secondGone,
      firstTabPids: oneTab.map((pid) => `${pid} ${alive(pid) ? 'alive' : 'gone'}`),
      pssOneTabMb: measures.memoryOneTabPssMb,
      pssTwoTabsMb: measures.memoryTwoTabsPssMb,
      perExtraTabMb: measures.secondTabPssDeltaMb
    }
  )

  // 8. Closing the window ends the app, the helper and every WebKit process.
  const everything = [helperPid, ...descendants(helperPid)]
  const protocols = closeWindow(s.display, parentXid)
  const exitCode = await Promise.race([s.exited, Bun.sleep(15_000).then(() => 'timeout' as const)])
  const leftovers = await until(
    'helper and WebKit processes exit',
    async () => {
      const live = everything.filter(alive)
      return live.length === 0 ? [] : null
    },
    10_000
  ).catch(() => everything.filter(alive))
  check(
    'closing the window quits the app and leaves no helper or WebKit process',
    exitCode !== 'timeout' && leftovers.length === 0,
    {
      wmProtocols: protocols,
      appExit: exitCode,
      watched: processTable(everything).length,
      leftovers: processTable(leftovers)
    }
  )
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
