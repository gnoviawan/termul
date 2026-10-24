/**
 * The unsupported state in the real shell: with no usable webview host the GPUIX client offers no
 * browser tab, the same gating the browser client gets, and says why in its log.
 *
 *   bun tools/browser/unsupported-check.ts [--out DIR] [--case missing-helper|wayland]
 *
 * `wayland` sets WAYLAND_DISPLAY to a socket that does not exist: the client must log that browser
 * panes are off before any window opens. GPUI tries Wayland first and does not fall back to X11,
 * so the run also records how GPUI itself ends.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { APP_DIR, buildClient } from '../../build'
import { startTestServer } from '../parity/server'
import { READY_TIMEOUT_MS, startXvfb } from '../parity/shoot-gpuix'
import { seedWorkspace } from '../parity/workspace'
import { freePort, openStatusBarTerminal } from '../terminal/shell-tree'
import { startSession } from './session'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-b2/unsupported-check' },
    case: { type: 'string', default: 'missing-helper' }
  }
})
const OUT = path.join(values.out!, values.case!)
const env: Record<string, string> =
  values.case === 'wayland'
    ? { WAYLAND_DISPLAY: 'b2-no-such-wayland' }
    : { TERMUL_WEBVIEW_HOST_BIN: '/nonexistent/termul-webview-host' }

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const build = await buildClient()
if (!build.ok) throw new Error(build.logs.join('\n'))
const server = await startTestServer({
  port: freePort(),
  token: 'b2-unsupported',
  stateDir: path.join(OUT, 'server')
})
await seedWorkspace(server)
const logFile = path.join(OUT, 'app.log')
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
if (values.case === 'wayland') {
  // GPUI picks Wayland and has no compositor here, so the window never opens and automation
  // never answers. Run the client bare under Xvfb and read its log.
  const xvfb = await startXvfb(1344, 864)
  const child = Bun.spawn(['bun', build.entry], {
    cwd: APP_DIR,
    stdout: Bun.file(logFile),
    stderr: 'pipe',
    env: {
      ...process.env,
      ...env,
      DISPLAY: xvfb.display,
      GPUIX_BACKGROUND: '1',
      TERMUL_SERVER_URL: server.baseUrl,
      TERMUL_SERVER_TOKEN: server.token,
      TERMUL_GPUIX_STATE_DIR: path.join(OUT, 'client')
    }
  })
  const stderr = new Response(child.stderr).text()
  const exit = await Promise.race([child.exited, Bun.sleep(20_000).then(() => 'still running')])
  child.kill()
  xvfb.stop()
  await server.stop()
  const reason = /browser panes off: (.*)/.exec(log())?.[1] ?? null
  const panic =
    /panicked at (.*)/.exec(await Promise.race([stderr, Bun.sleep(2000).then(() => '')]))?.[1] ??
    null
  const outcome = { case: 'wayland', ok: reason !== null, reason, appExit: exit, gpuiPanic: panic }
  writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(outcome, null, 2))
  console.log(`${outcome.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(outcome)}`)
  process.exit(outcome.ok ? 0 : 1)
}
const s = await startSession({
  server,
  entry: build.entry,
  width: 1280,
  height: 800,
  clientStateDir: path.join(OUT, 'client'),
  logFile,
  env
})
let result: Record<string, unknown> = {}
try {
  await s.app.getByText('What should we do in alpha?').waitFor({ timeoutMs: READY_TIMEOUT_MS })
  const reason = /browser panes off: (.*)/.exec(log())?.[1] ?? null
  await openStatusBarTerminal(s.app as never, 800)
  await s.app.mouse.click({ x: 1248, y: 28 })
  await s.app.getByText('Open canvas').waitFor({ timeoutMs: 10_000 })
  const offered = (await s.app.getByText('New browser tab').count()) > 0
  await s.grab(path.join(OUT, 'new-tab-menu.png'))
  result = {
    case: values.case,
    ok: reason !== null && !offered,
    reason,
    browserTabOffered: offered
  }
} catch (error) {
  result = { case: values.case, ok: false, error: String(error) }
} finally {
  await s.stop()
  await server.stop()
}
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))
console.log(`${result.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(result)}`)
process.exit(result.ok ? 0 : 1)
