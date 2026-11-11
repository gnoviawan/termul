import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FullConfig } from 'playwright/test'
import { type SeededServer, serverBinaryName, startSeededServer } from './helpers'

/**
 * Global setup: one isolated termul-server per suite run.
 *
 * Requires (enforced, with the exact command printed on failure):
 * - `bun run build:web` — serves the freshly built web client.
 * - `cargo build --release --bin troupe-server --features standalone-server`
 *
 * Everything is throwaway: mkdtemp state dir, loopback bind, fixed port via
 * E2E_PORT (default 8188). The fake agent (tests/e2e/fake-longrun-agent.ts)
 * is spawned per chat turn by the server itself — no long-lived processes.
 */

/** Shared handle so the teardown closure can stop the server. */
const e2eGlobals = globalThis as typeof globalThis & { __E2E_SERVER__?: SeededServer }

let server: SeededServer | null = null
let workspaceRoot: string | null = null

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const thisDir = fileURLToPath(new URL('.', import.meta.url))
  const repoRoot = join(thisDir, '..', '..')
  const serverBinary = join(repoRoot, 'src-tauri', 'target', 'release', serverBinaryName())

  if (!existsSync(serverBinary)) {
    throw new Error(
      `troupe-server binary missing at ${serverBinary}.\n` +
        'Build it first: cargo build --release --bin troupe-server --features standalone-server'
    )
  }
  const distWeb = join(repoRoot, 'dist-web', 'index.html')
  if (!existsSync(distWeb)) {
    throw new Error(`dist-web/ missing at ${repoRoot}/dist-web.\nBuild it first: bun run build:web`)
  }

  // Deterministic workspace: four project dirs (proj-a/b/c for the survival
  // suite, proj-e dedicated to the editor suite so chat-tab resume noise
  // never races the editor-tab restore) + proj-w: a real git repo with two
  // commits for the worktree-launch suite (the isolation picker requires a
  // git project — the launcher's `canUseWorktree` gate) + proj-x: a plain
  // dir dedicated to the crash-recovery suite, whose [CRASH] prompts kill
  // the owning agent process and must not share one with other suites.
  workspaceRoot = await mkdtemp(join(tmpdir(), 'termul-e2e-work-'))
  for (const name of ['proj-a', 'proj-b', 'proj-c', 'proj-e', 'proj-x']) {
    await mkdir(join(workspaceRoot, name), { recursive: true })
  }
  const projW = join(workspaceRoot, 'proj-w')
  await mkdir(projW, { recursive: true })
  execSync('git init -q -b main', { cwd: projW })
  execSync('git -c user.email=e2e@termul -c user.name=e2e commit -q --allow-empty -m init', {
    cwd: projW
  })
  // Uncommitted changes for the shell-revamp journeys (Rail Diff stat, Changes
  // panel): one tracked file modified (+2 -1) and one untracked file (+2) =
  // 2 changed files, `+4 -1`. HEAD (and so every worktree born from `main`)
  // is unaffected by them.
  await writeFile(join(projW, 'notes.txt'), 'one\ntwo\nthree\n')
  execSync('git add notes.txt', { cwd: projW })
  execSync('git -c user.email=e2e@termul -c user.name=e2e commit -q -m "add notes"', {
    cwd: projW
  })
  await writeFile(join(projW, 'notes.txt'), 'one\nTWO\nthree\nfour\n')
  await writeFile(join(projW, 'scratch.txt'), 'draft one\ndraft two\n')

  server = await startSeededServer({
    serverBinary,
    workspaceRoot,
    fakeAgentScript: join(thisDir, 'fake-longrun-agent.ts')
  })
  process.env.E2E_WORKSPACE_ROOT = workspaceRoot
  // Spec workers inherit this env — armNextAgentCrash() resolves the
  // crash-arm file inside the private stateDir from it.
  process.env.E2E_STATE_DIR = server.stateDir
  e2eGlobals.__E2E_SERVER__ = server
  // Playwright runs the RETURNED function as global teardown (a bare named
  // `teardown` export is never invoked) — returning it is what actually
  // reaps the server; without this every run leaks the :8188 listener.
  return teardown
}

export async function teardown(): Promise<void> {
  // Stop the server FIRST: it (and its spawned fake-agent children) hold the
  // state dir + port; removing the dir while they run leaks the port into
  // the next suite run. killAndWait in helpers guarantees process exit.
  const serverRef = server ?? e2eGlobals.__E2E_SERVER__
  if (serverRef) {
    await serverRef.stop()
  }
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {})
  }
}
