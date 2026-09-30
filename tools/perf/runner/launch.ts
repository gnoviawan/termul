/**
 * App launch + CDP attach + teardown (CAP-2) — the runner owns everything
 * between "spawn the real desktop app" and "the tree is dead".
 *
 * Steps (spec I/O matrix):
 *  1. Resolve the app exe (default: worktree release build; override --exe).
 *  2. Pick a free TCP port for `--remote-debugging-port`.
 *  3. Spawn the exe with a per-run scratch `WEBVIEW2_USER_DATA_FOLDER`
 *     (isolates the single-instance plugin AND keeps user data out of runs).
 *  4. Playwright `chromium.connectOverCDP` — retry once if WebView2 ignores
 *     the flag (spec CDP-attach edge), then fail with the actionable error.
 *  5. Expose helpers to invoke Tauri commands through the app's global
 *     internals (`withGlobalTauri: true` exposes
 *     `window.__TAURI_INTERNALS__.invoke`) — the fake-agent config is
 *     registered through the app's own persistence IPC this way.
 *  6. Teardown kills the spawned PID tree (taskkill /T /F on the root, plus
 *     a parent-PID walk for stragglers) and deletes the scratch dir unless
 *     --keep-state.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'

export const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(TOOLKIT_ROOT, '..', '..')
export const RESULTS_ROOT = path.join(REPO_ROOT, 'tools', 'perf', 'results')

/** The app exe resolved from the worktree's release build (fallback: main checkout). */
export function resolveAppExe(override?: string): string {
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`app exe not found: ${override}`)
    }
    return override
  }
  const candidates = [
    // Worktree dev-identifier build first: com.termul-manager.app.dev escapes
    // the single-instance mutex held by any running user install
    // (com.termul-manager.app) — otherwise the spawned exe silently exits via
    // the single-instance plugin before CDP ever answers.
    path.join(REPO_ROOT, 'src-tauri', 'target', 'release', 'termul-manager.exe'),
    path.join(
      REPO_ROOT,
      'src-tauri',
      'target',
      'x86_64-pc-windows-msvc',
      'release',
      'termul-manager.exe'
    ),
    // Main checkout fallback (same repo, built there before the worktree split).
    path.resolve(
      REPO_ROOT,
      '..',
      'termul',
      'src-tauri',
      'target',
      'x86_64-pc-windows-msvc',
      'release',
      'termul-manager.exe'
    )
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    `app exe not found; build it with \`bun run build:tauri:win\` or pass --exe <path>. Tried:\n  ${candidates.join('\n  ')}`
  )
}

/** Grab a free TCP port (bind 0, read the assigned port, close). */
export async function pickFreePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const srv = net.createServer()
  srv.unref()
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address()
    if (addr && typeof addr === 'object') {
      const port = addr.port
      srv.close(() => resolve(port))
      return
    }
    srv.close()
    reject(new Error('could not pick a free port'))
  })
  return promise
}

export interface LaunchOptions {
  exe?: string
  /** Per-run scratch dir (created under RESULTS_ROOT/<runId>/userdata). */
  runId: string
  /** Extra env passed to the app (fake-agent knobs etc.). */
  env?: Record<string, string>
  /** Keep the scratch user-data dir after teardown (debugging). */
  keepState?: boolean
  /** Max wait for the CDP endpoint after spawn (ms). */
  attachTimeoutMs?: number
}

export interface AppHandle {
  exe: string
  rootPid: number
  debugPort: number
  scratchDir: string
  browser: Browser
  /** The main-window page (resolves after the app document exists). */
  page(): Promise<Page>
  /** Evaluate an expression in the page's main world, return JSON value. */
  evaluate<T>(expression: string): Promise<T>
  /**
   * Invoke a Tauri command through the app's global internals
   * (`withGlobalTauri: true` exposes `window.__TAURI_INTERNALS__.invoke`).
   */
  tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  /** Tear down: close browser, kill the PID tree, delete scratch dir. */
  teardown(): Promise<void>
}

