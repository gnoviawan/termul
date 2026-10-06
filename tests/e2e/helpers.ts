import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'playwright/test'
import type { APIRequestContext } from 'playwright-core'
import type { WebSocket as WsSocket } from 'ws'
import { WebSocket as WsSocketCtor } from 'ws'

export const E2E_TOKEN = 'e2e-test-token-12345'
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8188)
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`

/** Wait for the server's /health to answer with status ok. */
export async function waitForHealth(base: string, timeoutMs = 30_000): Promise<void> {
  const api = await request.newContext()
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const res = await api.get(`${base}/health`)
        if (res.ok()) return
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`server at ${base} never became healthy`)
      await sleep(250)
    }
  } finally {
    await api.dispose()
  }
}

export interface SeededServer {
  child: ChildProcess
  stateDir: string
  projectIds: Record<'a' | 'b' | 'c' | 'e' | 'w', string>
  stop: () => Promise<void>
}

/** The release binary name (`.exe` on Windows). */
export function serverBinaryName(): string {
  return process.platform === 'win32' ? 'termul-server.exe' : 'termul-server'
}

/**
 * Spawn an isolated termul-server with a throwaway state dir + three
 * registered projects (proj-a/b/c) + the fake long-running agent config in
 * the server-side store (`acp/agents`) so the web launcher shows a ready
 * agent without any user setup.
 */
export async function startSeededServer(opts: {
  serverBinary: string
  workspaceRoot: string
  fakeAgentScript: string
}): Promise<SeededServer> {
  const stateDir = await mkdtemp(join(tmpdir(), 'termul-e2e-state-'))
  const projectsFile = join(stateDir, 'projects.json')
  const child = spawn(
    opts.serverBinary,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(E2E_PORT),
      '--state-dir',
      stateDir,
      '--sessions-dir',
      join(stateDir, 'sessions'),
      '--projects-file',
      projectsFile,
      '--project-root',
      opts.workspaceRoot
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TERMUL_WEB_AUTH_TOKEN: E2E_TOKEN,
        RUST_LOG: 'termul_manager_lib=info'
      }
    }
  )
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)

  const baseUrl = E2E_BASE_URL
  // Best-effort cleanup when seeding fails after the server bound — the
  // caller (global-setup) cannot know the child/state dir otherwise.
  let seeded = false
  const stop = async (): Promise<void> => {
    await killAndWait(child)
    if (!seeded) await rm(stateDir, { recursive: true, force: true }).catch(() => {})
  }
  try {
    await waitForHealth(baseUrl)

    // Register three projects (HTTP parity of the WS add_project).
    const api: APIRequestContext = await request.newContext()
    try {
      const auth = { Authorization: `Bearer ${E2E_TOKEN}` } as const
      for (const [suffix, path] of [
        ['a', join(opts.workspaceRoot, 'proj-a')],
        ['b', join(opts.workspaceRoot, 'proj-b')],
        ['c', join(opts.workspaceRoot, 'proj-c')],
        ['e', join(opts.workspaceRoot, 'proj-e')],
        // proj-w is a real git repo (global-setup runs `git init` + one
        // commit) — the worktree-launch suite targets it.
        ['w', join(opts.workspaceRoot, 'proj-w')]
      ] as const) {
        const res = await api.post(`${baseUrl}/projects`, {
          headers: { ...auth, 'content-type': 'application/json' },
          data: { id: `e2e-proj-${suffix}`, name: `proj-${suffix}`, path, color: 'blue' }
        })
        if (!res.ok()) throw new Error(`project registration failed: ${res.status()}`)
      }
    } finally {
      await api.dispose()
    }

    // Seed the fake agent config into the server store via the WS relay.
    const agentConfig = {
      id: 'fake-longrun',
      templateId: 'fake-longrun',
      configId: 'fake-longrun',
      name: 'Fake Longrun',
      command: 'bun',
      args: [opts.fakeAgentScript],
      env: {},
      allowTerminal: false
    }
    await wsRequest(baseUrl, 'store_write', {
      key: 'acp/agents',
      value: { _version: 1, data: [agentConfig] }
    })
    seeded = true
  } catch (error) {
    await stop()
    throw error
  }

  return {
    child,
    stateDir,
    baseUrl,
    projectIds: {
      a: 'e2e-proj-a',
      b: 'e2e-proj-b',
      c: 'e2e-proj-c',
      e: 'e2e-proj-e',
      w: 'e2e-proj-w'
    },
    stop: async () => {
      await killAndWait(child)
      await rm(stateDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** SIGTERM → SIGKILL → wait for the process to actually exit. */
async function killAndWait(child: ChildProcess, termGraceMs = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.on('exit', () => resolve(true))),
    sleep(termGraceMs).then(() => false)
  ])
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))
  }
}

/**
 * Raw WS request against the relay's `/ws` (authenticate handshake included).
 * Resolves with the reply payload, rejects on `ok: false` with the code.
 * Each call opens its own short-lived connection — simple and sufficient for
 * setup/verification probes.
 */
export function wsRequest<T = unknown>(
  baseUrl: string,
  type: string,
  payload: unknown,
  timeoutMs = 15_000
): Promise<T> {
  const wsUrl = baseUrl.replace(/^http/, 'ws')
  return new Promise<T>((resolve, reject) => {
    const socket: WsSocket = new WsSocketCtor(`${wsUrl}/ws`)
    const requestFrame = { id: 'e2e-req', type, payload }
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`wsRequest(${type}) timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    socket.on('open', () => {
      socket.send(
        JSON.stringify({ id: 'auth', type: 'authenticate', payload: { token: E2E_TOKEN } })
      )
    })
    socket.on('message', (data: unknown) => {
      const frame = JSON.parse(String(data)) as {
        type?: string
        ok?: boolean
        id?: string
        payload?: unknown
        err?: { code?: string; message?: string }
      }
      if (frame.type === 'auth_required') return
      if (frame.id === 'auth' && frame.ok === true) {
        socket.send(JSON.stringify(requestFrame))
        return
      }
      if (frame.id === 'auth' && frame.ok === false) {
        clearTimeout(timer)
        socket.close()
        reject(new Error('ws authenticate refused'))
        return
      }
      if (frame.ok !== undefined && frame.id === requestFrame.id) {
        clearTimeout(timer)
        socket.close()
        if (frame.ok) resolve(frame.payload as T)
        else reject(new Error(`${frame.err?.code}: ${frame.err?.message}`))
      }
      // events ignored for this helper
    })
    socket.on('error', (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
