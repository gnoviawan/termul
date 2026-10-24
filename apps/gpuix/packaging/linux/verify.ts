/**
 * Acceptance for the Linux package: `bun run package:verify -- [--deb FILE] [--root DIR] [--runs N]`.
 *
 * Extracts the .deb into DIR/install (never a system install), checks every ELF file's libraries
 * resolve, then runs the packaged `usr/bin/termul-gpuix` from a clean environment (`env -i` with
 * HOME under DIR, PATH=/usr/bin:/bin, an Xvfb DISPLAY and the lavapipe ICD) and proves:
 * it spawns its own bundled termul-server, paints the dashboard, opens a terminal and a browser
 * tab, and quits on WM_DELETE_WINDOW leaving no process behind. Then it times N more launches
 * (spawn to the painted project rail) and reports the median.
 *
 * DIR defaults to /tmp/gpuix-p2. PNGs and results.json go to parity-out/packaging/.
 * Ports 8190-8199 only. Browser pages come from a local server, so no network is needed except
 * for the `--check-update` probe.
 */

import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { connectStdio } from '@gpuix/native/automation'
import { APP_DIR, REPO_DIR } from '../../build'
import { WEBVIEW_HOST_BIN } from '../../src/browser/support'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { startPages } from '../../tools/browser/pages'
import {
  alive,
  childWindows,
  descendants,
  isPageGreen,
  mapState,
  pixelAt,
  stats,
  xinput
} from '../../tools/browser/probes'
import {
  grabFrame,
  LAVAPIPE_ICD,
  SCREEN_MARGIN,
  startXvfb,
  windowOrigin
} from '../../tools/parity/shoot-gpuix'
import { freePort, rowMatching, terminals, until } from '../../tools/terminal/shell-tree'
import { APP_ID, INSTALL_DIR, PACKAGE_NAME } from './layout'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    deb: { type: 'string' },
    root: { type: 'string', default: '/tmp/gpuix-p2' },
    runs: { type: 'string', default: '5' },
    out: { type: 'string', default: path.join(APP_DIR, 'parity-out/packaging') }
  }
})
const VERSION: string = (await Bun.file(path.join(REPO_DIR, 'package.json')).json()).version
const DEB = values.deb ?? path.join(APP_DIR, 'dist-package', `${PACKAGE_NAME}_${VERSION}_amd64.deb`)
const ROOT = path.resolve(values.root!)
const OUT = path.resolve(values.out!)
const INSTALL = path.join(ROOT, 'install')
const APP_ROOT = path.join(INSTALL, INSTALL_DIR)
const BIN = path.join(INSTALL, 'usr/bin', PACKAGE_NAME)
const HOME = path.join(ROOT, 'home')
const DATA = path.join(ROOT, 'data')
const LAUNCHER = path.join(HOME, '.local/state/termul-gpuix/launcher')
const WAIT_MS = 60_000
const PROJECT = { id: 'p2-alpha', name: 'alpha', color: 'blue' }

const results: { check: string; ok: boolean; detail: unknown }[] = []
function check(name: string, ok: boolean, detail: unknown): void {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}

function exeOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`)
  } catch {
    return null
  }
}

/** Every live process whose executable or argv lives under the extracted package. */
function packagedProcesses(): { pid: number; exe: string | null; cmd: string }[] {
  const found = []
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    let cmd = ''
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
    } catch {
      continue
    }
    const exe = exeOf(pid)
    if (exe?.startsWith(INSTALL) || cmd.includes(INSTALL)) found.push({ pid, exe, cmd })
  }
  return found
}

function cleanEnv(display: string, port: number): string[] {
  return [
    `HOME=${HOME}`,
    'PATH=/usr/bin:/bin',
    `DISPLAY=${display}`,
    `VK_ICD_FILENAMES=${LAVAPIPE_ICD}`,
    'GPUIX_BACKGROUND=1',
    `GPUIX_WINDOW_SIZE=${WINDOW_WIDTH}x${WINDOW_HEIGHT}`,
    `TERMUL_GPUIX_DATA_DIR=${DATA}`,
    `TERMUL_GPUIX_SERVER_PORT=${port}`
  ]
}

function runClean(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['env', '-i', `HOME=${HOME}`, 'PATH=/usr/bin:/bin', BIN, ...args], {
    cwd: ROOT
  })
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim()
  }
}

function isElf(file: string): boolean {
  const head = Buffer.alloc(4)
  const fd = openSync(file, 'r')
  try {
    return readSync(fd, head, 0, 4, 0) === 4 && head.toString('latin1') === '\x7fELF'
  } finally {
    closeSync(fd)
  }
}

// ---- install ----
if (!existsSync(DEB)) throw new Error(`${DEB} is missing; run bun run package:linux first`)
rmSync(INSTALL, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(INSTALL, { recursive: true })
mkdirSync(HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
const extract = Bun.spawnSync(['dpkg-deb', '-x', DEB, INSTALL])
if (extract.exitCode !== 0) throw new Error(`dpkg-deb -x: ${extract.stderr.toString()}`)
const info = Bun.spawnSync([
  'dpkg-deb',
  '-f',
  DEB,
  'Package',
  'Version',
  'Depends',
  'Installed-Size'
])
check('package extracts with dpkg-deb -x', true, {
  deb: DEB,
  debBytes: Bun.file(DEB).size,
  control: info.stdout.toString().trim().split('\n')
})

const elves: string[] = []
for (const entry of readdirSync(INSTALL, { withFileTypes: true, recursive: true })) {
  const file = path.join(entry.parentPath, entry.name)
  if (entry.isFile() && isElf(file)) elves.push(file)
}
const missing: string[] = []
for (const file of elves) {
  const ldd = Bun.spawnSync(['ldd', file]).stdout.toString()
  for (const line of ldd.split('\n'))
    if (line.includes('not found')) missing.push(`${path.relative(INSTALL, file)}: ${line.trim()}`)
}
check(
  'every ELF file in the package resolves its libraries',
  missing.length === 0 && elves.length >= 5,
  {
    elves: elves.map((file) => path.relative(INSTALL, file)),
    missing
  }
)

const version = runClean(['--version'])
check(
  'termul-gpuix --version from env -i',
  version.stdout === `${PACKAGE_NAME} ${VERSION}`,
  version
)
const update = runClean(['--check-update'])
check(
  'termul-gpuix --check-update reads the release feed, installs nothing',
  update.code === 0 && update.stdout.startsWith('Termul Manager'),
  update
)

// ---- the app ----
const xvfb = await startXvfb(WINDOW_WIDTH + SCREEN_MARGIN, WINDOW_HEIGHT + SCREEN_MARGIN)
const port = freePort()
const pages = startPages()
console.log(`display ${xvfb.display}, server port ${port}, pages ${pages.origin}, state ${ROOT}`)

type App = Awaited<ReturnType<typeof connectStdio>>
interface Running {
  pid: number
  app: App
  exited: Promise<number>
  spawnedAt: number
  log: string
  logged(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>
}

async function launch(tag: string): Promise<Running> {
  const logFile = path.join(ROOT, `${tag}.log`)
  const sink = createWriteStream(logFile)
  let text = ''
  const spawnedAt = performance.now()
  const child = Bun.spawn(['env', '-i', ...cleanEnv(xvfb.display, port), BIN], {
    cwd: HOME,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const listeners: ((chunk: string) => void)[] = []
  const pump = async (stream: ReadableStream<Uint8Array>, feed: boolean) => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      const decoded = decoder.decode(value, { stream: true })
      const kept = decoded.replace(/^(id|event|data):.*\n?/gm, '')
      text += kept
      sink.write(kept)
      if (feed) for (const listener of listeners) listener(decoded)
    }
  }
  void pump(child.stdout, true)
  void pump(child.stderr, false)
  const app = await connectStdio({
    write: (chunk: string) => {
      child.stdin.write(chunk)
      child.stdin.flush()
    },
    feed: (listener: (chunk: string) => void) => {
      listeners.push(listener)
    }
  })
  return {
    pid: child.pid,
    app,
    exited: child.exited,
    spawnedAt,
    log: logFile,
    logged: (pattern, timeoutMs = 15_000) =>
      until(`log ${pattern}`, async () => text.match(pattern), timeoutMs)
  }
}

function closeWindow(): void {
  const proc = Bun.spawnSync(
    [
      'uv',
      'run',
      '--quiet',
      '--with',
      'python-xlib==0.33',
      'python',
      '-I',
      path.join(APP_DIR, 'tools/launcher/close-window.py'),
      `${WINDOW_WIDTH}x${WINDOW_HEIGHT}`
    ],
    { env: { ...process.env, DISPLAY: xvfb.display } }
  )
  if (proc.exitCode !== 0) throw new Error(`close-window: ${proc.stderr.toString()}`)
}

/** Close the window the way a window manager's close button does; every process it started must go. */
async function quit(
  running: Running,
  tree: number[]
): Promise<{ code: number; msToClean: number; leftovers: unknown[] }> {
  const closedAt = performance.now()
  closeWindow()
  const code = await Promise.race([running.exited, Bun.sleep(20_000).then(() => -1)])
  const clean = await until(
    'every packaged process gone',
    async () =>
      tree.every((pid) => !alive(pid)) && packagedProcesses().length === 0 ? true : null,
    15_000
  ).catch(() => false)
  return {
    code,
    msToClean: Math.round(performance.now() - closedAt),
    leftovers: clean
      ? []
      : [...packagedProcesses(), ...tree.filter(alive).map((pid) => ({ pid, exe: exeOf(pid) }))]
  }
}

function readServerRecord(): { pid: number; port: number; token: string } | null {
  try {
    const record = JSON.parse(readFileSync(path.join(LAUNCHER, 'server.json'), 'utf8'))
    const token = readFileSync(path.join(LAUNCHER, 'server-token'), 'utf8').trim()
    return { pid: record.pid, port: record.port, token }
  } catch {
    return null
  }
}

async function shot(name: string): Promise<string> {
  await Bun.sleep(500)
  const origin = await windowOrigin(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT)
  const file = path.join(OUT, `${name}.png`)
  await grabFrame(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT, file, origin)
  console.log(`  shot ${file}`)
  return file
}

/**
 * The status-bar Terminal button, clicked again when a click is lost (seen here: the tooltip shows
 * and no tab opens; unit H1 owns that bug).
 */
async function openTerminal(app: App): Promise<{ testId: string; clicks: number }> {
  const button = (await app.getByText('Terminal').all()).find(
    (node) => node.text === 'Terminal' && (node.bounds?.y ?? 0) > WINDOW_HEIGHT - 40
  )?.bounds
  if (!button) throw new Error('no status-bar Terminal button')
  for (let clicks = 1; clicks <= 4; clicks++) {
    await app.mouse.click({ x: button.x + button.width / 2, y: button.y + button.height / 2 })
    const opened = await until(
      'a terminal tab with a prompt',
      async () => (await terminals(app as never)).find((t) => t.rows.some((r) => r.text.trim())),
      10_000
    ).catch(() => null)
    if (opened) return { testId: opened.testId, clicks }
  }
  throw new Error('four clicks on the status-bar Terminal button opened no terminal')
}

/**
 * The rail's "Projects" header, painted in the empty state and with projects alike. Counted, not
 * `waitFor`: the text matches more than one element (measured: 2).
 */
function railPainted(app: App): Promise<unknown> {
  return until(
    'the project rail',
    async () => (await app.getByText('Projects').count()) > 0,
    WAIT_MS
  )
}

async function mainScenario(): Promise<void> {
  const run = await launch('main')
  const { app } = run
  await railPainted(app)
  const firstPaintMs = Math.round(performance.now() - run.spawnedAt)
  const record = await until('launcher server record', async () => readServerRecord())
  const serverExe = exeOf(record.pid)
  const appExe = exeOf(run.pid)
  check(
    'starts from env -i and spawns its bundled termul-server',
    serverExe === path.join(APP_ROOT, 'dist/termul-server') &&
      appExe === path.join(APP_ROOT, 'bun'),
    {
      appPid: run.pid,
      appExe,
      serverPid: record.pid,
      serverExe,
      port: record.port,
      firstPaintMs,
      ready: (await run.logged(/server pid \d+ ready on port \d+ in \d+ ms/))[0]
    }
  )

  const projectDir = path.join(ROOT, 'projects', PROJECT.name)
  mkdirSync(projectDir, { recursive: true })
  const created = await fetch(`http://127.0.0.1:${record.port}/projects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...PROJECT, path: projectDir })
  })
  if (!created.ok) throw new Error(`POST /projects: HTTP ${created.status}`)
  console.log(`  created project ${JSON.stringify(await created.json())}`)
  await app.getByTestId(`project-item-${PROJECT.id}`).waitFor({ timeoutMs: WAIT_MS })
  await app.getByTestId(`project-item-${PROJECT.id}`).click()
  await app.getByText(`What should we do in ${PROJECT.name}?`).waitFor({ timeoutMs: WAIT_MS })
  check('shows the dashboard of a project', true, { png: await shot('1-dashboard') })

  const { testId, clicks } = await openTerminal(app)
  await app.call('keystrokes', {
    keys: `${[...'echo packaged-$((6*7))'].map((ch) => (ch === ' ' ? 'space' : ch)).join(' ')} enter`
  })
  const row = await until('terminal output', async () =>
    rowMatching(
      (await terminals(app as never)).find((t) => t.testId === testId),
      /^packaged-42$/
    )
  )
  check('opens a terminal whose shell runs a command', true, {
    testId,
    clicks,
    row: row.text.trim(),
    png: await shot('2-terminal')
  })

  await app.mouse.click({ x: WINDOW_WIDTH - 32, y: 28 })
  await app.getByText('New browser tab').waitFor({ timeoutMs: 10_000 })
  await app.getByText('New browser tab').click()
  const helperPid = Number((await run.logged(/started webview host (\d+)/))[1])
  const parent = (await run.logged(/attached to window (0x[0-9a-f]+)/))[1]
  const wmClass = Bun.spawnSync(['xprop', '-display', xvfb.display, '-id', parent, 'WM_CLASS'])
    .stdout.toString()
    .trim()
  check('the window class is the .desktop StartupWMClass', wmClass.includes(`"${APP_ID}"`), {
    wmClass
  })
  await run.logged(/created tab \S+/)
  const slot = await until('webview mapped in the GPUIX window', async () => {
    const child = childWindows(xvfb.display, parent)[0]
    // The container maps at 1x1 first, then moves over the slot.
    const placed = child && child.rect.width > 100 && child.rect.height > 100
    return placed && mapState(xvfb.display, child.id) === 'IsViewable' ? child.rect : null
  })
  const origin = await windowOrigin(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT)
  const X = (...args: string[]) => xinput(xvfb.display, ...args)
  // Software rendering can commit the URL bar's focus and text after the keys; type again until the
  // page's title shows on the tab.
  const navigated = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      X('click', String(origin.x + slot.x + 300), String(origin.y + slot.y - 19))
      await Bun.sleep(800)
      X('key', 'Control_L+a')
      await Bun.sleep(300)
      X('type', `${pages.origin}/one`)
      await Bun.sleep(1200)
      X('type', '\n')
      const shown = await until(
        'the page title on the tab',
        async () => (await app.getByText('B2 page one').count()) > 0,
        10_000
      ).catch(() => false)
      if (shown) return attempt
    }
    throw new Error(
      `typing ${pages.origin}/one in the URL bar never loaded it (slot ${JSON.stringify(slot)})`
    )
  }
  const attempts = await navigated()
  const browserPng = path.join(OUT, '3-browser.png')
  const green = await until(
    'the page painted in the browser slot',
    async () => {
      await shot('3-browser')
      return isPageGreen(pixelAt(browserPng, slot.x + slot.width / 2, slot.y + slot.height / 2))
        ? true
        : null
    },
    30_000
  ).catch(() => false)
  check(
    'opens a browser tab that loads a page in the bundled webview helper',
    green && exeOf(helperPid) === path.join(APP_ROOT, 'dist', WEBVIEW_HOST_BIN),
    {
      helperPid,
      helperExe: exeOf(helperPid),
      parent,
      slot,
      urlBarAttempts: attempts,
      png: browserPng
    }
  )

  const tree = [run.pid, ...descendants(run.pid)]
  const table = tree.map((pid) => ({ pid, exe: exeOf(pid) }))
  const closed = await quit(run, tree)
  check(
    'closing the window quits and leaves no process',
    closed.code === 0 && closed.leftovers.length === 0 && !(await portOpen(record.port)),
    {
      treeWhileRunning: table,
      ...closed,
      serverPortClosed: !(await portOpen(record.port))
    }
  )
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

