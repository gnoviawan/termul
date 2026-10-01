/**
 * minimize-probe — measure the minimize→restore hang on the real desktop app.
 *
 * Reproduces the user report ("app hangs for a long time when I minimize it")
 * deterministically: launch the dev-identifier build under CDP, seed the
 * perf project + fake agent, open N streaming chats, OS-minimize the window
 * while streams run, wait, restore, then measure:
 *   - evaluate RTT immediately after restore (the user's "hang" = how long
 *     the webview stays unresponsive while it replays the minimized backlog)
 *   - longtasks during the post-restore window (main-thread stall)
 *   - renderer private bytes + CPU while minimized (occlusion suspend check)
 *   - `document.visibilityState` transitions (does minimize even hide the page?)
 *
 * Usage: node tools/perf/minimize-probe.ts [--chats 4] [--minimize-ms 60000]
 *        [--restore-samples 40] [--exe <path>]
 *
 * Prints a JSON result to stdout; nothing is written to results/ — this is a
 * probe, not a scenario.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { buildFakeAgentConfig, registerFakeAgent, seedPerfProject } from './runner/agent-config.ts'
import { launchApp, REPO_ROOT, TOOLKIT_ROOT } from './runner/launch.ts'
import { launchChatViaUI, openLauncher, waitForLauncher } from './runner/scenario-ui.ts'

const flags: Record<string, string> = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--'))
    flags[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? 'true' : (argv[++i] ?? 'true')
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

const CHATS = Math.max(1, Number(flags.chats ?? 4))
const MINIMIZE_MS = Math.max(2000, Number(flags['minimize-ms'] ?? 60_000))
const RESTORE_SAMPLES = Math.max(5, Number(flags['restore-samples'] ?? 40))
const PROMPTS = [
  'Write a detailed 800-word essay comparing event sourcing with CRUD.',
  'Write a TypeScript rate limiter with token bucket + comments.',
  'Draft a design document for terminal session persistence.',
  'Explain how a Tauri app pipes a PTY on Windows via ConPTY.',
  'Write a test plan for a chat streaming UI: ordering, backpressure.',
  'Write a long tutorial on React reconciliation and fibers.'
]

const ps = (script: string): string =>
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  }).trim()

/** OS-level window minimize via user32 ShowWindow(SW_MINIMIZE). */
const minimize = (pid: number): void => {
  ps(
    `Add-Type -Name U32 -Namespace W -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h,int n);';` +
      `$p=Get-Process -Id ${pid};[W.U32]::ShowWindow($p.MainWindowHandle,6)|Out-Null`
  )
}
const restore = (pid: number): void => {
  ps(
    `Add-Type -Name U32 -Namespace W -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h,int n);[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);';` +
      `$p=Get-Process -Id ${pid};[W.U32]::ShowWindow($p.MainWindowHandle,9)|Out-Null;[W.U32]::SetForegroundWindow($p.MainWindowHandle)|Out-Null`
  )
}

/** Sample CPU% + WS of every webview2 child under the app's PID. */
const webviewStats = (): string =>
  ps(
    `$app = Get-Process termul-manager -ErrorAction SilentlyContinue | Select-Object -First 1;` +
      `if (-not $app) { 'no-app'; exit };` +
      `$a = Get-Date; $c1 = @{};` +
      `Get-Process msedgewebview2 -ErrorAction SilentlyContinue | ForEach-Object { $c1[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds };` +
      `Start-Sleep -Milliseconds 800;` +
      `$el = ((Get-Date) - $a).TotalMilliseconds;` +
      `$tot = 0; $ws = 0;` +
      `Get-Process msedgewebview2 -ErrorAction SilentlyContinue | ForEach-Object { $tot += ($_.TotalProcessorTime.TotalMilliseconds - $c1[$_.Id]); $ws += $_.WorkingSet64 };` +
      `[math]::Round($tot / ($el * [Environment]::ProcessorCount) * 100, 1).ToString() + 'pct-ws-' + [math]::Round($ws/1MB).ToString() + 'MB'`
  )

