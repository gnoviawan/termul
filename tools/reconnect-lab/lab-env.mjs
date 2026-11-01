// Process and browser plumbing for the reconnect lab: an isolated seeded
// termul-server (the same flags and fake agent as tests/e2e/helpers.ts
// startSeededServer, which a plain Node script cannot import), the fault
// proxy in front of it, and one fresh Chromium context per scenario.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const LAB_TOKEN = 'reconnect-lab-token'
export const LAB_DEVICE_ID = 'reconnect-lab-device'
/** Mirrors WS_PROTOCOL_VERSION in src/shared/types/web-protocol.types.ts. */
const WS_PROTOCOL_VERSION = 7

export function repoRoot() {
  return resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
}

/** `playwright` from this checkout's node_modules, else from the main checkout's. */
export function loadPlaywright() {
  const roots = [repoRoot()]
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: repoRoot(),
        encoding: 'utf8'
      }
    ).trim()
    roots.push(dirname(common))
  } catch {
    // not a git checkout
  }
  for (const root of roots) {
    try {
      return createRequire(join(root, 'package.json'))('playwright')
    } catch {
      // try the next root
    }
  }
  throw new Error(`playwright not found in node_modules of: ${roots.join(', ')} (run bun install)`)
}

/** First port from `start` upward that nobody listens on and is not in `taken`. */
export async function freePort(start, taken = new Set()) {
  for (let port = start; port < start + 500; port++) {
    if (taken.has(port)) continue
    const free = await new Promise((resolveFree) => {
      const probe = createServer()
      probe.once('error', () => resolveFree(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree(true)))
    })
    if (free) return port
  }
  throw new Error(`no free port from ${start}`)
}

export function defaultServerBinary() {
  const local = join(repoRoot(), 'src-tauri', 'target', 'release', 'termul-server')
  if (existsSync(local)) return local
  throw new Error(
    `termul-server binary missing at ${local}. Build it with ` +
      '`cargo build --release --bin termul-server --features standalone-server`, ' +
      'or pass --server-bin <path>.'
  )
}

/**
 * Spawn the server on `port` with a throwaway state dir and seed the fake
 * long-running agent. `onLine(line)` receives every server log line.
 */
export async function startLabServer({ binary, port, onLine }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'reconnect-lab-state-'))
  const workspaceRoot = join(stateDir, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  const bunDir = dirname(
    execFileSync('bash', ['-lc', 'command -v bun'], { encoding: 'utf8' }).trim()
  )
  const child = spawn(
    binary,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--state-dir',
      stateDir,
      '--sessions-dir',
      join(stateDir, 'sessions'),
      '--projects-file',
      join(stateDir, 'projects.json')
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${bunDir}:${process.env.PATH}`,
        TERMUL_WEB_AUTH_TOKEN: LAB_TOKEN,
        TERMUL_SERVER_UPDATE_ENABLED: 'false',
        RUST_LOG: process.env.LAB_RUST_LOG ?? 'termul_manager_lib=info'
      }
    }
  )
  const baseUrl = `http://127.0.0.1:${port}`
  let listening = false
  for (const stream of [child.stdout, child.stderr]) {
    let partial = ''
    stream.on('data', (chunk) => {
      const lines = (partial + String(chunk)).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (line.includes('ACP web server listening')) listening = true
        onLine(line)
      }
    })
  }
  const server = {
    child,
    stateDir,
    workspaceRoot,
    baseUrl,
    stop: async () => {
      await killAndWait(child)
      await rm(stateDir, { recursive: true, force: true }).catch(() => {})
    }
  }
  try {
    const deadline = Date.now() + 30_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`termul-server exited with ${child.exitCode}`)
      if (
        listening &&
        (await fetch(`${baseUrl}/health`)
          .then((r) => r.ok)
          .catch(() => false))
      )
        break
      if (Date.now() > deadline) throw new Error(`termul-server on ${port} never became healthy`)
      await sleep(200)
    }
    const fakeAgent = join(repoRoot(), 'tests', 'e2e', 'fake-longrun-agent.ts')
    const agents = await wsRequest(baseUrl, 'store_read', { key: 'shared/lww/acp/agents' })
    await wsRequest(baseUrl, 'store_write', {
      key: 'shared/lww/acp/agents',
      baseRevision: agents?.revision ?? 0,
      value: {
        _version: 1,
        data: [
          {
            id: 'fake-longrun',
            templateId: 'fake-longrun',
            configId: 'fake-longrun',
            name: 'Fake Longrun',
            command: 'bun',
            args: [fakeAgent],
            env: { WIRE_LOG: join(stateDir, 'fake-wire.log') },
            allowTerminal: false
          }
        ]
      }
    })
  } catch (error) {
    await server.stop()
    throw error
  }
  return server
}

