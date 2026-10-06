import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FullConfig } from 'playwright/test'
import { type SeededServer, startSeededServer } from './helpers'

/**
 * Global setup: one isolated termul-server per suite run.
 *
 * Requires (enforced, with the exact command printed on failure):
 * - `bun run build:web` — serves the freshly built web client.
 * - `cargo build --release --bin termul-server --features standalone-server`
 *
 * Everything is throwaway: mkdtemp state dir, loopback bind, fixed port via
 * E2E_PORT (default 8188). The fake agent (tests/e2e/fake-longrun-agent.ts)
 * is spawned per chat turn by the server itself — no long-lived processes.
 */

/** Shared handle so the teardown closure can stop the server. */
const e2eGlobals = globalThis as typeof globalThis & { __E2E_SERVER__?: SeededServer }

let server: SeededServer | null = null

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const thisDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(thisDir, '..', '..')
  const serverBinary = join(repoRoot, 'src-tauri', 'target', 'release', 'termul-server')

  if (!existsSync(serverBinary)) {
    throw new Error(
      `termul-server binary missing at ${serverBinary}.\n` +
        'Build it first: cargo build --release --bin termul-server --features standalone-server'
    )
  }
  const distWeb = join(repoRoot, 'dist-web', 'index.html')
  if (!existsSync(distWeb)) {
    throw new Error(`dist-web/ missing at ${repoRoot}/dist-web.\nBuild it first: bun run build:web`)
  }

  // Deterministic workspace: three project dirs (proj-a/b/c) reused across
  // the whole run — sessions persist per project in the server state dir.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'termul-e2e-work-'))
  for (const name of ['proj-a', 'proj-b', 'proj-c', 'proj-e']) {
    await mkdir(join(workspaceRoot, name), { recursive: true })
  }

  server = await startSeededServer({
    serverBinary,
    workspaceRoot,
    fakeAgentScript: join(thisDir, 'fake-longrun-agent.ts')
  })
  process.env.E2E_WORKSPACE_ROOT = workspaceRoot
  e2eGlobals.__E2E_SERVER__ = server
}

export async function teardown(): Promise<void> {
  const serverRef = server ?? e2eGlobals.__E2E_SERVER__
  if (serverRef) {
    await serverRef.stop()
  }
  const workspaceRoot = process.env.E2E_WORKSPACE_ROOT
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  }
}