/** Wait until the CDP HTTP endpoint answers /json/version. */
async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `CDP endpoint did not answer on 127.0.0.1:${port} within ${timeoutMs}ms (last: ${String(lastErr)})`
  )
}

/** PowerShell one-shot: enumerate the descendant PIDs of a root. */
const TREE_WALK_VARS = [
  '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId',
  '$byParent = @{}',
  'foreach ($p in $all) { $key = [int]$p.ParentProcessId; if (-not $byParent.ContainsKey($key)) { $byParent[$key] = @() }; $byParent[$key] += $p }',
  '$seen = New-Object System.Collections.Generic.HashSet[int]',
  '$queue = New-Object System.Collections.Generic.Queue[int]'
]

/** Run a PowerShell script to completion (fire-and-forget output). */
function runPowerShell(script: string): Promise<void> {
  const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore'
  })
  return new Promise((resolve) => {
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

/** Kill a PID tree: taskkill /T /F on the root, then parent-walk stragglers. */
export async function killPidTree(rootPid: number): Promise<void> {
  // Primary: Windows taskkill with tree semantics (/T kills descendants).
  try {
    const proc = spawn('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve())
      proc.on('error', () => resolve())
    })
  } catch {
    // fall through to the straggler sweep
  }
  // Straggler sweep: any process whose parent chain reaches rootPid but that
  // survived taskkill (e.g. re-parented or raced spawns).
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    ...TREE_WALK_VARS,
    `$queue.Enqueue(${rootPid})`,
    `[void]$seen.Add(${rootPid})`,
    'while ($queue.Count -gt 0) {',
    '  $cur = $queue.Dequeue()',
    '  if ($byParent.ContainsKey($cur)) {',
    '    foreach ($child in $byParent[$cur]) {',
    '      $cpid = [int]$child.ProcessId',
    '      if (-not $seen.Contains($cpid)) { [void]$seen.Add($cpid); $queue.Enqueue($cpid) }',
    '    }',
    '  }',
    '}',
    '$alive = @($all | Where-Object { $seen.Contains([int]$_.ProcessId) })',
    'foreach ($p in $alive) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join('\n')
  await runPowerShell(script)
}

/** Spawn the exe with WebView2 flags; returns the root PID. */
function spawnApp(
  exe: string,
  debugPort: number,
  scratchDir: string,
  env: Record<string, string>
): number {
  const child = spawn(exe, [], {
    env: {
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
      WEBVIEW2_USER_DATA_FOLDER: scratchDir
    },
    windowsHide: false,
    stdio: 'ignore',
    detached: false
  })
  if (child.pid === undefined) {
    throw new Error(`failed to spawn app: ${exe}`)
  }
  return child.pid
}

/** Find the app's main window page on the connected browser. */
async function findMainPage(browser: Browser, debugPort: number): Promise<Page> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const pages = browser.contexts().flatMap((c) => c.pages())
    const appPages = pages.filter((p) => !p.url().startsWith('devtools://'))
    const target = appPages.find((p) => p.url().includes('tauri-index')) ?? appPages[0]
    if (target) {
      try {
        // networkidle waits out the app's own boot navigation (router
        // redirect + data loads) — evaluate on a settling context gets
        // 'execution context destroyed' while the first navigation is
        // still in flight. domcontentloaded alone is too early.
        await target.waitForLoadState('networkidle', { timeout: 15_000 })
      } catch {
        // continue — evaluate attempts will surface problems
      }
      return target
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no page target appeared on the CDP endpoint (port ${debugPort}); pages: ${pages.length}`
      )
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Launch the app and attach over CDP. Throws with actionable context on failure. */
export async function launchApp(opts: LaunchOptions): Promise<AppHandle> {
  const exe = resolveAppExe(opts.exe)
  const debugPort = await pickFreePort()
  const runDir = path.join(RESULTS_ROOT, opts.runId)
  const scratchDir = path.join(runDir, 'userdata')
  mkdirSync(scratchDir, { recursive: true })

  const attachTimeout = opts.attachTimeoutMs ?? 30_000
  const cleanProcessEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) cleanProcessEnv[k] = v
  }
  const baseEnv: Record<string, string> = { ...cleanProcessEnv, ...(opts.env ?? {}) }

  const rootPid = spawnApp(exe, debugPort, scratchDir, baseEnv)
  let browser: Browser
  try {
    await waitForCdp(debugPort, attachTimeout)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
  } catch (err) {
    // Spec CDP-attach edge: retry ONCE with a fresh port (WebView2 sometimes
    // drops the first flag parse), then fail with the actionable error.
    await killPidTree(rootPid)
    if (!opts.keepState) rmSync(scratchDir, { recursive: true, force: true })
    const retryPort = await pickFreePort()
    const retryScratch = `${scratchDir}-retry`
    const retryPid = spawnApp(exe, retryPort, retryScratch, baseEnv)
    try {
      await waitForCdp(retryPort, 15_000)
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${retryPort}`)
    } catch (retryErr) {
      await killPidTree(retryPid)
      throw new Error(
        `CDP attach failed twice. Original: ${String(err)}; retry: ${String(retryErr)}. ` +
          `Scratch dirs: ${scratchDir}, ${retryScratch}. Ports: ${debugPort}, ${retryPort}. ` +
          `Check that WebView2 accepts WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and no other instance holds the folder.`
      )
    } finally {
      if (!opts.keepState) rmSync(retryScratch, { recursive: true, force: true })
    }
    const retryHandle = buildHandle({
      exe,
      rootPid: retryPid,
      debugPort: retryPort,
      scratchDir: retryScratch,
      browser,
      keepState: opts.keepState
    })
    await prepareWindow(retryHandle)
    return retryHandle
  }
  const handle = buildHandle({
    exe,
    rootPid,
    debugPort,
    scratchDir,
    browser,
    keepState: opts.keepState
  })
  await prepareWindow(handle)
  return handle
}

