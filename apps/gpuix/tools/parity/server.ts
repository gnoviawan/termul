/**
 * A throwaway termul-server for parity shots: fixed token, its own state dir,
 * and an HTTP seeding helper. Mirrors `tests/e2e/helpers.ts#startSeededServer`
 * without the e2e suite's fixed port and fake agent.
 */

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { REPO_DIR } from '../../build'

export interface TestServer {
  baseUrl: string
  token: string
  stateDir: string
  stop(): Promise<void>
}

export interface SeedProject {
  id: string
  name: string
  path: string
  color: string
}

const HEALTH_TIMEOUT_MS = 30_000

export function defaultServerBinary(): string {
  const fromEnv = process.env.TERMUL_SERVER_BIN?.trim()
  if (fromEnv) return fromEnv
  const candidates = [
    '/root/gpuix-bin/termul-server',
    path.join(REPO_DIR, 'src-tauri/target/release/termul-server')
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(
      `no termul-server binary: set TERMUL_SERVER_BIN or build one of ${candidates.join(', ')}`
    )
  }
  return found
}

async function waitForHealth(baseUrl: string, exited: Promise<number>): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let gone = false
  void exited.then(() => {
    gone = true
  })
  while (Date.now() < deadline) {
    if (gone) throw new Error(`termul-server exited during startup (is the port taken?)`)
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await Bun.sleep(200)
  }
  throw new Error(`termul-server at ${baseUrl} never became healthy`)
}

export async function startTestServer(opts: {
  port: number
  token: string
  stateDir: string
  binary?: string
}): Promise<TestServer> {
  const binary = opts.binary ?? defaultServerBinary()
  await rm(opts.stateDir, { recursive: true, force: true })
  await mkdir(opts.stateDir, { recursive: true })
  const baseUrl = `http://127.0.0.1:${opts.port}`
  const logFile = Bun.file(path.join(opts.stateDir, 'server.log'))
  const child = Bun.spawn(
    [
      binary,
      '--host',
      '127.0.0.1',
      '--port',
      String(opts.port),
      '--state-dir',
      opts.stateDir,
      '--sessions-dir',
      path.join(opts.stateDir, 'sessions'),
      '--projects-file',
      path.join(opts.stateDir, 'projects.json'),
      '--store-file',
      path.join(opts.stateDir, 'store.json')
    ],
    {
      env: {
        ...process.env,
        TERMUL_WEB_AUTH_TOKEN: opts.token,
        RUST_LOG: 'termul_manager_lib=info'
      },
      stdout: logFile,
      stderr: logFile
    }
  )
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(3000).then(() => false)
      ])
      if (!exited) {
        child.kill('SIGKILL')
        await child.exited
      }
    }
  }
  try {
    await waitForHealth(baseUrl, child.exited)
  } catch (error) {
    await stop()
    throw error
  }
  return { baseUrl, token: opts.token, stateDir: opts.stateDir, stop }
}

async function serverFetch(
  server: TestServer,
  route: string,
  init: RequestInit = {}
): Promise<Response> {
  const res = await fetch(`${server.baseUrl}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${route} failed: HTTP ${res.status}`)
  return res
}

/** Register a project over HTTP (the parity of the WS `add_project`). The folder is created. */
export async function addProject(server: TestServer, project: SeedProject): Promise<void> {
  await mkdir(project.path, { recursive: true })
  await serverFetch(server, '/projects', { method: 'POST', body: JSON.stringify(project) })
}

/** Rename a project over HTTP (the parity of the WS `update_project`). */
export async function renameProject(server: TestServer, id: string, name: string): Promise<void> {
  await serverFetch(server, `/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ name })
  })
}
