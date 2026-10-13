import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'playwright/test'
import type { APIRequestContext } from 'playwright-core'
import type { WebSocket as WsSocket } from 'ws'
import { WebSocket as WsSocketCtor } from 'ws'
import { scopedKey, scopeOf } from '../../src/shared/types/persistence.types'
import { WS_PROTOCOL_VERSION } from '../../src/shared/types/web-protocol.types'

export const E2E_TOKEN = 'e2e-test-token-12345'
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8188)
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`

/**
 * The `deviceId` of every browser context in the suite: playwright.config
 * seeds it into `localStorage['termul.deviceId']`, and the WS helpers below
 * authenticate with it, so device-scoped keys a spec seeds land in the
 * partition the page reads (`device/<deviceId>/…`).
 */
export const E2E_DEVICE_ID = 'e2e-device'

/**
 * One-shot crash arming for the fake ACP agent (crash-recovery suite):
 * write this file before launching a `[CRASH]` prompt; the first armed
 * `session/prompt` consumes it and kills the agent. A re-sent persisted
 * prompt on reopen finds it already consumed — a real crash is a one-time
 * process accident, not a property of the prompt text.
 *
 * The file lives inside the server's private mkdtemp stateDir (0700) —
 * never a predictable path directly under the shared tmpdir (symlink-
 * clobber risk, CodeQL js/insecure-temporary-file). global-setup exports
 * E2E_STATE_DIR so spec workers resolve the same path at call time.
 */
export function armNextAgentCrash(): void {
  const stateDir = process.env.E2E_STATE_DIR
  if (!stateDir) throw new Error('E2E_STATE_DIR unset — run under tests/e2e global-setup')
  writeFileSync(join(stateDir, 'fake-crash-arm'), '1')
}

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
  baseUrl: string
  projectIds: Record<'a' | 'b' | 'c' | 'e' | 'w' | 'x', string>
  stop: () => Promise<void>
}

/** The release binary name (`.exe` on Windows). */
export function serverBinaryName(): string {
  return process.platform === 'win32' ? 'termul-server.exe' : 'termul-server'
}

/**
 * Spawn an isolated termul-server with a throwaway state dir, register the
 * suite's projects (proj-a/b/c/e/w/x) and seed the fake long-running agent
 * config in the server-side store (shared `acp/agents`) so the web launcher
 * shows a ready agent without any user setup.
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
      projectsFile
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
    // The health probe is port-scoped, not child-scoped: a leaked server from
    // a killed run answers /health instantly while THIS child is still
    // starting — its bind attempt (and exit on EADDRINUSE) lands later, so a
    // health-only race can resolve against stale state before the child even
    // fails. Readiness therefore requires the child's OWN bind-confirmation
    // log line plus a healthy probe; the child's early exit still fails fast.
    const childExited = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) => {
        reject(
          new Error(
            `termul-server exited during startup (code=${code} signal=${signal}) — port ${E2E_PORT} may already be bound by a leaked server`
          )
        )
      })
    })
    childExited.catch(() => {}) // swallow the post-health late-exit rejection
    const childListening = new Promise<void>((resolve) => {
      const onData = (chunk: unknown) => {
        if (String(chunk).includes('ACP web server listening')) {
          child.stdout.off('data', onData)
          child.stderr.off('data', onData)
          resolve()
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
    })
    await Promise.race([
      Promise.all([waitForHealth(baseUrl), childListening]).then(() => undefined),
      childExited,
      // Bound the wait: a healthy port answer with no bind log and a live
      // child would otherwise hang forever (weird partial-start state).
      sleep(30_000).then(() => {
        throw new Error(`termul-server did not report its bind on port ${E2E_PORT} within 30s`)
      })
    ])

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
        ['w', join(opts.workspaceRoot, 'proj-w')],
        // proj-x is dedicated to the crash-recovery suite: its chats carry
        // the [CRASH] prompt marker and kill their agent mid-turn, so they
        // must never share an agent process with another suite's chat.
        ['x', join(opts.workspaceRoot, 'proj-x')]
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
      env: {
        TERMUL_FAKE_CRASH_ARM: join(stateDir, 'fake-crash-arm'),
        WIRE_LOG: join(stateDir, 'fake-wire.log')
      },
      allowTerminal: false
    }
    await storeWrite('acp/agents', [agentConfig])
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
      w: 'e2e-proj-w',
      x: 'e2e-proj-x'
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

/** Who a helper connection authenticates as; store keys under `device/<deviceId>/` are its own. */
export interface WsIdentity {
  deviceId: string
  clientInstanceId: string
}

const DEFAULT_WS_IDENTITY: WsIdentity = { deviceId: E2E_DEVICE_ID, clientInstanceId: 'e2e-helper' }

/**
 * The host-store key of a logical persistence key, the way the web client
 * maps it: `device/<deviceId>/<key>`, `shared/lww/<key>` or `shared/cas/<key>`.
 */
export function storeKey(logicalKey: string, identity: WsIdentity = DEFAULT_WS_IDENTITY): string {
  return scopedKey(logicalKey, identity.deviceId)
}

interface StoreReadReply {
  value: unknown
  revision: number
}

/**
 * Read a logical key. `data` is the value inside the client's
 * `{ _version, data }` envelope (`null` when the key is absent); `value` is
 * the stored value as-is and `revision` its store revision (0 = absent).
 */
export async function storeRead<T = unknown>(
  logicalKey: string,
  identity: WsIdentity = DEFAULT_WS_IDENTITY
): Promise<{ data: T | null; value: unknown; revision: number }> {
  const reply = await wsRequest<StoreReadReply>(
    E2E_BASE_URL,
    'store_read',
    { key: storeKey(logicalKey, identity) },
    undefined,
    identity
  )
  const value = reply?.value ?? null
  const data =
    value !== null && typeof value === 'object' && '_version' in value && 'data' in value
      ? value.data
      : value
  // Test-side typing of seeded data; the host stores opaque JSON.
  return { data: data as T | null, value, revision: reply?.revision ?? 0 }
}

/**
 * Replace a logical key with `data` (wrapped as `{ _version: 1, data }`),
 * carrying the precondition its scope requires: none for a device key, the
 * current `baseRevision` for a shared/lww key, `expected` + `commandId` for a
 * shared/cas key.
 */
export async function storeWrite(
  logicalKey: string,
  data: unknown,
  identity: WsIdentity = DEFAULT_WS_IDENTITY
): Promise<void> {
  await storeWriteValue(logicalKey, { _version: 1, data }, identity)
}

/** `storeWrite` for an already wrapped value (restoring what `storeRead` returned). */
export async function storeWriteValue(
  logicalKey: string,
  value: unknown,
  identity: WsIdentity = DEFAULT_WS_IDENTITY
): Promise<void> {
  const payload: Record<string, unknown> = { key: storeKey(logicalKey, identity), value }
  Object.assign(payload, await storePrecondition(logicalKey, identity))
  await wsRequest(E2E_BASE_URL, 'store_write', payload, undefined, identity)
}

/** Delete a logical key with the precondition its scope requires. */
export async function storeDelete(
  logicalKey: string,
  identity: WsIdentity = DEFAULT_WS_IDENTITY
): Promise<void> {
  const payload: Record<string, unknown> = { key: storeKey(logicalKey, identity) }
  Object.assign(payload, await storePrecondition(logicalKey, identity))
  await wsRequest(E2E_BASE_URL, 'store_delete', payload, undefined, identity)
}

async function storePrecondition(
  logicalKey: string,
  identity: WsIdentity
): Promise<Record<string, unknown>> {
  switch (scopeOf(logicalKey)) {
    case 'device':
      return {}
    case 'sharedLww':
      return { baseRevision: (await storeRead(logicalKey, identity)).revision }
    case 'sharedCas':
      return { expected: (await storeRead(logicalKey, identity)).value, commandId: randomUUID() }
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
  timeoutMs = 15_000,
  identity: WsIdentity = DEFAULT_WS_IDENTITY
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
        JSON.stringify({
          id: 'auth',
          type: 'authenticate',
          payload: { token: E2E_TOKEN, protocolVersion: WS_PROTOCOL_VERSION, ...identity }
        })
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
