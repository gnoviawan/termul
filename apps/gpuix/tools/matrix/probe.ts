/**
 * `bun tools/matrix/probe.ts <surface-id...> [--port N]`
 *
 * Authoring aid: runs the named surfaces' steps in the web client only and, after
 * each step, prints what the page offers to act on (accessible buttons, tabs,
 * menu items, test ids, dialog titles) and which checks passed. Use it to
 * write a surface's targets from the real DOM instead of guessing.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { DIST_WEB } from '../parity/shoot-web'
import { pickPort } from '../shared/seed'
import { webDriver } from './drive'
import { SURFACES } from './surfaces'
import { createWorld, prepareDevice, TOKEN } from './world'

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { port: { type: 'string' }, state: { type: 'string', default: '/tmp/gpuix-m1/probe' } }
})
const surfaces = positionals.map((wanted) => SURFACES.find((s) => s.id === wanted))
if (surfaces.length === 0 || surfaces.some((s) => !s)) {
  console.error(`usage: probe.ts <id...> of ${SURFACES.map((s) => s.id).join('|')}`)
  process.exit(2)
}

const root = values.state as string
await rm(root, { recursive: true, force: true })
const world = await createWorld({
  port: await pickPort(values.port ? Number(values.port) : undefined),
  root
})
const browser = await chromium.launch({
  args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks']
})
try {
  for (const [n, surface] of (surfaces as NonNullable<(typeof surfaces)[number]>[]).entries()) {
    console.log(`===== ${surface.id}`)
    const deviceId = `m1-probe-${n}`
    await prepareDevice(world, deviceId)
    await surface.prepare?.(world)
    const context = await browser.newContext({
      viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      serviceWorkers: 'block'
    })
    await context.route(`${world.server.baseUrl}/**`, async (route) => {
      const url = new URL(route.request().url())
      const file = path.join(DIST_WEB, url.pathname === '/' ? 'index.html' : url.pathname)
      if (route.request().method() === 'GET' && existsSync(file) && !file.endsWith(path.sep))
        return route.fulfill({ path: file })
      return route.continue()
    })
    await context.addInitScript(
      ({ token, deviceId }) => {
        localStorage.setItem('termul.webAuthToken', token)
        localStorage.setItem('termul.deviceId', deviceId)
      },
      { token: TOKEN, deviceId }
    )
    const page = await context.newPage()
    await page.goto(`${world.server.baseUrl}/`)
    await page.getByText('What should we do in alpha?').first().waitFor({ timeout: 30_000 })
    const driver = webDriver(page, new Map())
    for (const step of surface.steps) {
      let failed = false
      for (const [i, action] of step.actions.entries()) {
        const log = await driver.act(step.name, i, action)
        failed ||= !log.ok
        console.log(`${log.ok ? 'ok  ' : 'FAIL'} ${log.action}${log.error ? `  ${log.error}` : ''}`)
      }
      for (const check of step.expect) {
        const log = await driver.check(step.name, check)
        failed ||= !log.pass
        console.log(`${log.pass ? 'pass' : 'MISS'} ${log.expect} "${log.text}"`)
      }
      const inventory = await page.evaluate(() => {
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
        }
        const name = (el: Element) =>
          (
            el.getAttribute('aria-label') ||
            (el as HTMLElement).innerText ||
            el.getAttribute('title') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 50)
        const pick = (selector: string) =>
          [...document.querySelectorAll(selector)].filter(visible).map((el) => {
            const r = el.getBoundingClientRect()
            return `${name(el)}@${Math.round(r.x)},${Math.round(r.y)}`
          })
        return {
          buttons: pick('button,[role=button]'),
          tabs: pick('[role=tab]'),
          menu: pick('[role=menuitem],[role=option],[role=menuitemcheckbox]'),
          dialogs: pick('[role=dialog],[role=alertdialog],[role=menu],[role=listbox]').map((s) =>
            s.slice(0, 80)
          ),
          testIds: [...document.querySelectorAll('[data-testid]')]
            .filter(visible)
            .map((el) => el.getAttribute('data-testid')),
          inputs: pick('input,textarea,[contenteditable=true]').concat(
            [...document.querySelectorAll('input,textarea')]
              .filter(visible)
              .map((el) => `placeholder=${el.getAttribute('placeholder')}`)
          )
        }
      })
      console.log(`--- after ${step.name}`)
      if (failed || process.env.PROBE_ALL) {
        for (const [key, list] of Object.entries(inventory)) console.log(`${key}: ${[...new Set(list)].join(' | ')}`)
      }
      await page.screenshot({ path: path.join(root, `${surface.id}-${step.name}.png`) })
      console.log(`shot: ${path.join(root, `${surface.id}-${step.name}.png`)}`)
    }
    await context.close()
  }
} finally {
  await browser.close()
  world.ws.close()
  await world.server.stop()
}
