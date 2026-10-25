/**
 * Canvas acceptance in the real GPUIX shell under Xvfb: FigCraft in a helper webview, driven by
 * the shell's own canvas code, by agent MCP calls, and by real X input (XTest) where the webview
 * is involved, because GPUIX automation input never reaches X.
 *
 *   CARGO_TARGET_DIR=... bun run build:webview-host   # once; the check uses dist/termul-webview-host
 *   bun tools/canvas/canvas-check.ts [--out DIR]
 *
 * The test server lacks the FigCraft bundle, so it runs behind `bundle-proxy.ts` with the pinned
 * bundle. Writes PNGs and results.json to DIR (default /tmp/gpuix-v1/canvas-check).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient, OUT_DIR } from '../../build'
import { WEBVIEW_HOST_BIN } from '../../src/browser/support'
import {
  alive,
  childWindows,
  closeWindow,
  descendants,
  mapState,
  processTable,
  type Rect,
  xinput
} from '../browser/probes'
import { type App, startSession } from '../browser/session'
import { startTestServer } from '../parity/server'
import { READY_TIMEOUT_MS } from '../parity/shoot-gpuix'
import { seedWorkspace } from '../parity/workspace'
import { freePort, until } from '../terminal/shell-tree'
import { ensureFigcraftBundle } from './bundle'
import { startBundleProxy } from './bundle-proxy'
import { regionColors } from './pixels'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-v1/canvas-check' },
    bundle: { type: 'string', default: '/tmp/gpuix-v1/figcraft-bundle' }
  }
})
const OUT = values.out!
const SIZE = { width: 1280, height: 800 }
const results: { check: string; ok: boolean; detail: unknown }[] = []
const measures: Record<string, unknown> = {}
function check(name: string, ok: boolean, detail: unknown = {}): void {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}

if (!existsSync(path.join(OUT_DIR, WEBVIEW_HOST_BIN))) {
  throw new Error('build the helper first: CARGO_TARGET_DIR=... bun run build:webview-host')
}
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const bundleDir = await ensureFigcraftBundle(values.bundle!)
const build = await buildClient()
if (!build.ok) throw new Error(build.logs.join('\n'))
const server = await startTestServer({
  port: freePort(),
  token: 'v1-canvas-token',
  stateDir: path.join(OUT, 'server')
})
const proxy = startBundleProxy({ upstream: server.baseUrl, bundleDir, port: freePort() })
const logFile = path.join(OUT, 'app.log')
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
const logged = (pattern: RegExp, ms = 20_000) =>
  until(`log ${pattern}`, async () => pattern.exec(log()), ms)

await seedWorkspace(server)
const s = await startSession({
  server: { ...server, baseUrl: proxy.baseUrl },
  entry: build.entry,
  ...SIZE,
  clientStateDir: path.join(OUT, 'client'),
  logFile
})
const app: App = s.app
const shot = (name: string) => s.grab(path.join(OUT, `${name}.png`))
const X = (...args: string[]) => xinput(s.display, ...args)

try {
  await app.getByText('What should we do in alpha?').waitFor({ timeoutMs: READY_TIMEOUT_MS })
  const origin = await s.origin()
  const click = (x: number, y: number) =>
    X('click', String(Math.round(origin.x + x)), String(Math.round(origin.y + y)))

  // 1. The rail's Canvas button opens the canvas tab with FigCraft painted in its slot.
  const openedAt = Date.now()
  await app.getByText('Canvas').click()
  const tabId = (await logged(/created canvas (\S+)/))[1]
  const parentXid = (await logged(/attached to window (0x[0-9a-f]+)/))[1]
  const helperPid = Number((await logged(/started webview host (\d+)/))[1])
  const view = await until('canvas webview over its slot', async () => {
    const child = childWindows(s.display, parentXid).find(
      (w) => w.rect.x >= 0 && w.rect.width > 100
    )
    return child && mapState(s.display, child.id) === 'IsViewable' ? child : null
  })
  await app.getByText('Ready').waitFor({ timeoutMs: 60_000 })
  measures.openToReadyMs = Date.now() - openedAt
  await Bun.sleep(1500)
  await shot('01-canvas-open')
  const colors = regionColors(path.join(OUT, '01-canvas-open.png'), view.rect)
  check('the Canvas button opens FigCraft in a webview over the canvas slot', colors > 50, {
    tabId,
    helperPid,
    view,
    distinctColorsInSlot: colors,
    openToReadyMs: measures.openToReadyMs
  })
} catch (error) {
  check('run', false, String(error))
  await shot('zz-failure').catch(() => {})
} finally {
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, measures }, null, 2))
  await s.stop()
  proxy.stop()
  await server.stop()
}
const failed = results.filter((result) => !result.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed; results in ${OUT}`)
process.exit(failed.length ? 1 : 0)
