import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { type Browser, chromium, type Locator, type Page } from 'playwright'
import {
  createCollector,
  type PerfCollector
} from '../../../../../tools/perf/metrics/cdp-collector.ts'
import {
  LAUNCHER_COMPOSER,
  NEW_CHAT_SELECTOR,
  START_CHAT_SELECTOR,
  waitForLauncher
} from '../../../../../tools/perf/runner/scenario-ui.ts'
import { descendants, readCmdline } from '../proc-sampler.ts'
import { PERF_AGENT_NAME, PERF_DEVICE_ID, PERF_PROJECT_NAME, PERF_TOKEN } from '../server.ts'
import type { ClientDriver, ClientHandle, ClientLaunchOptions } from './client.ts'

export interface ChromiumHandle extends ClientHandle {
  page: Page
  collector: PerfCollector
}

/**
 * Headed Chromium (Playwright's bundled build) on the run's X display. The
 * test server's compiled-in asset dir belongs to the main checkout, so GETs
 * for files that exist in this worktree's dist-web are answered from disk
 * instead. Service workers are blocked because sw.js fetches skip routing.
 */
export async function launchChromium(opts: ClientLaunchOptions): Promise<ChromiumHandle> {
  const t0 = performance.now()
  const lavapipe = opts.gl === 'lavapipe'
  const cpu = opts.gl === 'cpu'
  const browser: Browser = await chromium.launch({
    headless: false,
    env: {
      ...process.env,
      DISPLAY: opts.display,
      ...(lavapipe ? { VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/lvp_icd.json' } : {})
    },
    args: [
      '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks',
      ...(lavapipe
        ? [
            '--use-angle=vulkan',
            '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE',
            '--ignore-gpu-blocklist'
          ]
        : []),
      ...(cpu ? ['--disable-gpu'] : []),
      `--window-size=${opts.width},${opts.height}`,
      '--window-position=0,0'
    ]
  })
  const rootPid = browserPid()
  const context = await browser.newContext({
    viewport: null,
    colorScheme: 'dark',
    serviceWorkers: 'block'
  })
  await context.addInitScript(
    ({ token, deviceId }) => {
      localStorage.setItem('termul.webAuthToken', token)
      localStorage.setItem('termul.deviceId', deviceId)
    },
    { token: PERF_TOKEN, deviceId: PERF_DEVICE_ID }
  )
  await context.route(`${opts.url}/**`, async (route) => {
    const req = route.request()
    if (req.method() !== 'GET') return route.continue()
    const pathname = new URL(req.url()).pathname
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
    const file = path.join(opts.distWeb, rel)
    if (!file.startsWith(opts.distWeb) || !existsSync(file) || !statSync(file).isFile()) {
      return route.continue()
    }
    return route.fulfill({ path: file })
  })
  const page = await context.newPage()
  const collector = await createCollector(page)
  await collector.inject()
  const launchedMs = performance.now() - t0
  await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const backend = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'no webgl2'
  })
  return {
    kind: 'chromium',
    rootPid,
    launchedMs,
    version: `Chromium ${browser.version()}`,
    backend,
    page,
    collector,
    close: async () => {
      collector.stop()
      await browser.close().catch(() => undefined)
    }
  }
}

/** Playwright spawns Chromium as a direct child of this Node process. */
function browserPid(): number {
  for (const pid of descendants(process.pid)) {
    if (pid === process.pid) continue
    const cmd = readCmdline(pid)
    if (/chrom/i.test(cmd) && !cmd.includes('--type=')) return pid
  }
  throw new Error('could not find the launched Chromium root process')
}

/** Generous: the page's main thread is saturated during the storm, and an
 * action that waits is part of what is measured, not a harness failure. */
const ACTION_MS = 30_000
const CHAT_TAB = '[data-chat-tab-state]'
const PROJECT_ROW = `[aria-label^="Project: ${PERF_PROJECT_NAME}"]`
const VISIBLE_TERMINAL = '.xterm:visible'

/**
 * The launcher's editor can remount while agent config loads, which drops
 * the first click's focus. Type, read back, and retry until the text stuck.
 */
async function typeIntoComposer(page: Page, composer: Locator, text: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await composer.click({ timeout: ACTION_MS })
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await composer.pressSequentially(text, { delay: 5, timeout: ACTION_MS })
    if ((await composer.innerText()).trim() === text) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`launcher composer never accepted "${text}"`)
}

export function chromiumDriver(handle: ChromiumHandle): ClientDriver {
  const { page, collector } = handle
  const titles: string[] = []
  return {
    handle,
    waitForProjectList: () => page.locator(PROJECT_ROW).first().waitFor({ timeout: 60_000 }),
    waitForLauncher: () => waitForLauncher(page),
    startChat: async (prompt) => {
      const composer = page.locator(LAUNCHER_COMPOSER).first()
      if (!(await composer.isVisible())) {
        await page.locator(NEW_CHAT_SELECTOR).first().click({ timeout: ACTION_MS })
        await composer.waitFor({ timeout: ACTION_MS })
      }
      await page
        .locator(`button[aria-label$="Currently ${PERF_AGENT_NAME}"]:visible`)
        .first()
        .waitFor({ timeout: ACTION_MS })
      const before = await page.locator(CHAT_TAB).count()
      await typeIntoComposer(page, composer, prompt)
      await page.locator(START_CHAT_SELECTOR).first().click({ timeout: ACTION_MS })
      await page.waitForFunction(
        ([sel, n]) => document.querySelectorAll(sel as string).length > (n as number),
        [CHAT_TAB, before] as const,
        { timeout: ACTION_MS }
      )
      await composer.waitFor({ state: 'hidden', timeout: ACTION_MS })
      titles.push(prompt)
    },
    chatCount: () => page.locator(CHAT_TAB).count(),
    switchToChat: async (index) => {
      const title = titles[index % titles.length]
      await page
        .locator(`button[data-chat-card-index][title=${JSON.stringify(title)}]`)
        .first()
        .click({ timeout: ACTION_MS })
    },
    openTerminal: async () => {
      const before = await page.locator('.xterm').count()
      await page.locator('button[aria-label="New tab"]').first().click({ timeout: ACTION_MS })
      await page.locator('[role=menuitem]').filter({ hasText: /^Bash/ }).first().click()
      await page.waitForFunction((n) => document.querySelectorAll('.xterm').length > n, before, {
        timeout: ACTION_MS
      })
      await page.locator(`${VISIBLE_TERMINAL} .xterm-helper-textarea`).last().focus()
    },
    runInTerminal: async (command) => {
      await page.locator(`${VISIBLE_TERMINAL} .xterm-helper-textarea`).last().focus()
      await page.keyboard.type(command)
      await page.keyboard.press('Enter')
    },
    waitForTerminalText: async () => {
      throw new Error('xterm draws to canvas; use the terminal probe result file instead')
    },
    beginPhase: async (name) => {
      // Discard what accrued between phases so the page window matches the
      // runner's proc and byte windows.
      await collector.drainPhase()
      await collector.markPhaseStart(name)
    },
    endPhase: async (name) => {
      await collector.markPhaseEnd(name)
      return (await collector.drainPhase()).page
    }
  }
}
