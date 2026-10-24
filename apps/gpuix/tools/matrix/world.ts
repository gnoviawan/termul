/**
 * The one seeded server every matrix surface runs against.
 *
 * - alpha: a git repo with three commits, a second branch, a staged edit, an
 *   unstaged edit and an untracked file, plus source and markdown files for
 *   the explorer and the editors.
 * - beta: a plain folder. gamma: a plain folder the rename surface renames.
 *   delta: a plain folder only the remove-project surface touches (each run
 *   re-adds it), so no chat another surface started there blocks the delete.
 * - a chat session in alpha with the scripted agent's three turns. The agent
 *   is `agent.ts`, which adds plan, permission and hold prompts.
 *
 * Every client run uses a fresh device id, so device-scoped UI state (open
 * tabs, side-panel tab, layout) never leaks from one run into the next.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { addProject, startTestServer, type TestServer } from '../parity/server'
import { agentConfig, sendPrompt } from '../chat/seed'
import { SCRIPT_PROMPTS } from '../chat/script'
import { type AgentConfig, registerAgent } from '../shared/seed'
import { commandId, connectWs, type WsClient } from '../shared/ws'

export const TOKEN = 'gpuix-m1-matrix'

export const PROJECTS = {
  alpha: { id: 'm1-alpha', name: 'alpha', color: 'blue' },
  beta: { id: 'm1-beta', name: 'beta', color: 'green' },
  gamma: { id: 'm1-gamma', name: 'gamma', color: 'purple' },
  delta: { id: 'm1-delta', name: 'delta', color: 'orange' }
} as const
export type ProjectKey = keyof typeof PROJECTS

export interface World {
  server: TestServer
  ws: WsClient
  root: string
  dirs: Record<ProjectKey, string>
  agent: AgentConfig
  chat: { agentId: string; sessionId: string }
  /** alpha's seeded HEAD, so a surface that commits can be rewound. */
  alphaHead: string
  /** HTTP call to the server with the token. */
  fetch(route: string, init?: RequestInit): Promise<Response>
}

