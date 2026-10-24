/**
 * Pixel parity of the pane drag on the web client and GPUIX: two terminal
 * tabs, the right-edge drop zone highlighted while "Terminal 1" is held over
 * it, and the split after the drop. Each client gets its own server with the
 * same seed and a state dir of the same length, so the shell prompts match.
 *
 * bun tools/dnd/parity.ts [--out DIR]   (needs `bun run build:web` at the repo root)
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { TreeNode } from '@gpuix/native/automation'
import type { Page } from 'playwright'
import { buildClient } from '../../build'
import { cropPng, diffPngs, type Rect } from '../parity/diff'
import { startTestServer, type TestServer } from '../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import { withWeb } from '../parity/shoot-web'
import { seedWorkspace } from '../parity/workspace'
import { freePort, openStatusBarTerminal } from '../terminal/shell-tree'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: '/tmp/gpuix-d1/dnd-parity' } }
})
const OUT = values.out!
const SIZE = { width: 1280, height: 800 }
const READY = 'What should we do in alpha?'
const SHOTS = ['two-tabs', 'zone-held', 'split'] as const
const REGIONS: Record<string, Rect> = {
  tabbar: { x: 477, y: 8, width: 795, height: 42 },
  panes: { x: 477, y: 50, width: 795, height: 712 }
}

interface Point {
  x: number
  y: number
}

async function server(name: string): Promise<TestServer> {
  const stateDir = path.join(OUT, `state-${name}`)
  rmSync(stateDir, { recursive: true, force: true })
  const s = await startTestServer({ port: freePort(), token: `d1-parity-${name}`, stateDir })
  await seedWorkspace(s)
  return s
}

/** The drag both clients perform: from the tab's centre to the pane's right edge, in 14 steps. */
function path14(from: Point, to: Point): Point[] {
  return Array.from({ length: 14 }, (_, i) => ({
    x: from.x + ((to.x - from.x) * (i + 1)) / 14,
    y: from.y + ((to.y - from.y) * (i + 1)) / 14
  }))
}

async function web(s: TestServer): Promise<void> {
  await withWeb({ server: s, ...SIZE }, async ({ page, grab }) => {
    await page.getByText(READY).first().waitFor({ timeout: READY_TIMEOUT_MS })
    const terminalButton = page.locator('[data-status-bar]').getByRole('button', { name: 'Terminal' })
    for (const n of [1, 2]) {
      await terminalButton.click()
      await page.getByRole('tab', { name: new RegExp(`Terminal ${n}`) }).waitFor({ timeout: READY_TIMEOUT_MS })
    }
    await page.waitForTimeout(1500)
    await grab(path.join(OUT, 'web-two-tabs.png'))
    const tab = (await page.getByRole('tab', { name: /Terminal 1/ }).getByText('Terminal 1', { exact: true }).boundingBox())!
    const pane = (await page.locator('.xterm').first().boundingBox())!
    await drag(page, { x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 }, { x: pane.x + pane.width - 40, y: pane.y + pane.height / 2 }, () =>
      grab(path.join(OUT, 'web-zone-held.png'))
    )
    await page.waitForTimeout(1500)
    await grab(path.join(OUT, 'web-split.png'))
  })
}

async function drag(page: Page, from: Point, to: Point, whileHeld: () => Promise<void>): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (const p of path14(from, to)) {
    await page.mouse.move(p.x, p.y)
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(300)
  await whileHeld()
  await page.mouse.up()
}

async function gpuix(s: TestServer, entry: string): Promise<void> {
  await withGpuix({ server: s, entry, clientStateDir: path.join(OUT, 'client'), ...SIZE }, async ({ app, grab }) => {
    await app.getByText(READY).waitFor({ timeoutMs: READY_TIMEOUT_MS })
    await openStatusBarTerminal(app, SIZE.height)
    await openStatusBarTerminal(app, SIZE.height)
    await Bun.sleep(1500)
    await grab(path.join(OUT, 'gpuix-two-tabs.png'))
    const label = (await app.getByText('Terminal 1').all()).find((n) => (n.bounds?.y ?? 99) < 50)!.bounds!
    const { tree } = await app.call('getTree', {})
    let pane = { x: 0, y: 0, width: 0, height: 0 }
    const visit = (n: TreeNode) => {
      if (n.testId?.startsWith('terminal-') && n.testId !== 'terminal-assist-close' && (n.bounds?.width ?? 0) > 0) pane = n.bounds!
      for (const c of n.children ?? []) visit(c)
    }
    if (tree) visit(tree)
    const from = { x: label.x + label.width / 2, y: label.y + label.height / 2 }
    const to = { x: pane.x + pane.width - 40, y: pane.y + pane.height / 2 }
    await app.mouse.move(from)
    await app.mouse.down(from)
    for (const p of path14(from, to)) {
      await app.mouse.move(p, { pressedButton: 0 })
      await Bun.sleep(40)
    }
    await Bun.sleep(300)
    await grab(path.join(OUT, 'gpuix-zone-held.png'))
    await app.mouse.up(to)
    await Bun.sleep(1500)
    await grab(path.join(OUT, 'gpuix-split.png'))
  })
}

mkdirSync(OUT, { recursive: true })
const build = await buildClient()
if (!build.ok) throw new Error(build.logs.join('\n'))
const results: Record<string, unknown> = {}
const webServer = await server('w')
try {
  await web(webServer)
} finally {
  await webServer.stop()
}
const gpuixServer = await server('g')
try {
  await gpuix(gpuixServer, build.entry)
} finally {
  await gpuixServer.stop()
}
for (const shot of SHOTS) {
  const webPng = path.join(OUT, `web-${shot}.png`)
  const gpuixPng = path.join(OUT, `gpuix-${shot}.png`)
  const full = diffPngs(webPng, gpuixPng, path.join(OUT, `diff-${shot}.png`))
  const regions: Record<string, unknown> = {}
  for (const [name, rect] of Object.entries(REGIONS)) {
    const w = path.join(OUT, `web-${shot}-${name}.png`)
    const g = path.join(OUT, `gpuix-${shot}-${name}.png`)
    cropPng(webPng, rect, w)
    cropPng(gpuixPng, rect, g)
    const d = diffPngs(w, g, path.join(OUT, `diff-${shot}-${name}.png`))
    regions[name] = { exact: d.exact, perceptual: d.perceptual, total: d.total }
  }
  results[shot] = { full: { exact: full.exact, perceptual: full.perceptual, total: full.total }, regions }
  console.log(shot, JSON.stringify(results[shot]))
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