/**
 * Maximize + focus the app window before scenarios start driving it. The
 * spawned window can come up tiny (the default 1200×800 conf is only a
 * request; WebView2 honors the OS-reported size, and a spawn during user
 * activity can land far smaller). A sub-300px viewport squeezes the pane
 * composer to zero width, which reads as 'hidden' to Playwright.
 */
async function prepareWindow(handle: AppHandle): Promise<void> {
  await handle.tauriInvoke('plugin:window|maximize').catch(() => undefined)
  await handle.tauriInvoke('plugin:window|set_focus').catch(() => undefined)
}

interface HandleArgs {
  exe: string
  rootPid: number
  debugPort: number
  scratchDir: string
  browser: Browser
  keepState?: boolean
}

function buildHandle(args: HandleArgs): AppHandle {
  const { exe, rootPid, debugPort, scratchDir, browser, keepState } = args
  const pagePromise = findMainPage(browser, debugPort)

  const evaluate = async <T>(expression: string): Promise<T> => {
    const page = await pagePromise
    try {
      return (await page.evaluate(expression)) as T
    } catch (err) {
      throw new Error(
        `page.evaluate failed: ${String(err)}\nexpression: ${expression.slice(0, 200)}`
      )
    }
  }

  const tauriInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const expression =
      args === undefined
        ? `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})`
        : `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`
    return evaluate<T>(expression)
  }

  const teardown = async (): Promise<void> => {
    try {
      const page = await pagePromise.catch(() => null)
      if (page) await page.close().catch(() => undefined)
    } catch {
      // page may already be gone
    }
    try {
      await browser.close()
    } catch {
      // browser connection may already be dead
    }
    await killPidTree(rootPid)
    if (!keepState) {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  }

  return {
    exe,
    rootPid,
    debugPort,
    scratchDir,
    browser,
    page: () => pagePromise,
    evaluate,
    tauriInvoke,
    teardown
  }
}