export async function killAndWait(child, graceMs = 3_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  const timedOut = await Promise.race([exited.then(() => false), sleep(graceMs).then(() => true)])
  if (timedOut && child.exitCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}

/** One authenticated request over a short-lived `/ws` connection (Node's global WebSocket). */
export function wsRequest(baseUrl, type, payload, timeoutMs = 15_000) {
  return new Promise((resolveReq, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`wsRequest(${type}) timed out`))
    }, timeoutMs)
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 'auth',
          type: 'authenticate',
          payload: {
            token: LAB_TOKEN,
            protocolVersion: WS_PROTOCOL_VERSION,
            deviceId: LAB_DEVICE_ID,
            clientInstanceId: 'reconnect-lab-helper'
          }
        })
      )
    })
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.id === 'auth' && frame.ok === true) {
        socket.send(JSON.stringify({ id: 'lab-req', type, payload }))
        return
      }
      if (frame.id === 'auth' && frame.ok === false) {
        clearTimeout(timer)
        socket.close()
        reject(new Error('ws authenticate refused'))
        return
      }
      if (frame.id === 'lab-req') {
        clearTimeout(timer)
        socket.close()
        if (frame.ok) resolveReq(frame.payload)
        else reject(new Error(`${type}: ${frame.err?.code}: ${frame.err?.message}`))
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`wsRequest(${type}) socket error`))
    })
  })
}

/** Register a fresh project and make it the lab device's active project. */
export async function registerProject(server, label) {
  const name = `lab-${label}-${randomUUID().slice(0, 6)}`
  const id = `lab-${name}`
  const path = join(server.workspaceRoot, name)
  await mkdir(path, { recursive: true })
  // A git repo keeps the client's git-status polling quiet in the timeline.
  execFileSync('git', ['init', '-q'], { cwd: path })
  const res = await fetch(`${server.baseUrl}/projects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LAB_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id, name, path, color: 'blue' })
  })
  if (!res.ok) throw new Error(`project registration failed: ${res.status}`)
  await wsRequest(server.baseUrl, 'store_write', {
    key: `device/${LAB_DEVICE_ID}/active-project`,
    value: { _version: 1, data: id }
  })
  return { id, name }
}

/** Kill every agent the server runs (each scenario launches its own). */
export async function killAgents(server) {
  const agents = await wsRequest(server.baseUrl, 'list_agents', {}).catch(() => [])
  for (const agent of agents) {
    await wsRequest(server.baseUrl, 'kill_agent', { agentId: agent.id }).catch(() => {})
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
}

/**
 * Serve GETs for files that exist under `webDir` from disk (`/` -> index.html)
 * so a client build from this worktree runs against the installed server.
 */
export async function routeWebDir(context, origin, webDir) {
  await context.route(`${origin}/**`, async (route) => {
    const request = route.request()
    if (request.method() !== 'GET') return route.fallback()
    const url = new URL(request.url())
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const file = resolve(webDir, rel)
    if (!file.startsWith(resolve(webDir)) || !existsSync(file) || !statSync(file).isFile()) {
      return route.fallback()
    }
    return route.fulfill({
      status: 200,
      headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' },
      body: readFileSync(file)
    })
  })
}

/** Boot the shell on `project` and start a chat with `prompt` from the empty-pane launcher. */
export async function launchChat(page, origin, project, prompt) {
  await page.goto(`${origin}/#/`)
  await page
    .getByRole('heading', { level: 1, name: `What should we do in ${project.name}?` })
    .waitFor({ state: 'visible', timeout: 60_000 })
  const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
  const start = page.getByRole('button', { name: 'Start agent chat' })
  const deadline = Date.now() + 40_000
  for (;;) {
    await launcher.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(prompt)
    if (await start.isEnabled()) break
    if (Date.now() > deadline) throw new Error('Start agent chat never became enabled')
    await sleep(1_000)
  }
  await start.click()
  await launcher.waitFor({ state: 'hidden', timeout: 60_000 })
}
