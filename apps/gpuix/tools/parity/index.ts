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
import { SCENARIOS, type Scenario } from './scenarios'
import { startTestServer } from './server'
import { shootGpuix } from './shoot-gpuix'
import { shootWeb } from './shoot-web'
import { runWorkspace, type StepResult } from './workspace'

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

const scenario: Scenario | undefined = (SCENARIOS as Record<string, Scenario>)[positionals[0] ?? '']
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
  const size = { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
  if (scenario.kind === 'steps') {
    const results = await runWorkspace({
      server,
      entry: build.entry,
      outDir,
      clientStateDir: path.join(stateDir, 'client'),
      ...size
    })
    printSteps(results)
  } else {
    const webPng = path.join(outDir, 'web.png')
    const gpuixPng = path.join(outDir, 'gpuix.png')
    const diffPng = path.join(outDir, 'diff.png')

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
  }
} finally {
  await server.stop()
  if (!values['keep-state']) await rm(stateDir, { recursive: true, force: true })
}

function pct(result: { mismatched: number; percent: number }): string {
  return `${result.mismatched} px (${result.percent.toFixed(2)}%)`
}

function printSteps(results: StepResult[]): void {
  for (const result of results) {
    console.log(`step ${result.step}`)
    console.log(`  web:   ${result.web}`)
    console.log(`  gpuix: ${result.gpuix}`)
    console.log(
      `  full       exact ${pct(result.full.exact)}  perceptual ${pct(result.full.perceptual)}`
    )
    for (const region of result.regions) {
      const { x, y, width, height } = region.rect
      console.log(
        `  ${region.name.padEnd(10)} exact ${pct(region.diff.exact)}  perceptual ${pct(region.diff.perceptual)}  [${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)}]`
      )
    }
  }
}
