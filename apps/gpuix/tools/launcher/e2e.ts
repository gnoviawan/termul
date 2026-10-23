/**
 * `bun tools/launcher/e2e.ts [--out DIR] [--keep]`
 *
 * Drives the real app under Xvfb with no TERMUL_SERVER_URL, so the launcher
 * owns the server, and checks every lifecycle edge against the processes and
 * sockets themselves:
 *
 * 1. spawn: the app spawns a server and shows the project list; a second
 *    launch exits and leaves one server; closing the window stops the server.
 * 2. crash: kill -9 the server, the window shows the crash banner, a new
 *    server comes back on the same port and the list updates live again;
 *    kill -9 the app and the watchdog stops the server.
 * 3. reuse: a keep-alive launch leaves its server running on quit; the next
 *    launch reuses it and leaves it running too.
 * 4. mismatch: a server speaking another protocol version gets the error screen.
 *
 * Ports 8190-8199 only; state under /tmp/gpuix-p1-e2e (removed unless --keep).
 */

import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { connectStdio } from '@gpuix/react/automation'
import { PNG } from 'pngjs'
import { APP_DIR, buildClient } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { grabFrame, LAVAPIPE_ICD, startXvfb, windowOrigin } from '../parity/shoot-gpuix'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string' }, keep: { type: 'boolean', default: false } }
})
const ROOT = '/tmp/gpuix-p1-e2e'
const OUT = values.out ?? path.join(APP_DIR, 'parity-out', 'launcher')
const SERVER_BIN = process.env.TERMUL_SERVER_BIN ?? '/root/gpuix-bin/termul-server'
const WAIT_MS = 60_000
const PROJECTS = [
  { id: 'p1-alpha', name: 'alpha-launcher', color: 'blue' },
  { id: 'p1-beta', name: 'beta-launcher', color: 'green' }
]

type App = Awaited<ReturnType<typeof connectStdio>>
interface Running {
  proc: ReturnType<typeof Bun.spawn>
  app: App
  log: string
}
interface ServerRec {
  pid: number
  port: number
  token: string
}

