/**
 * `bun tools/chat/table-probe.ts [--port N] [--state DIR]`
 *
 * Prints the geometry of the matrix transcript's markdown table as the web
 * client lays it out: the wrapper chain up to `.chat-streamdown`, the table,
 * every cell's box, padding and text extent, and the table toolbar's buttons.
 * The native `<markdown>` table and its theme metrics are tuned against it.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { createWorld, prepareDevice, TOKEN } from '../matrix/world'
import { DIST_WEB } from '../parity/shoot-web'
import { pickPort } from '../shared/seed'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string' },
    state: { type: 'string', default: '/tmp/gpuix-n3/table-probe' }
  }
})

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
  await prepareDevice(world, 'table-probe')
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
    ({ token }) => {
      localStorage.setItem('termul.webAuthToken', token)
      localStorage.setItem('termul.deviceId', 'table-probe')
    },
    { token: TOKEN }
  )
  const page = await context.newPage()
  await page.goto(`${world.server.baseUrl}/`)
  await page.getByText('How does the web client', { exact: false }).first().click()
  await page.locator('.chat-streamdown table').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  const report = await page.evaluate(() => {
    const table = document.querySelector('.chat-streamdown table') as HTMLElement
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect()
      return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 100) / 100)
    }
    const box = (el: Element) => {
      const cs = getComputedStyle(el)
      return {
        tag: el.tagName.toLowerCase(),
        class: (el.getAttribute('class') ?? '').slice(0, 160),
        rect: rect(el),
        padding: cs.padding,
        border: `${cs.borderTopWidth} ${cs.borderRightWidth} ${cs.borderBottomWidth} ${cs.borderLeftWidth} ${cs.borderStyle}`,
        font: `${cs.fontSize}/${cs.lineHeight} ${cs.fontWeight}`
      }
    }
    const chain: ReturnType<typeof box>[] = []
    for (
      let el: Element | null = table;
      el && !el.classList.contains('chat-streamdown');
      el = el.parentElement
    )
      chain.push(box(el))
    const cells = Array.from(table.querySelectorAll('th, td')).map((cell) => {
      const range = document.createRange()
      range.selectNodeContents(cell)
      return { ...box(cell), text: (cell.textContent ?? '').slice(0, 24), textRect: rect(range) }
    })
    const wrapper =
      table.closest('[data-streamdown="table-wrapper"]') ?? table.parentElement?.parentElement
    const buttons = Array.from(wrapper?.querySelectorAll('button') ?? []).map((b) => ({
      ...box(b),
      label: b.getAttribute('aria-label') ?? b.getAttribute('title') ?? b.textContent,
      svg: b.querySelector('svg') ? rect(b.querySelector('svg') as Element) : null
    }))
    return {
      tableLayout: getComputedStyle(table).tableLayout,
      borderCollapse: getComputedStyle(table).borderCollapse,
      chain,
      cells,
      buttons
    }
  })
  console.log(JSON.stringify(report, null, 1))
} finally {
  await browser.close()
  await world.server.stop()
}
