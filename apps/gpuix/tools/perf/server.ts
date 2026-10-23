import net from 'node:net'
import path from 'node:path'
import { scopedKey } from '../../../../src/shared/types/persistence.types.ts'
import { WS_PROTOCOL_VERSION } from '../../../../src/shared/types/web-protocol.types.ts'
import { REPO_DIR } from '../../build.ts'
import { addProject, startTestServer, type TestServer } from '../parity/server.ts'
import { descendants, readCmdline } from './proc-sampler.ts'

export const PERF_TOKEN = 'perf-token'
export const PERF_DEVICE_ID = 'perf-device'
export const PERF_AGENT_CONFIG_ID = 'custom-perfstub'
export const PERF_AGENT_NAME = 'Perf Stub Agent'
export const PERF_PROJECT_NAME = 'perf-project'

export interface PerfServer extends TestServer {
  /** The termul-server process; the fake agents and PTYs it spawns are its children. */
  pid: number
}

/**
 * Fails when anything already listens on `port`. Without this, /health can
 * answer from another unit's server on the shared 8190-8199 range while ours
 * dies on EADDRINUSE, and the seeding below would write into that server.
 */
export async function assertPortFree(port: number): Promise<void> {
  const probe = net.createServer()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  probe.once('error', (err) => reject(new Error(`port ${port} is taken: ${err.message}`)))
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
  await promise
}

/**
 * The parity harness's test server, seeded with one project and the fake ACP
 * agent from tools/perf, registered the way the app stores a custom agent.
 */
export async function startPerfServer(opts: {
  binary: string
  port: number
  stateRoot: string
  agentEnv: Record<string, string>
}): Promise<PerfServer> {
  await assertPortFree(opts.port)
  const server = await startTestServer({
    binary: opts.binary,
    port: opts.port,
    token: PERF_TOKEN,
    stateDir: path.join(opts.stateRoot, 'server')
  })
  try {
    const pid = descendants(process.pid).find(
      (p) => p !== process.pid && readCmdline(p).includes(opts.binary)
    )
    if (pid === undefined) throw new Error('could not find the spawned termul-server process')
    await addProject(server, {
      id: 'perf-project-0001',
      name: PERF_PROJECT_NAME,
      path: path.join(opts.stateRoot, PERF_PROJECT_NAME),
      color: 'blue'
    })
    await seedFakeAgent(server, opts.agentEnv)
    return { ...server, pid }
  } catch (err) {
    await server.stop()
    throw err
  }
}

async function seedFakeAgent(server: TestServer, env: Record<string, string>): Promise<void> {
  // id equals configId, as the persistence migration backfills it. With the
  // two different, the web launcher's restore check (AgentLauncher #840/#907)
  // rejects the saved pick on its second mount and falls back to Codex.
  const config = {
    id: PERF_AGENT_CONFIG_ID,
    configId: PERF_AGENT_CONFIG_ID,
    name: PERF_AGENT_NAME,
    command: 'bun',
    args: [path.join(REPO_DIR, 'tools', 'perf', 'fake-agent', 'fake-agent.ts')],
    env,
    allowTerminal: false
  }
  const agentsKey = scopedKey('acp/agents', PERF_DEVICE_ID)
  const current = await wsRequest<{ revision: number }>(server, 'store_read', { key: agentsKey })
  await wsRequest(server, 'store_write', {
    key: agentsKey,
    value: { _version: 1, data: [config] },
    baseRevision: current.revision ?? 0
  })
  await wsRequest(server, 'store_write', {
    key: scopedKey('agents/last-selected', PERF_DEVICE_ID),
    value: { _version: 1, data: { mode: 'acp', agentId: PERF_AGENT_CONFIG_ID } }
  })
}

interface ReplyFrame {
  id?: string
  ok?: boolean
  payload?: unknown
  err?: { code?: string; message?: string }
}

function wsRequest<T = unknown>(server: TestServer, type: string, payload: unknown): Promise<T> {
  const socket = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/ws`)
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const timer = setTimeout(() => reject(new Error(`ws ${type} timed out`)), 15_000)
  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        id: 'auth',
        type: 'authenticate',
        payload: {
          protocolVersion: WS_PROTOCOL_VERSION,
          deviceId: PERF_DEVICE_ID,
          clientInstanceId: 'perf-runner',
          token: server.token
        }
      })
    )
  }
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as ReplyFrame
    if (frame.id === 'auth') {
      if (frame.ok) socket.send(JSON.stringify({ id: 'req', type, payload }))
      else reject(new Error(`ws authenticate refused: ${frame.err?.message}`))
      return
    }
    if (frame.id === 'req') {
      if (frame.ok) resolve(frame.payload as T)
      else reject(new Error(`ws ${type}: ${frame.err?.code} ${frame.err?.message}`))
    }
  }
  socket.onerror = () => reject(new Error(`ws ${type}: socket error`))
  return promise.finally(() => {
    clearTimeout(timer)
    socket.close()
  })
}
