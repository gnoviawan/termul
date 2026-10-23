/**
 * Seeds one real chat session on a throwaway termul-server: the scenario
 * agent is spawned over `/ws`, a durable session is created in a project that
 * points at a real checkout, and the scripted prompts run to completion.
 *
 *   bun tools/chat/seed.ts [--port 8190] [--root <dir>] [--prompts 3] [--hold] [--out chat.json]
 *
 * Prints the `SeededChat` JSON on stdout. Without `--hold` the server stops
 * and its state dir is deleted; with it the server runs until SIGINT/SIGTERM.
 */

import { writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { scopedKey } from '../../../../src/shared/types/persistence.types.ts'
import { REPO_DIR } from '../../build.ts'
import { addProject, startTestServer } from '../parity/server.ts'
import { stateRoot } from '../shared/seed.ts'
import { SCRIPT_PROMPTS } from './script.ts'
import { commandId, connectWs, type WsClient } from './ws.ts'

export const CHAT_TOKEN = 'gpuix-chat-token'
export const CHAT_DEVICE_ID = 'gpuix-chat'
export const CHAT_AGENT_CONFIG_ID = 'custom-chat-scenario'
export const CHAT_AGENT_NAME = 'Chat Scenario Agent'
export const CHAT_PROJECT_ID = 'chat-project'
const STATE_ROOT = stateRoot('/tmp/gpuix-o2')
const PORT_RANGE = [8190, 8199] as const
const TURN_TIMEOUT_MS = 120_000

export interface SeededChat {
  /** The project's folder: the agent's cwd. */
  root: string
  baseUrl: string
  token: string
  /** The web client must run as this device to see the seeded agent config. */
  deviceId: string
  projectId: string
  sessionId: string
  agentId: string
  /** Opens the chat in the web client; it reads the token from `localStorage['termul.webAuthToken']`. */
  webUrl: string
}

export interface ChatServer {
  chat: SeededChat
  stateDir: string
  /** The seeding socket, kept open with `keepSocket` so the agent session stays live. */
  ws: WsClient | null
  /** Stops the server (and the agent it spawned) and deletes the state dir. */
  stop(): Promise<void>
}

function isPortFree(port: number): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function pickPort(requested?: number): Promise<number> {
  if (requested !== undefined) {
    if (!(await isPortFree(requested))) throw new Error(`port ${requested} is taken`)
    return requested
  }
  for (let port = PORT_RANGE[0]; port <= PORT_RANGE[1]; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port in ${PORT_RANGE.join('-')}`)
}

/** The spawn config; the stored copy adds `id` (equal to `configId`, as the persistence migration backfills it). */
export function agentConfig(env: Record<string, string> = {}) {
  return {
    configId: CHAT_AGENT_CONFIG_ID,
    name: CHAT_AGENT_NAME,
    command: 'bun',
    args: [path.join(import.meta.dir, 'scenario-agent.ts')],
    env,
    allowTerminal: false
  }
}

/** Saves the agent the way the app stores a custom agent, so the launcher lists it. */
async function registerAgentConfig(ws: WsClient, env: Record<string, string>): Promise<void> {
  const agentsKey = scopedKey('acp/agents', CHAT_DEVICE_ID)
  const current = await ws.request<{ revision?: number }>('store_read', { key: agentsKey })
  await ws.request('store_write', {
    key: agentsKey,
    value: { _version: 1, data: [{ id: CHAT_AGENT_CONFIG_ID, ...agentConfig(env) }] },
    baseRevision: current.revision ?? 0
  })
  await ws.request('store_write', {
    key: scopedKey('agents/last-selected', CHAT_DEVICE_ID),
    value: { _version: 1, data: { mode: 'acp', agentId: CHAT_AGENT_CONFIG_ID } }
  })
}

export async function sendPrompt(
  ws: WsClient,
  target: { agentId: string; sessionId: string },
  text: string,
  displayText?: string
): Promise<string> {
  const turnId = commandId('turn')
  const reply = await ws.request<{ stopReason?: string }>(
    'send_prompt',
    {
      ...target,
      text,
      turnId,
      ...(displayText && { displayContent: [{ type: 'text', text: displayText }] })
    },
    { commandId: turnId, timeoutMs: TURN_TIMEOUT_MS }
  )
  return reply.stopReason ?? JSON.stringify(reply)
}

function note(message: string): void {
  console.error(`[chat-seed] ${message}`)
}

export async function seedChat(
  opts: {
    port?: number
    root?: string
    prompts?: number
    keepSocket?: boolean
    /** Environment of the registered agent (`CHAT_STORM_LOG` for the perf storm). */
    agentEnv?: Record<string, string>
  } = {}
): Promise<ChatServer> {
  const root = opts.root ?? REPO_DIR
  const port = await pickPort(opts.port)
  const stateDir = path.join(STATE_ROOT, `chat-${port}`)
  const server = await startTestServer({ port, token: CHAT_TOKEN, stateDir })
  let ws: WsClient | null = null
  const stop = async () => {
    ws?.close()
    await server.stop()
    await rm(stateDir, { recursive: true, force: true })
  }
  note(`server ${server.baseUrl} state ${stateDir}`)
  try {
    await addProject(server, {
      id: CHAT_PROJECT_ID,
      name: path.basename(root),
      path: root,
      color: 'blue'
    })
    ws = await connectWs({
      baseUrl: server.baseUrl,
      token: CHAT_TOKEN,
      deviceId: CHAT_DEVICE_ID,
      clientInstanceId: 'chat-seed'
    })
    await ws.request('set_default_project', { projectId: CHAT_PROJECT_ID })
    await registerAgentConfig(ws, opts.agentEnv ?? {})
    const { agentId } = await ws.request<{ agentId: string }>(
      'spawn_agent',
      { config: agentConfig(opts.agentEnv), projectId: CHAT_PROJECT_ID },
      { commandId: commandId('spawn') }
    )
    const { sessionId } = await ws.request<{ sessionId: string }>(
      'create_session',
      { agentId, cwd: root, projectId: CHAT_PROJECT_ID },
      { commandId: commandId('session') }
    )
    note(`agent ${agentId} session ${sessionId}`)
    for (const prompt of SCRIPT_PROMPTS.slice(0, opts.prompts ?? SCRIPT_PROMPTS.length)) {
      const stopReason = await sendPrompt(ws, { agentId, sessionId }, prompt)
      note(`turn "${prompt.slice(0, 40)}" -> ${stopReason}`)
    }
    const chat: SeededChat = {
      root,
      baseUrl: server.baseUrl,
      token: CHAT_TOKEN,
      deviceId: CHAT_DEVICE_ID,
      projectId: CHAT_PROJECT_ID,
      sessionId,
      agentId,
      webUrl: `${server.baseUrl}/#/c/${encodeURIComponent(sessionId)}`
    }
    if (!opts.keepSocket) {
      ws.close()
      ws = null
    }
    return { chat, stateDir, ws, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      root: { type: 'string' },
      prompts: { type: 'string' },
      hold: { type: 'boolean', default: false },
      out: { type: 'string' }
    }
  })
  const seeded = await seedChat({
    port: values.port ? Number(values.port) : undefined,
    root: values.root ? path.resolve(values.root) : undefined,
    prompts: values.prompts ? Number(values.prompts) : undefined,
    keepSocket: values.hold
  })
  const json = JSON.stringify(seeded.chat, null, 2)
  console.log(json)
  if (values.out) writeFileSync(values.out, `${json}\n`)
  if (values.hold) {
    note('holding; SIGINT or SIGTERM stops the server and deletes its state')
    const release = Promise.withResolvers<void>()
    process.once('SIGINT', () => release.resolve())
    process.once('SIGTERM', () => release.resolve())
    await release.promise
  }
  await seeded.stop()
  note('stopped')
}
