/**
 * The matrix transcript in the DOM web client, for geometry probes: a fresh
 * matrix world (`createWorld`) under `root`, this worktree's `dist-web`
 * through route interception, Chromium with the matrix's reference flags at
 * the GPUIX window size, and the scripted chat open with its fonts loaded.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { createWorld, prepareDevice, TOKEN } from '../matrix/world'
import { DIST_WEB } from '../parity/shoot-web'
import { WEB_REFERENCE_ARGS } from '../shared/chromium'
import { pickPort } from '../shared/seed'

export async function withProbeChat(
  opts: { root: string; port?: number; deviceId: string },
  probe: (page: Page) => Promise<void>
): Promise<void> {
  await rm(opts.root, { recursive: true, force: true })
  const world = await createWorld({ port: await pickPort(opts.port), root: opts.root })
  const browser = await chromium.launch({ args: WEB_REFERENCE_ARGS })
  try {
    await prepareDevice(world, opts.deviceId)
    const context = await browser.newContext({
      viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      serviceWorkers: 'block'
    })
    await context.route(`${world.server.baseUrl}/**`, async (route) => {
      const url = new URL(route.request().url())
      const file = path.join(DIST_WEB, url.pathname === '/' ? 'index.html' : url.pathname)
      if (route.request().method() === 'GET' && file.startsWith(DIST_WEB) && existsSync(file))
        return route.fulfill({ path: file })
      return route.continue()
    })
    await context.addInitScript(
      ({ token, deviceId }) => {
        localStorage.setItem('termul.webAuthToken', token)
        localStorage.setItem('termul.deviceId', deviceId)
      },
      { token: TOKEN, deviceId: opts.deviceId }
    )
    const page = await context.newPage()
    await page.goto(`${world.server.baseUrl}/`)
    await page.getByText('How does the web client', { exact: false }).first().click()
    await page.locator('.chat-streamdown table').first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    await probe(page)
  } finally {
    await browser.close()
    await world.server.stop()
    await rm(opts.root, { recursive: true, force: true })
  }
}
