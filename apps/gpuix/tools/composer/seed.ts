/**
 * A throwaway termul-server for the composer checks: a project folder with a
 * few files for the @-mention menu, and the prompt-logging agent registered
 * under a fixed device id so the GPUIX scene and the web client both list it.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { scopedKey } from '../../../../src/shared/types/persistence.types.ts'
import { REPO_DIR } from '../../build'
import { addProject, startTestServer, type TestServer } from '../parity/server'
import { connectWs } from './ws'

export const STATE_ROOT = '/tmp/gpuix-o3'
export const COMPOSER_TOKEN = 'gpuix-composer-token'
export const COMPOSER_DEVICE_ID = 'gpuix-composer'
export const COMPOSER_AGENT_ID = 'custom-composer-agent'
export const COMPOSER_PROJECT_ID = 'composer-project'
const PORTS = [8190, 8199] as const

export const PROJECT_FILES = ['src/app.ts', 'src/api.ts', 'README.md', 'docs/guide.md']

export interface ComposerServer {
  server: TestServer
  root: string
  promptLog: string
  deviceId: string
  agentConfigId: string
  projectId: string
  stop(): Promise<void>
}

function isPortFree(port: number): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function pickPort(): Promise<number> {
  for (let port = PORTS[0]; port <= PORTS[1]; port++) if (await isPortFree(port)) return port
  throw new Error(`no free port in ${PORTS.join('-')}`)
}

/**
 * The @-mention search shells out to ripgrep, which this host has only as the
 * repo's sidecar. Put it on the server's PATH under the name it looks for.
 */
function exposeRipgrep(): void {
  const dir = path.join(STATE_ROOT, 'bin')
  const link = path.join(dir, 'rg')
  if (!existsSync(link)) {
    mkdirSync(dir, { recursive: true })
    symlinkSync(path.join(REPO_DIR, 'src-tauri/bin/rg-x86_64-unknown-linux-gnu'), link)
  }
  if (!process.env.PATH?.split(':').includes(dir))
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`
}

export async function seedComposerServer(): Promise<ComposerServer> {
  exposeRipgrep()
  const port = await pickPort()
  const base = path.join(STATE_ROOT, `run-${port}`)
  rmSync(base, { recursive: true, force: true })
  const root = path.join(base, 'project')
  for (const file of PROJECT_FILES) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), `// ${file}\n`)
  }
  const promptLog = path.join(base, 'prompts.jsonl')
  const server = await startTestServer({
    port,
    token: COMPOSER_TOKEN,
    stateDir: path.join(base, 'server')
  })
  const stop = async () => {
    await server.stop()
    rmSync(base, { recursive: true, force: true })
  }
  try {
    await addProject(server, {
      id: COMPOSER_PROJECT_ID,
      name: 'composer-project',
      path: root,
      color: 'blue'
    })
    const ws = await connectWs({
      baseUrl: server.baseUrl,
      token: COMPOSER_TOKEN,
      deviceId: COMPOSER_DEVICE_ID
    })
    await ws.request('set_default_project', { projectId: COMPOSER_PROJECT_ID })
    const agentsKey = scopedKey('acp/agents', COMPOSER_DEVICE_ID)
    const config = {
      configId: COMPOSER_AGENT_ID,
      name: 'Composer Agent',
      command: 'bun',
      args: [path.join(import.meta.dir, 'prompt-agent.ts')],
      env: { COMPOSER_PROMPT_LOG: promptLog },
      allowTerminal: false
    }
    const current = await ws.request<{ revision?: number }>('store_read', { key: agentsKey })
    await ws.request('store_write', {
      key: agentsKey,
      value: { _version: 1, data: [{ id: COMPOSER_AGENT_ID, ...config }] },
      baseRevision: current.revision ?? 0
    })
    await ws.request('store_write', {
      key: scopedKey('agents/last-selected', COMPOSER_DEVICE_ID),
      value: { _version: 1, data: { mode: 'acp', agentId: COMPOSER_AGENT_ID } }
    })
    ws.close()
    return {
      server,
      root,
      promptLog,
      deviceId: COMPOSER_DEVICE_ID,
      agentConfigId: COMPOSER_AGENT_ID,
      projectId: COMPOSER_PROJECT_ID,
      stop
    }
  } catch (error) {
    await stop()
    throw error
  }
}