const results: { check: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until<T>(
  what: string,
  probe: () => Promise<T | null> | T | null,
  timeoutMs = WAIT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

async function freeTestPort(): Promise<number> {
  for (let port = 8190; port <= 8199; port++) if (!(await portOpen(port))) return port
  throw new Error('no free port in 8190-8199')
}

const launcherDir = (clientDir: string): string => path.join(clientDir, 'launcher')

function readRecord(clientDir: string): ServerRec | null {
  try {
    const record = JSON.parse(
      readFileSync(path.join(launcherDir(clientDir), 'server.json'), 'utf8')
    )
    const token = readFileSync(path.join(launcherDir(clientDir), 'server-token'), 'utf8').trim()
    return { pid: record.pid, port: record.port, token }
  } catch {
    return null
  }
}

async function api(record: ServerRec, route: string, init: RequestInit): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${record.port}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${record.token}`, 'content-type': 'application/json' }
  })
  if (!res.ok) throw new Error(`${init.method} ${route}: HTTP ${res.status}`)
}

const build = await buildClient()
for (const line of build.logs) console.error(line)
if (!build.ok) process.exit(1)
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const xvfb = await startXvfb(WINDOW_WIDTH + 64, WINDOW_HEIGHT + 64)
const port = await freeTestPort()
console.log(`display ${xvfb.display}, server port ${port}, output ${OUT}`)

function appEnv(name: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  delete env.TERMUL_SERVER_URL
  delete env.TERMUL_SERVER_TOKEN
  return {
    ...env,
    DISPLAY: xvfb.display,
    VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
    GPUIX_BACKGROUND: '1',
    TERMUL_SERVER_BIN: SERVER_BIN,
    TERMUL_GPUIX_DATA_DIR: path.join(ROOT, name, 'data'),
    TERMUL_GPUIX_STATE_DIR: path.join(ROOT, name, 'client'),
    TERMUL_GPUIX_SERVER_PORT: String(port),
    ...extra
  }
}

async function startApp(env: Record<string, string>, tag: string): Promise<Running> {
  const log = path.join(ROOT, `${tag}.app.log`)
  mkdirSync(ROOT, { recursive: true })
  const sink = createWriteStream(log)
  const proc = Bun.spawn(['bun', build.entry], {
    cwd: APP_DIR,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const listeners: ((chunk: string) => void)[] = []
  const pump = async (stream: ReadableStream<Uint8Array>, feed: boolean): Promise<void> => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      const text = decoder.decode(value)
      sink.write(
        text
          .split('\n')
          .filter((line) => !line.startsWith('data:'))
          .join('\n')
      )
      if (feed) for (const listener of listeners) listener(text)
    }
  }
  void pump(proc.stdout as ReadableStream<Uint8Array>, true)
  void pump(proc.stderr as ReadableStream<Uint8Array>, false)
  const stdin = proc.stdin as import('bun').FileSink
  const app = await connectStdio({
    write: (chunk) => {
      stdin.write(chunk)
      stdin.flush()
    },
    feed: (listener) => listeners.push(listener)
  })
  return { proc, app, log }
}

async function shot(name: string, settleMs = 400): Promise<string> {
  await Bun.sleep(settleMs)
  const origin = await windowOrigin(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT)
  const file = path.join(OUT, `${name}.png`)
  await grabFrame(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT, file, origin)
  console.log(`  shot ${file}`)
  return file
}

const BANNER_ROWS = 40

/** Pixels that differ in the first `rows` rows of two same-size PNGs. */
function differingPixels(a: string, b: string, rows: number): number {
  const left = PNG.sync.read(readFileSync(a))
  const right = PNG.sync.read(readFileSync(b))
  let count = 0
  for (let i = 0; i < left.width * rows * 4; i += 4) {
    if (
      left.data[i] !== right.data[i] ||
      left.data[i + 1] !== right.data[i + 1] ||
      left.data[i + 2] !== right.data[i + 2]
    )
      count++
  }
  return count
}

async function quit(running: Running): Promise<void> {
  running.proc.kill('SIGTERM')
  await running.proc.exited
}

/** Quit the way a user does: the window manager's close button (WM_DELETE_WINDOW). */
async function closeWindow(running: Running): Promise<number> {
  const script = path.join(import.meta.dir, 'close-window.py')
  const close = Bun.spawnSync(
    [
      'uv',
      'run',
      '--quiet',
      '--with',
      'python-xlib==0.33',
      'python',
      '-I',
      script,
      `${WINDOW_WIDTH}x${WINDOW_HEIGHT}`
    ],
    { env: { ...process.env, DISPLAY: xvfb.display } }
  )
  if (close.exitCode !== 0) throw new Error(`close-window: ${close.stderr.toString()}`)
  return running.proc.exited
}

async function serverGone(record: ServerRec): Promise<string> {
  const started = Date.now()
  await until(
    'server pid gone and port closed',
    async () => (!pidAlive(record.pid) && !(await portOpen(record.port)) ? true : null),
    15_000
  )
  return `pid ${record.pid} gone, port ${record.port} closed ${Date.now() - started} ms after`
}

async function waitGone(app: App, testId: string): Promise<void> {
  await until(`${testId} to disappear`, async () =>
    (await app.getByTestId(testId).count()) === 0 ? true : null
  )
}

async function spawnScenario(): Promise<void> {
  const env = appEnv('spawn')
  const clientDir = env.TERMUL_GPUIX_STATE_DIR
  check('no server before launch', !(await portOpen(port)), `port ${port} closed`)
  const started = performance.now()
  const a = await startApp(env, 'spawn')
  await a.app.getByTestId('project-list').waitFor({ timeoutMs: WAIT_MS })
  const record = await until('server record', () => readRecord(clientDir))
  check(
    'app spawned a server',
    pidAlive(record.pid) && (await portOpen(record.port)),
    `pid ${record.pid} on port ${record.port}, list painted ${Math.round(performance.now() - started)} ms after launch`
  )
  for (const project of PROJECTS) {
    const dir = path.join(ROOT, 'spawn', 'projects', project.name)
    mkdirSync(dir, { recursive: true })
    await api(record, '/projects', {
      method: 'POST',
      body: JSON.stringify({ ...project, path: dir })
    })
  }
  for (const project of PROJECTS)
    await a.app.getByText(project.name).waitFor({ timeoutMs: WAIT_MS })
  await shot('1-spawned-project-list')

  const second = Bun.spawn(['bun', build.entry], {
    cwd: APP_DIR,
    env,
    stdout: 'ignore',
    stderr: 'ignore'
  })
  const secondCode = await Promise.race([second.exited, Bun.sleep(10_000).then(() => 'timeout')])
  const after = readRecord(clientDir)
  check(
    'second launch exits and spawns nothing',
    secondCode === 0 && after?.pid === record.pid,
    `second launch exit ${secondCode}, server pid still ${after?.pid}`
  )

  const code = await closeWindow(a)
  check('closing the window quits the app', true, `app exited with ${code}`)
  check('quit stops the spawned server', true, await serverGone(record))
  check('quit removes the server record', readRecord(clientDir) === null, 'server.json gone')
}

async function crashScenario(): Promise<void> {
  const env = appEnv('spawn')
  const clientDir = env.TERMUL_GPUIX_STATE_DIR
  const a = await startApp(env, 'crash')
  for (const project of PROJECTS)
    await a.app.getByText(project.name).waitFor({ timeoutMs: WAIT_MS })
  const first = await until('server record', () => readRecord(clientDir))
  check(
    'projects persist across server restarts',
    true,
    `${PROJECTS.length} seeded projects painted by a new server pid ${first.pid}`
  )

  process.kill(first.pid, 'SIGKILL')
  await a.app.getByTestId('server-status-crashed').waitFor({ timeoutMs: WAIT_MS })
  // The banner lives for the restart backoff plus the server's start, so grab at once.
  const bannerShot = await shot('2-crashed-banner', 0)

  const second = await until('restarted server', () => {
    const record = readRecord(clientDir)
    return record && record.pid !== first.pid ? record : null
  })
  await waitGone(a.app, 'server-status-crashed')
  check(
    'server restarted on the same port',
    second.port === first.port && pidAlive(second.pid),
    `new pid ${second.pid} on port ${second.port}`
  )
  await api(second, `/projects/${PROJECTS[0].id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'alpha-after-crash' })
  })
  await a.app.getByText('alpha-after-crash').waitFor({ timeoutMs: WAIT_MS })
  const recoveredShot = await shot('3-recovered-project-list')
  check('renderer reconnected after restart', true, 'rename through the new server painted live')
  const bannerPixels = differingPixels(bannerShot, recoveredShot, BANNER_ROWS)
  check(
    'kill -9 shows the crash banner',
    bannerPixels > 1000,
    `server-status-crashed painted after SIGKILL of pid ${first.pid}; ${bannerPixels} pixels of the top ${BANNER_ROWS} rows differ from the recovered frame`
  )

  a.proc.kill('SIGKILL')
  await a.proc.exited
  check('kill -9 of the app: watchdog stops the server', true, await serverGone(second))
}

