/**
 * Shoot the DOM web client with Playwright chromium against the test server.
 *
 * The server binary serves the `dist-web` of the checkout it was built from,
 * so the page's static files are answered from this worktree's `dist-web`
 * instead (route interception). The service worker is blocked because its
 * fetches bypass the routes, and the local-network-access flag lets a
 * route-fulfilled document open sockets to 127.0.0.1.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { REPO_DIR } from '../../build'
import type { TestServer } from './server'

export const READY_TIMEOUT_MS = 30_000
const SETTLE_MS = 500

export const DIST_WEB = path.join(REPO_DIR, 'dist-web')

export interface WebSessionOptions {
  server: TestServer
  width: number
  height: number
}

export interface WebSession {
  page: Page
  /** Wait for fonts and a settle delay, then write the viewport to `outPath`. */
  grab(outPath: string): Promise<void>
}

/** Open the web client against the test server, run `body` on the page, then close the browser. */
export async function withWeb<T>(
  opts: WebSessionOptions,
  body: (session: WebSession) => Promise<T>
): Promise<T> {
  if (!existsSync(path.join(DIST_WEB, 'index.html'))) {
    throw new Error(
      `${DIST_WEB} has no index.html: run \`bun run build:web\` at the repo root first`
    )
  }
  const browser = await chromium.launch({
    args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks']
  })
  try {
    const context = await browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      serviceWorkers: 'block'
    })
    await context.route(`${opts.server.baseUrl}/**`, async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const file = path.join(DIST_WEB, url.pathname === '/' ? 'index.html' : url.pathname)
      if (
        request.method() === 'GET' &&
        file.startsWith(DIST_WEB) &&
        existsSync(file) &&
        !file.endsWith(path.sep)
      ) {
        await route.fulfill({ path: file })
        return
      }
      await route.continue()
    })
    // The token goes in the way `web-auth-token.ts` persists it, before any
    // page script runs: a `#token=` fragment would be read by the hash router
    // as a route. The device id is fixed so the server-side partition is the
    // same on every run.
    await context.addInitScript(
      ({ token, deviceId }) => {
        localStorage.setItem('termul.webAuthToken', token)
        localStorage.setItem('termul.deviceId', deviceId)
      },
      { token: opts.server.token, deviceId: 'parity-web' }
    )
    const page = await context.newPage()
    await page.goto(`${opts.server.baseUrl}/`)
    return await body({
      page,
      grab: async (outPath) => {
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(SETTLE_MS)
        await page.screenshot({ path: outPath, fullPage: false })
      }
    })
  } finally {
    await browser.close()
  }
}

export async function shootWeb(
  opts: WebSessionOptions & { readyTestIds: string[]; outPath: string }
): Promise<void> {
  await withWeb(opts, async ({ page, grab }) => {
    for (const testId of opts.readyTestIds) {
      await page
        .getByTestId(testId)
        .first()
        .waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS })
    }
    await grab(opts.outPath)
  })
}
