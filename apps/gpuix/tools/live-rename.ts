/**
 * `bun tools/live-rename.ts [--port N] [--out DIR]`
 *
 * Proves the GPUIX client shows the server's project list live: it shoots the
 * seeded list, renames one project through the server's HTTP API while the
 * app keeps running, waits for the new name to be painted and shoots again.
 * Writes `before.png` and `after.png`.
 */

import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { APP_DIR, buildClient } from '../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../src/window'
import { SCENARIOS, SEEDED_PROJECTS } from './parity/scenarios'
import { renameProject, startTestServer } from './parity/server'
import { READY_TIMEOUT_MS, withGpuix } from './parity/shoot-gpuix'

const RENAMED = 'gamma-renamed-live'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: 'string', default: '8194' }, out: { type: 'string' } }
})
const port = Number(values.port)
const stateDir = path.join(os.tmpdir(), 'gpuix-parity', `rename-${port}`)
const outDir = values.out ?? path.join(APP_DIR, 'parity-out', 'live-rename')
await mkdir(outDir, { recursive: true })

const build = await buildClient()
for (const line of build.logs) console.error(line)
if (!build.ok) process.exit(1)

const scenario = SCENARIOS.projects
const server = await startTestServer({
  port,
  token: 'parity-token',
  stateDir: path.join(stateDir, 'server')
})
try {
  await scenario.seed(server)
  const target = SEEDED_PROJECTS[1]
  await withGpuix(
    {
      server,
      entry: build.entry,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      clientStateDir: path.join(stateDir, 'client')
    },
    async ({ app, grab }) => {
      for (const testId of scenario.readyTestIds) {
        await app.getByTestId(testId).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      }
      await app.getByText(target.name).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      const before = path.join(outDir, 'before.png')
      await grab(before)
      console.log(`before: ${before} (shows "${target.name}")`)

      const started = performance.now()
      await renameProject(server, target.id, RENAMED)
      await app.getByText(RENAMED).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      const after = path.join(outDir, 'after.png')
      await grab(after)
      console.log(
        `after:  ${after} (shows "${RENAMED}", painted ${Math.round(performance.now() - started)} ms after the PUT)`
      )
    }
  )
} finally {
  await server.stop()
  await rm(stateDir, { recursive: true, force: true })
}