async function reuseScenario(): Promise<void> {
  const keepEnv = appEnv('reuse', { TERMUL_GPUIX_KEEP_SERVER: '1' })
  const clientDir = keepEnv.TERMUL_GPUIX_STATE_DIR
  const a = await startApp(keepEnv, 'reuse-keep')
  await a.app.getByTestId('project-list').waitFor({ timeoutMs: WAIT_MS })
  const record = await until('server record', () => readRecord(clientDir))
  await quit(a)
  await Bun.sleep(1500)
  check(
    'keep-alive server survives quit',
    pidAlive(record.pid) && (await portOpen(record.port)),
    `pid ${record.pid} still serving port ${record.port}`
  )

  const dir = path.join(ROOT, 'reuse', 'projects', 'gamma')
  mkdirSync(dir, { recursive: true })
  await api(record, '/projects', {
    method: 'POST',
    body: JSON.stringify({ id: 'p1-gamma', name: 'gamma-reused', color: 'red', path: dir })
  })
  const b = await startApp(appEnv('reuse'), 'reuse-attach')
  await b.app.getByText('gamma-reused').waitFor({ timeoutMs: WAIT_MS })
  const reused = readRecord(clientDir)
  check(
    'second launch reuses the running server',
    reused?.pid === record.pid,
    `record pid ${reused?.pid}, expected ${record.pid}`
  )
  await shot('4-reused-project-list')
  await quit(b)
  await Bun.sleep(1500)
  check(
    'reused server is left running on quit',
    pidAlive(record.pid) && (await portOpen(record.port)),
    `pid ${record.pid} still serving port ${record.port}`
  )
  process.kill(record.pid, 'SIGTERM')
  await serverGone(record)
}

const FAKE_SERVER = `#!/usr/bin/env bun
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(req, server) {
    if (new URL(req.url).pathname === '/ws' && server.upgrade(req)) return undefined
    return Response.json({ status: 'ok', allowRemoteWrites: true, caseInsensitivePaths: false })
  },
  websocket: {
    open(ws) { ws.send(JSON.stringify({ sid: null, seq: 0, type: 'auth_required', payload: {} })) },
    message(ws, raw) {
      const { id } = JSON.parse(String(raw))
      ws.send(JSON.stringify({ id, ok: false, err: { code: 'protocol_version_mismatch', message: 'protocol version mismatch: this host speaks version 6; reload the client' } }))
    }
  }
})
`

async function mismatchScenario(): Promise<void> {
  const fake = path.join(ROOT, 'fake-server')
  writeFileSync(fake, FAKE_SERVER)
  chmodSync(fake, 0o755)
  const a = await startApp(appEnv('mismatch', { TERMUL_SERVER_BIN: fake }), 'mismatch')
  await a.app.getByTestId('server-status-error').waitFor({ timeoutMs: WAIT_MS })
  const text = await a.app.getByTestId('server-status-error').textContent()
  await shot('5-version-mismatch')
  check(
    'protocol mismatch shows the error screen',
    text.includes('protocol 6') && text.includes('needs 7'),
    JSON.stringify(text)
  )
  await quit(a)
  check('mismatched server stopped on quit', !(await portOpen(port)), `port ${port} closed`)
}

let failed = false
try {
  for (const scenario of [spawnScenario, crashScenario, reuseScenario, mismatchScenario]) {
    console.log(`-- ${scenario.name}`)
    try {
      await scenario()
    } catch (error) {
      check(scenario.name, false, error instanceof Error ? error.message : String(error))
    }
  }
} finally {
  xvfb.stop()
  failed = results.some((result) => !result.ok)
  writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  console.log(
    `${results.filter((r) => r.ok).length}/${results.length} checks passed; logs in ${ROOT}`
  )
  if (!values.keep && !failed) rmSync(ROOT, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
