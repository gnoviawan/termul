/**
 * The canvas without a webview host (here: the helper binary is missing) in the real shell: the
 * Canvas button still opens the tab, and its slot says why there is no editor.
 *
 *   bun tools/canvas/unsupported-check.ts [--out DIR]
 */

import { writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient } from '../../build'
import { startSession } from '../browser/session'
import { startTestServer } from '../parity/server'
import { READY_TIMEOUT_MS } from '../parity/shoot-gpuix'
import { seedWorkspace } from '../parity/workspace'
import { freePort } from '../terminal/shell-tree'

const NOTICE = 'The canvas needs the webview helper, which runs on Linux under X11.'
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: '/tmp/gpuix-v1/canvas-unsupported' } }
})
const OUT = values.out!
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const build = await buildClient()
if (!build.ok) throw new Error(build.logs.join('\n'))
const server = await startTestServer({
  port: freePort(),
  token: 'v1-unsupported',
  stateDir: path.join(OUT, 'server')
})
await seedWorkspace(server)
const s = await startSession({
  server,
  entry: build.entry,
  width: 1280,
  height: 800,
  clientStateDir: path.join(OUT, 'client'),
  logFile: path.join(OUT, 'app.log'),
  env: { TERMUL_WEBVIEW_HOST_BIN: '/nonexistent/termul-webview-host' }
})
let result: Record<string, unknown> = {}
try {
  await s.app.getByText('What should we do in alpha?').waitFor({ timeoutMs: READY_TIMEOUT_MS })
  await s.app.getByText('Canvas').click()
  const notice = await s.app
    .getByText(NOTICE)
    .waitFor({ timeoutMs: 20_000 })
    .then((node) => node.bounds ?? true)
    .catch(() => null)
  await s.grab(path.join(OUT, 'canvas-unsupported.png'))
  result = { ok: notice !== null, notice }
} catch (error) {
  result = { ok: false, error: String(error) }
} finally {
  await s.stop()
  await server.stop()
}
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))
console.log(`${result.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(result)}`)
process.exit(result.ok ? 0 : 1)
