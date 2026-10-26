/**
 * The DOM web client on a seeded chat, in Playwright chromium: this
 * worktree's `dist-web` answers the static files (route interception), the
 * token and the seeded device id go into `localStorage` before any script
 * runs, and the page opens the chat route of the seeded session.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { DIST_WEB } from '../parity/shoot-web'
import { WEB_REFERENCE_ARGS } from '../shared/chromium'
import type { SeededChat } from './seed'

export interface WebChat {
  browser: Browser
  page: Page
  close(): Promise<void>
}

export const TRANSCRIPT_SELECTOR = '[data-slot="message-scroller-viewport"]'

export async function openWebChat(
  chat: SeededChat,
  opts: {
    width: number
    height: number
    launchArgs?: string[]
    headless?: boolean
    env?: Record<string, string>
  }
): Promise<WebChat> {
  if (!existsSync(path.join(DIST_WEB, 'index.html'))) {
    throw new Error(
      `${DIST_WEB} has no index.html: run \`bun run build:web\` at the repo root first`
    )
  }
  const browser = await chromium.launch({
    headless: opts.headless ?? true,
    env: opts.env,
    args: [...WEB_REFERENCE_ARGS, ...(opts.launchArgs ?? [])]
  })
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block'
  })
  await context.route(`${chat.baseUrl}/**`, async (route) => {
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
  await context.addInitScript(
    ({ token, deviceId }) => {
      localStorage.setItem('termul.webAuthToken', token)
      localStorage.setItem('termul.deviceId', deviceId)
    },
    { token: chat.token, deviceId: chat.deviceId }
  )
  const page = await context.newPage()
  await page.goto(chat.webUrl)
  await page.locator(TRANSCRIPT_SELECTOR).first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.evaluate(() => document.fonts.ready)
  return { browser, page, close: () => browser.close() }
}
