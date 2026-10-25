import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { createCollector } from '../../../../../tools/perf/metrics/cdp-collector.ts'
import { pickFreePort } from '../../../../../tools/perf/runner/launch.ts'
import { REPO_DIR } from '../../../build.ts'
import { PERF_AGENT_CONFIG_ID, PERF_AGENT_NAME } from '../server.ts'
import { type ChromiumHandle, chromiumDriver } from './chromium.ts'
import type { ClientDriver, ClientLaunchOptions } from './client.ts'

/**
 * The shipped Windows desktop app (Tauri on WebView2), driven over CDP.
 *
 * It has its own Rust core in process, so this lane starts no termul-server:
 * the agents and shells are children of the app. Its state is seeded before
 * launch, as the server lanes seed their server: `projects.json`, and the
 * retired plugin-store file `termul-data.json`, which the app imports into
 * its store on the first connection (`web/store/desktop_import.rs`).
 *
 * The build must use the perf-only identifier, so wiping its app-data dirs
 * between runs never touches a real install's data, and it must honor
 * `TERMUL_DEV_ALLOW_ENGINE_DEBUG` (see README) so WebView2 opens a debug port.
 */
export const TAURI_IDENTIFIER = 'com.termul-manager.app.perf'

export interface TauriLaunchOptions extends ClientLaunchOptions {
  exe: string
  /** The run's scratch dir; the seeded project lives in `<scratch>/perf-project`. */
  projectDir: string
  agentEnv: Record<string, string>
}

const appDataDirs = () =>
  [process.env.APPDATA, process.env.LOCALAPPDATA].flatMap((root) =>
    root ? [path.join(root, TAURI_IDENTIFIER)] : []
  )

/**
 * WebView2 and the virus scanner can hold these files for a few seconds after
 * the app exits, and Bun's rmSync does not retry EBUSY itself.
 */
const wipeAppData = () => {
  for (const dir of appDataDirs()) {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt === 40) throw err
        Bun.sleepSync(250)
      }
    }
  }
}

function seed(opts: TauriLaunchOptions): void {
  wipeAppData()
  const [dataDir] = appDataDirs()
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(opts.projectDir, { recursive: true })
  writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify({
      schemaVersion: 4,
      projects: [
        {
          id: 'perf-project-0001',
          name: path.basename(opts.projectDir),
          path: opts.projectDir,
          color: 'blue',
          isArchived: false,
          mcpServers: []
        }
      ],
      imported: false
    })
  )
  const agent = {
    id: PERF_AGENT_CONFIG_ID,
    configId: PERF_AGENT_CONFIG_ID,
    name: PERF_AGENT_NAME,
    command: 'bun',
    args: [path.join(REPO_DIR, 'tools', 'perf', 'fake-agent', 'fake-agent.ts')],
    env: opts.agentEnv,
    allowTerminal: false
  }
  writeFileSync(
    path.join(dataDir, 'termul-data.json'),
    JSON.stringify({
      'acp/agents': { _version: 1, data: [agent] },
      'agents/last-selected': { _version: 1, data: { mode: 'acp', agentId: PERF_AGENT_CONFIG_ID } }
    })
  )
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((r) => r.ok)
      .catch(() => false)
    if (ok) return
    if (Date.now() > deadline)
      throw new Error(`WebView2 debug port ${port} never answered: is the exe the perf build?`)
    await Bun.sleep(100)
  }
}

/**
 * Gives the window the size the other clients get, retrying while a
 * navigation replaces the page's context.
 */
async function resize(page: Page, width: number, height: number): Promise<void> {
  const t0 = performance.now()
  for (let attempt = 0; attempt < 20; attempt++) {
    const inner = await page
      .evaluate(
        async ([w, h]) => {
          await (
            window as unknown as {
              __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<unknown> }
            }
          ).__TAURI_INTERNALS__.invoke('plugin:window|set_size', {
            label: 'main',
            value: { Logical: { width: w, height: h } }
          })
          return window.innerWidth
        },
        [width, height] as const
      )
      .catch(() => null)
    if (inner === width) {
      const ms = performance.now() - t0
      if (ms > 500) console.warn(`[perf] tauri resize took ${Math.round(ms)} ms`)
      return
    }
    await Bun.sleep(150)
  }
  console.warn(`[perf] tauri window not resized to ${width}x${height}`)
}

export async function launchTauri(opts: TauriLaunchOptions): Promise<ChromiumHandle> {
  seed(opts)
  // win32.ts binds kernel32 at load, so only a Windows run may import it.
  const { processCreatedMs } = await import('../win32.ts')
  const port = await pickFreePort()
  const calledAt = Date.now()
  const t0 = performance.now()
  // Started as Explorer starts it, with no std handles: given redirected ones
  // (even NUL), the shells in its ConPTYs inherit them and the terminals stay blank.
  const started = Bun.spawnSync(
    [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Start-Process -FilePath '${opts.exe.replace(/'/g, "''")}' -PassThru).Id`
    ],
    {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
        TERMUL_DEV_ALLOW_ENGINE_DEBUG: '1'
      }
    }
  )
  const rootPid = Number(started.stdout.toString().trim())
  if (!Number.isInteger(rootPid) || rootPid <= 0)
    throw new Error(`could not start ${opts.exe}: ${started.stderr.toString().trim()}`)
  // Time the startup from the process's creation, not from PowerShell's start.
  const launchOverheadMs = Math.max(0, (processCreatedMs(rootPid) ?? calledAt) - calledAt)
  // The next run's seed wipes the app-data dirs again, so a dir still locked here is not fatal.
  const kill = () => {
    Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(rootPid)])
    try {
      wipeAppData()
    } catch (err) {
      console.warn(`[perf] tauri app data not removed yet: ${err}`)
    }
  }
  try {
    await waitForCdp(port, 30_000)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    let page: Page | undefined
    for (const deadline = Date.now() + 20_000; !page; ) {
      page = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => !p.url().startsWith('devtools://'))
      if (!page) {
        if (Date.now() > deadline) throw new Error('no app page on the WebView2 debug port')
        await Bun.sleep(100)
      }
    }
    const launchedMs = performance.now() - t0 - launchOverheadMs
    const collector = await createCollector(page)
    if (!opts.noPageMetrics) await collector.inject()
    const backend = await page
      .evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2')
        const ext = gl?.getExtension('WEBGL_debug_renderer_info')
        return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'no webgl2'
      })
      .catch(() => 'unknown')
    return {
      kind: 'tauri',
      rootPid,
      launchedMs,
      launchOverheadMs,
      version: `Termul desktop on WebView2 ${browser.version()}`,
      backend,
      page,
      collector,
      close: async () => {
        collector.stop()
        await browser.close().catch(() => undefined)
        kill()
      }
    }
  } catch (err) {
    kill()
    throw err
  }
}

/**
 * The desktop app renders the same React DOM as the web client. Its boot
 * resets the window to the configured size, so the resize to the other
 * clients' size waits for the launcher, after the startup times are taken.
 */
export function tauriDriver(handle: ChromiumHandle, width: number, height: number): ClientDriver {
  const driver = chromiumDriver(handle)
  return {
    ...driver,
    endPhase: async (name) => {
      const page = await driver.endPhase(name)
      if (name === 'boot') await resize(handle.page, width, height)
      return page
    }
  }
}
