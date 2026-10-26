/**
 * `bun tools/chat/wrap-probe.ts [--port N] [--state DIR]`
 *
 * Does `text-wrap: pretty` change any line break in the matrix transcript? Opens
 * the seeded chat in the web client and prints, for every `.chat-streamdown`
 * paragraph, its line boxes as laid out (pretty) and again with
 * `text-wrap: wrap` (greedy, what native markdown does). Exits non-zero when
 * any paragraph breaks differently, which is when GPUIX would need Blink's
 * score line breaker to match.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { createWorld, prepareDevice, TOKEN } from '../matrix/world'
import { DIST_WEB } from '../parity/shoot-web'
import { WEB_REFERENCE_ARGS } from '../shared/chromium'
import { pickPort } from '../shared/seed'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string' },
    state: { type: 'string', default: '/tmp/gpuix-g8/wrap-probe' }
  }
})

interface Paragraph {
  text: string
  wrap: string
  pretty: string[]
  greedy: string[]
}

const root = values.state as string
await rm(root, { recursive: true, force: true })
const world = await createWorld({
  port: await pickPort(values.port ? Number(values.port) : undefined),
  root
})
const browser = await chromium.launch({
  args: WEB_REFERENCE_ARGS
})
let paragraphs: Paragraph[] = []
try {
  await prepareDevice(world, 'wrap-probe')
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
      localStorage.setItem('termul.deviceId', 'wrap-probe')
    },
    { token: TOKEN }
  )
  const page = await context.newPage()
  await page.goto(`${world.server.baseUrl}/`)
  await page.getByText('How does the web client', { exact: false }).first().click()
  await page.getByText('One more place parses it', { exact: false }).first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  paragraphs = await page.evaluate(() => {
    /** Line boxes as `left-right` x ranges, rects on one line merged by their vertical centre. */
    const lines = (p: Element): string[] => {
      const range = document.createRange()
      range.selectNodeContents(p)
      const boxes: { mid: number; left: number; right: number }[] = []
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0) continue
        const mid = (r.top + r.bottom) / 2
        const line = boxes.find((b) => Math.abs(b.mid - mid) < 6)
        if (line) {
          line.left = Math.min(line.left, r.left)
          line.right = Math.max(line.right, r.right)
        } else boxes.push({ mid, left: r.left, right: r.right })
      }
      return boxes.map((b) => `${Math.round(b.left)}-${Math.round(b.right)}`)
    }
    return Array.from(document.querySelectorAll('.chat-streamdown p')).map((p) => {
      const el = p as HTMLElement
      const wrap = getComputedStyle(el).textWrap
      const pretty = lines(el)
      el.style.textWrap = 'wrap'
      const greedy = lines(el)
      el.style.textWrap = ''
      return { text: (el.textContent ?? '').slice(0, 48), wrap, pretty, greedy }
    })
  })
} finally {
  await browser.close()
  await world.server.stop()
}
let differing = 0
for (const p of paragraphs) {
  const same = p.pretty.join() === p.greedy.join()
  if (!same) differing++
  console.log(
    `${same ? 'same' : 'DIFF'} [${p.wrap}] ${JSON.stringify(p.text)}\n     pretty ${p.pretty.join(' ')}\n     greedy ${p.greedy.join(' ')}`
  )
}
console.log(
  `${differing}/${paragraphs.length} paragraphs break differently under text-wrap: pretty`
)
process.exit(differing > 0 ? 1 : 0)