async function main(): Promise<void> {
  const runId = `minimize-${new Date().toISOString().slice(0, 19).replace(/[:]/g, '-')}`
  const scratch = path.join(TOOLKIT_ROOT, 'results', runId)
  mkdirSync(scratch, { recursive: true })

  const handle = await launchApp({ runId, exe: flags.exe })
  const page = await handle.page()
  const out: Record<string, unknown> = { runId, chats: CHATS, minimizeMs: MINIMIZE_MS }

  try {
    // Seed project + fake agent, reload so the launcher mounts.
    mkdirSync(path.join(process.env.TEMP ?? 'C:\\temp', 'termul-perf-project'), {
      recursive: true
    })
    await seedPerfProject(handle, path.join(process.env.TEMP ?? 'C:\\temp', 'termul-perf-project'))
    await registerFakeAgent(
      handle,
      buildFakeAgentConfig(REPO_ROOT, {
        PERF_AGENT_RATE: '20',
        PERF_AGENT_DURATION: '0',
        PERF_AGENT_MOCK: '1',
        PERF_AGENT_TOOL_EVERY: '4'
      })
    )
    await handle.evaluate('location.reload()')
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
    await waitForLauncher(page)

    // Open N streaming chats (all but the last are hidden tabs).
    for (let i = 0; i < CHATS; i++) {
      if (i > 0) await openLauncher(page)
      await launchChatViaUI(page, PROMPTS[i % PROMPTS.length], 'Perf Stub Agent')
      await sleep(800)
    }
    // Let streams build a transcript before minimizing.
    await sleep(8_000)

    // Install a longtask + visibility probe inside the page.
    await handle.evaluate(`(() => {
      window.__probe = { longtasks: [], vis: [], t0: performance.now() };
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__probe.longtasks.push({ t: e.startTime|0, d: e.duration|0 })
      }).observe({ type: 'longtask', buffered: true });
      document.addEventListener('visibilitychange', () =>
        window.__probe.vis.push({ t: performance.now()|0, s: document.visibilityState }));
      return 'armed';
    })()`)

    const pid = handle.rootPid
    const cpuVisible = webviewStats()
    out.cpuVisible = cpuVisible

    // --- minimize ---
    const tMin = Date.now()
    minimize(pid)
    await sleep(1500)
    out.visibilityAfterMinimize = await handle
      .evaluate('document.visibilityState')
      .catch(() => 'eval-timeout')

    // Mid-minimize eval: does the page still run JS while occluded?
    const evalStart = Date.now()
    out.minimizedEvalMs = await handle
      .evaluate('performance.now()')
      .then(() => Date.now() - evalStart)
      .catch(() => 'eval-timeout')
    out.cpuMinimized = webviewStats()

    // Keep it minimized while streams accumulate.
    await sleep(MINIMIZE_MS)
    out.minimizedSeconds = (Date.now() - tMin) / 1000

    // --- restore + hang measurement ---
    const tRestore = Date.now()
    restore(pid)
    out.visibilityAfterRestore = await handle
      .evaluate('document.visibilityState')
      .catch(() => 'eval-timeout')

    // First-eval latency after restore = the user-visible hang.
    const firstEvalStart = Date.now()
    const firstEvalOk = await handle
      .evaluate('performance.now()')
      .then(() => Date.now() - firstEvalStart)
      .catch(() => 'eval-timeout')
    out.restoreFirstEvalMs = firstEvalOk

    // Then sample evaluate RTT until it settles (or RESTORE_SAMPLES hit).
    const rtts: number[] = []
    for (let i = 0; i < RESTORE_SAMPLES; i++) {
      const s = Date.now()
      const ok = await handle
        .evaluate('1')
        .then(() => true)
        .catch(() => false)
      rtts.push(ok ? Date.now() - s : -1)
      if (ok && i > 3 && rtts.slice(-3).every((v) => v >= 0 && v < 50)) break
    }
    out.restoreRtts = rtts
    out.restoreSettleMs = Date.now() - tRestore

    const probe = await handle.evaluate('window.__probe').catch(() => ({ longtasks: [], vis: [] }))
    out.probe = probe
    out.cpuAfterRestore = webviewStats()

    console.log(JSON.stringify(out, null, 2))
  } finally {
    await handle.teardown()
  }
}

main().catch((err) => {
  console.error('probe failed:', err)
  process.exit(1)
})