async function timingRuns(count: number): Promise<void> {
  if (count === 0) return
  const firstPaint: number[] = []
  const serverReady: number[] = []
  const dirty: unknown[] = []
  for (let i = 0; i < count; i++) {
    const run = await launch(`timing-${i + 1}`)
    await railPainted(run.app)
    firstPaint.push(Math.round(performance.now() - run.spawnedAt))
    serverReady.push(Number((await run.logged(/ready on port \d+ in (\d+) ms/))[1]))
    const tree = [run.pid, ...descendants(run.pid)]
    const closed = await quit(run, tree)
    if (closed.code !== 0 || closed.leftovers.length) dirty.push({ run: i + 1, ...closed })
  }
  check(`startup: spawn to the painted project rail, ${count} launches`, dirty.length === 0, {
    firstPaintMs: firstPaint,
    firstPaint: stats(firstPaint),
    serverReadyMs: serverReady,
    serverReady: stats(serverReady),
    dirty
  })
}

/** After a failed scenario: SIGTERM what the package still runs, SIGKILL what ignores it. */
async function stopPackaged(): Promise<void> {
  for (const proc of packagedProcesses()) process.kill(proc.pid, 'SIGTERM')
  await until(
    'packaged processes stopped',
    async () => packagedProcesses().length === 0,
    10_000
  ).catch(() => {
    for (const proc of packagedProcesses()) process.kill(proc.pid, 'SIGKILL')
  })
}

const scenarios: [string, () => Promise<void>][] = [
  ['main scenario', mainScenario],
  ['timing runs', () => timingRuns(Number(values.runs))]
]
try {
  for (const [name, scenario] of scenarios) {
    console.log(`-- ${name}`)
    try {
      await scenario()
    } catch (error) {
      check(name, false, error instanceof Error ? error.message : String(error))
      await shot(`failed-${name.replaceAll(' ', '-')}`).catch(() => undefined)
      await stopPackaged()
    }
  }
} finally {
  pages.stop()
  xvfb.stop()
  const stray = packagedProcesses()
  for (const proc of stray) process.kill(proc.pid, 'SIGKILL')
  if (stray.length) check('no stray packaged process at exit', false, stray)
  writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  console.log(
    `${results.filter((r) => r.ok).length}/${results.length} checks passed; logs in ${ROOT}`
  )
}
process.exit(results.every((r) => r.ok) ? 0 : 1)
