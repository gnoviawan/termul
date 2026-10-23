/**
 * `bun tools/parity/startup.ts [--runs 5] [--port 8195] [--out DIR]`
 *
 * Launch-to-first-painted-dashboard of the GPUIX client the way a user
 * starts it: the launcher spawns its own termul-server on a seeded data dir,
 * and the clock runs from spawning `bun dist/main.js` until the dashboard
 * heading is in the painted tree. Every run gets a fresh client state dir
 * (no web storage, a new device id), like B0's fresh HOME for WebKitGTK.
 * One frame per run is written next to the results, as proof of what was on
 * screen when the clock stopped.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launch } from '@gpuix/react/automation'
import { APP_DIR, buildClient, ENTRY } from '../../build'
import { defaultServerBinary, startTestServer } from './server'
import { grabFrame, LAVAPIPE_ICD, SCREEN_MARGIN, startXvfb, windowOrigin } from './shoot-gpuix'
import { seedWorkspace } from './workspace'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runs: { type: 'string', default: '5' },
    port: { type: 'string', default: '8195' },
    out: { type: 'string', default: path.join(APP_DIR, 'parity-out', 'startup') },
    root: { type: 'string', default: path.join(os.tmpdir(), 'gpuix-startup') }
  }
})

const WIDTH = 1280
const HEIGHT = 800
const HEADING = 'What should we do in alpha?'
const POLL_MS = 25
const TIMEOUT_MS = 60_000

type App = Awaited<ReturnType<typeof launch>>

async function firstSeen(app: App, started: number, probe: () => Promise<boolean>): Promise<number> {
  for (;;) {
    if (await probe()) return Math.round(performance.now() - started)
    if (performance.now() - started > TIMEOUT_MS) throw new Error('not painted within 60 s')
    await Bun.sleep(POLL_MS)
  }
}

/** The launcher's server flags for a data dir (docs/launcher.md), so the seed lands where it reads. */
async function seedDataDir(dataDir: string, port: number): Promise<void> {
  const server = await startTestServer({ port, token: 'startup-seed', stateDir: dataDir })
  try {
    await seedWorkspace(server)
  } finally {
    await server.stop()
  }
}

// A user runs the production bundle (React's production build, NODE_ENV=production).
const build = await buildClient(ENTRY, path.join(APP_DIR, 'dist-prod'), { production: true })
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
const port = Number(values.port)
const dataDir = path.join(values.root, 'data')
await rm(values.root, { recursive: true, force: true })
await mkdir(values.out, { recursive: true })
await seedDataDir(dataDir, port)

// The launcher must spawn its own server, so no attach variables reach it.
const { TERMUL_SERVER_URL: _url, TERMUL_SERVER_TOKEN: _token, ...launcherEnv } = process.env
const xvfb = await startXvfb(WIDTH + SCREEN_MARGIN, HEIGHT + SCREEN_MARGIN)
const runs: { run: number; windowMs: number; projectListMs: number; dashboardMs: number; frame: string }[] = []
try {
  for (let run = 1; run <= Number(values.runs); run++) {
    const clientState = path.join(values.root, `client-${run}`)
    const started = performance.now()
    const app = await launch({
      command: 'bun',
      args: [build.entry],
      cwd: APP_DIR,
      env: {
        ...launcherEnv,
        DISPLAY: xvfb.display,
        VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
        // The externals (react, react-reconciler) pick their build from the runtime env.
        NODE_ENV: 'production',
        GPUIX_BACKGROUND: '1',
        GPUIX_WINDOW_SIZE: `${WIDTH}x${HEIGHT}`,
        TERMUL_SERVER_BIN: defaultServerBinary(),
        TERMUL_GPUIX_DATA_DIR: dataDir,
        TERMUL_GPUIX_SERVER_PORT: String(port),
        TERMUL_GPUIX_STATE_DIR: clientState
      }
    })
    try {
      const windowMs = Math.round(performance.now() - started)
      const projectListMs = await firstSeen(app, started, async () => (await app.getByTestId('project-item-parity-alpha').count()) > 0)
      const dashboardMs = await firstSeen(app, started, async () => (await app.getByText(HEADING).count()) > 0)
      const frame = path.join(values.out, `run-${run}.png`)
      await grabFrame(xvfb.display, WIDTH, HEIGHT, frame, await windowOrigin(xvfb.display, WIDTH, HEIGHT))
      runs.push({ run, windowMs, projectListMs, dashboardMs, frame })
      console.log(`run ${run}: automation up ${windowMs} ms, project list ${projectListMs} ms, dashboard ${dashboardMs} ms`)
    } finally {
      await app.close()
    }
    // The spawned server stops with the app; give the port and data lock back before the next run.
    await Bun.sleep(1000)
  }
} finally {
  xvfb.stop()
}

const sorted = (key: 'windowMs' | 'projectListMs' | 'dashboardMs') => runs.map((r) => r[key]).sort((a, b) => a - b)
const median = (xs: number[]) => (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2)
const summary = Object.fromEntries(
  (['windowMs', 'projectListMs', 'dashboardMs'] as const).map((key) => {
    const xs = sorted(key)
    return [key, { median: median(xs), min: xs[0], max: xs[xs.length - 1] }]
  })
)
await writeFile(path.join(values.out, 'results.json'), JSON.stringify({ runs, summary, load: os.loadavg() }, null, 2))
for (const [key, s] of Object.entries(summary)) console.log(`${key}: median ${s.median} ms (${s.min} to ${s.max})`)
await rm(values.root, { recursive: true, force: true })
