/**
 * `bun run parity <scenario> [--port N] [--out DIR] [--state-dir DIR]`
 *
 * Starts a seeded test server, shoots the web client (Playwright chromium) and
 * the GPUIX client (Xvfb + lavapipe) at the same size and state, diffs the two
 * frames and prints the mismatch. Writes `web.png`, `gpuix.png` and `diff.png`
 * under the output dir.
 */

import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { APP_DIR, buildClient } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { diffPngs, PERCEPTUAL_THRESHOLD } from './diff'
import { SCENARIOS } from './scenarios'
import { startTestServer } from './server'
import { shootGpuix } from './shoot-gpuix'
import { shootWeb } from './shoot-web'

const TOKEN = 'parity-token'

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '8193' },
    out: { type: 'string' },
    'state-dir': { type: 'string' },
    'keep-state': { type: 'boolean', default: false }
  }
})

const scenario = SCENARIOS[positionals[0] ?? '']
if (!scenario) {
  console.error(
    `usage: bun run parity <${Object.keys(SCENARIOS).join('|')}> [--port N] [--out DIR]`
  )
  process.exit(2)
}

const port = Number(values.port)
const stateDir = values['state-dir'] ?? path.join(os.tmpdir(), 'gpuix-parity', String(port))
const outDir = values.out ?? path.join(APP_DIR, 'parity-out', scenario.name)
await mkdir(outDir, { recursive: true })

const build = await buildClient()
for (const line of build.logs) console.error(line)
if (!build.ok) process.exit(1)

const server = await startTestServer({
  port,
  token: TOKEN,
  stateDir: path.join(stateDir, 'server')
})
try {
  await scenario.seed(server)
  const webPng = path.join(outDir, 'web.png')
  const gpuixPng = path.join(outDir, 'gpuix.png')
  const diffPng = path.join(outDir, 'diff.png')
  const size = { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }

  const started = performance.now()
  await shootWeb({ server, readyTestIds: scenario.readyTestIds, outPath: webPng, ...size })
  const webMs = Math.round(performance.now() - started)
  await shootGpuix({
    server,
    entry: build.entry,
    readyTestIds: scenario.readyTestIds,
    outPath: gpuixPng,
    clientStateDir: path.join(stateDir, 'client'),
    ...size
  })
  const gpuixMs = Math.round(performance.now() - started) - webMs

  const result = diffPngs(webPng, gpuixPng, diffPng)
  console.log(
    `scenario: ${scenario.name} (${size.width}x${size.height}, web shot ${webMs} ms, gpuix shot ${gpuixMs} ms)`
  )
  console.log(`web:   ${webPng}`)
  console.log(`gpuix: ${gpuixPng}`)
  console.log(`diff:  ${diffPng}`)
  console.log(
    `mismatch (exact):      ${result.exact.mismatched} / ${result.total} px = ${result.exact.percent.toFixed(2)}%`
  )
  console.log(
    `mismatch (perceptual): ${result.perceptual.mismatched} / ${result.total} px = ${result.perceptual.percent.toFixed(2)}% (pixelmatch threshold ${PERCEPTUAL_THRESHOLD})`
  )
} finally {
  await server.stop()
  if (!values['keep-state']) await rm(stateDir, { recursive: true, force: true })
}