const GIT_ID = ['-c', 'user.name=Matrix', '-c', 'user.email=matrix@example.invalid']

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(['git', ...GIT_ID, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

function write(dir: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  writeFileSync(path.join(dir, file), text)
}

const APP_TS = `export function greet(name: string): string {
  return \`Hello, \${name}!\`
}

export const VERSION = '1.0.0'
`

const GUIDE_MD = `# Alpha guide

Alpha is the matrix's seeded project.

## Setup

- Install the tools
- Run the tests
`

function seedAlphaRepo(dir: string): string {
  write(dir, 'README.md', '# alpha\n\nThe matrix project.\n')
  write(dir, 'src/app.ts', APP_TS)
  write(dir, 'docs/guide.md', GUIDE_MD)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'initial commit')
  write(dir, 'src/utils.ts', 'export const add = (a: number, b: number) => a + b\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'add utils')
  git(dir, 'branch', 'feature/login')
  write(dir, 'README.md', '# alpha\n\nThe matrix project.\n\nSee docs/guide.md.\n')
  git(dir, 'commit', '-q', '-am', 'link the guide')
  const head = git(dir, 'rev-parse', 'HEAD')
  resetAlphaChanges(dir, head)
  return head
}

/** Put alpha's working tree back to the seeded changes: one staged, one unstaged, one untracked. */
export function resetAlphaChanges(dir: string, head: string): void {
  git(dir, 'checkout', '-q', '-f', 'main')
  git(dir, 'reset', '-q', '--hard', head)
  git(dir, 'clean', '-fdq')
  write(dir, 'src/app.ts', APP_TS.replace("'1.0.0'", "'1.1.0'"))
  git(dir, 'add', 'src/app.ts')
  write(dir, 'README.md', '# alpha\n\nThe matrix project.\n\nSee docs/guide.md.\n\nAn unstaged line.\n')
  write(dir, 'notes.txt', 'untracked notes\n')
}

export async function createWorld(opts: { port: number; root: string }): Promise<World> {
  const server = await startTestServer({ port: opts.port, token: TOKEN, stateDir: path.join(opts.root, 'server') })
  const dirs = Object.fromEntries(
    (Object.keys(PROJECTS) as ProjectKey[]).map((key) => [key, path.join(opts.root, 'projects', PROJECTS[key].name)])
  ) as Record<ProjectKey, string>
  const fetchServer = async (route: string, init: RequestInit = {}) => {
    const res = await fetch(`${server.baseUrl}${route}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) }
    })
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${route}: HTTP ${res.status} ${await res.text()}`)
    return res
  }
  try {
    for (const key of Object.keys(PROJECTS) as ProjectKey[]) {
      await addProject(server, { ...PROJECTS[key], path: dirs[key] })
    }
    const alphaHead = seedAlphaRepo(dirs.alpha)
    write(dirs.beta, 'index.js', "console.log('beta')\n")
    write(dirs.gamma, 'todo.md', '# gamma\n')
    write(dirs.delta, 'todo.md', '# delta\n')

    const ws = await connectWs({ baseUrl: server.baseUrl, token: TOKEN, deviceId: 'm1-seed', clientInstanceId: 'm1-seed' })
    await ws.request('set_default_project', { projectId: PROJECTS.alpha.id })
    const agent = { ...agentConfig(), args: [path.join(import.meta.dir, 'agent.ts')] }
    await registerAgent(ws, 'm1-seed', agent)
    const { agentId } = await ws.request<{ agentId: string }>(
      'spawn_agent',
      { config: agent, projectId: PROJECTS.alpha.id },
      { commandId: commandId('spawn') }
    )
    const { sessionId } = await ws.request<{ sessionId: string }>(
      'create_session',
      { agentId, cwd: dirs.alpha, projectId: PROJECTS.alpha.id },
      { commandId: commandId('session') }
    )
    for (const prompt of SCRIPT_PROMPTS) await sendPrompt(ws, { agentId, sessionId }, prompt)
    return { server, ws, root: opts.root, dirs, agent, chat: { agentId, sessionId }, alphaHead, fetch: fetchServer }
  } catch (error) {
    await server.stop()
    throw error
  }
}

/** Give a fresh device the scripted agent as its launcher pick. */
export async function prepareDevice(world: World, deviceId: string): Promise<void> {
  // A device key is writable only from a connection that authenticated as that device.
  const ws = await connectWs({ baseUrl: world.server.baseUrl, token: TOKEN, deviceId, clientInstanceId: `${deviceId}-seed` })
  try {
    await registerAgent(ws, deviceId, world.agent)
  } finally {
    ws.close()
  }
}

/** Re-add `key` when an earlier run removed it, and restore its seeded name and colour. */
export async function ensureProject(world: World, key: ProjectKey): Promise<void> {
  const project = PROJECTS[key]
  const list = (await (await world.fetch('/projects')).json()) as unknown
  const rows = (Array.isArray(list) ? list : ((list as { projects?: unknown[] }).projects ?? [])) as { id: string }[]
  if (!rows.some((row) => row.id === project.id)) {
    await addProject(world.server, { ...project, path: world.dirs[key] })
    return
  }
  await world.fetch(`/projects/${project.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: project.name, color: project.color })
  })
}

/** Rewind alpha to the seeded commit and working-tree changes. */
export async function resetAlpha(world: World): Promise<void> {
  resetAlphaChanges(world.dirs.alpha, world.alphaHead)
}

/** Set the shared colour theme (a theme family and dark or light), the way the settings store writes it. */
export async function setTheme(world: World, family: string, mode: 'dark' | 'light'): Promise<void> {
  const key = 'shared/lww/settings/app'
  const current = await world.ws.request<{ revision?: number; value?: { data?: Record<string, unknown> } }>('store_read', { key })
  await world.ws.request('store_write', {
    key,
    value: { _version: 1, data: { ...(current.value?.data ?? {}), colorTheme: family, appearanceMode: mode } },
    baseRevision: current.revision ?? 0
  })
}
