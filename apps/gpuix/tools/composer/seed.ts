/**
 * A throwaway termul-server for the composer checks: a project folder with a
 * few files for the @-mention menu, and the prompt-logging agent registered
 * under a fixed device id so the GPUIX scene and the web client both list it.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_DIR } from '../../build'
import { addProject, startTestServer, type TestServer } from '../parity/server'
import { pickPort, registerAgent, stateRoot } from '../shared/seed'
import { connectWs } from '../shared/ws'

export const STATE_ROOT = stateRoot('/tmp/gpuix-o3')
export const COMPOSER_TOKEN = 'gpuix-composer-token'
export const COMPOSER_DEVICE_ID = 'gpuix-composer'
export const COMPOSER_AGENT_ID = 'custom-composer-agent'
export const COMPOSER_PROJECT_ID = 'composer-project'

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
      deviceId: COMPOSER_DEVICE_ID,
      clientInstanceId: 'composer-seed'
    })
    await ws.request('set_default_project', { projectId: COMPOSER_PROJECT_ID })
    await registerAgent(ws, COMPOSER_DEVICE_ID, {
      configId: COMPOSER_AGENT_ID,
      name: 'Composer Agent',
      command: 'bun',
      args: [path.join(import.meta.dir, 'prompt-agent.ts')],
      env: { COMPOSER_PROMPT_LOG: promptLog },
      allowTerminal: false
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
