/**
 * `bun tools/parity/startup.ts [--runs 5] [--port 8195] [--out DIR] [--bundle FILE]... [--chromium] [--profile]`
 *
 * Launch-to-first-painted-dashboard of the GPUIX client the way a user
 * starts it: the launcher spawns its own termul-server on a seeded data dir,
 * and the clock runs from spawning `bun <bundle>` until the dashboard
 * heading is in the painted tree. Every run gets a fresh client state dir
 * (no web storage, a new device id), like B0's fresh HOME for WebKitGTK.
 * One frame per run is written next to the results, as proof of what was on
 * screen when the clock stopped.
 *
 * With no `--bundle`, the current production build (`dist-prod/main.js`) is
 * built and measured. Several `--bundle` flags measure prebuilt bundles in
 * rounds (A, B, A, B...), so drift on a shared host hits each one equally.
 * `--chromium` adds B0's perf runner (`tools/perf/run.ts`, idle scenario,
 * page metrics off, same window size) to every round; its
 * `startup.projectListMs` lands next to the GPUIX numbers.
 * `--profile` writes a `bun --cpu-prof-md` profile per run into `<out>/profile`;
 * profiled runs are slower, so do not report their times.
 *
 * Every probe is a GPUIX automation tree query, which paints a frame and
 * blocks the app's JS thread until it has; Playwright's probes cost Chromium
 * nothing like it. `--poll-ms` (default 25, A1's setting) trades that load
 * against how late the clock may stop.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
    root: { type: 'string', default: path.join(os.tmpdir(), 'gpuix-startup') },
    bundle: { type: 'string', multiple: true },
    chromium: { type: 'boolean', default: false },
    'chromium-port': { type: 'string', default: '8193' },
    'chromium-display': { type: 'string', default: ':183' },
    profile: { type: 'boolean', default: false },
    'poll-ms': { type: 'string', default: '25' }
  }
})

const WIDTH = 1280
const HEIGHT = 800
const HEADING = 'What should we do in alpha?'
const POLL_MS = Number(values['poll-ms'])
const TIMEOUT_MS = 60_000
const CLOCK_TICK_MS = 10

type App = Awaited<ReturnType<typeof launch>>

interface Sample {
  subject: string
  run: number
  load1: number
  /** Time to `startup.projectListMs` for Chromium; GPUIX adds the rest. */
  projectListMs: number
  windowMs?: number
  dashboardMs?: number
  /** App CPU time when the dashboard heading was first seen. */
  dashboardCpuMs?: number
  frame?: string
}

async function firstSeen(app: App, started: number, probe: () => Promise<boolean>): Promise<number> {
  for (;;) {
    if (await probe()) return Math.round(performance.now() - started)
    if (performance.now() - started > TIMEOUT_MS) throw new Error('not painted within 60 s')
    await Bun.sleep(POLL_MS)
  }
}

/**
 * User+system CPU of the app process (every thread: JS, GPUI, lavapipe) so
 * far. Contention from other processes on a shared host inflates wall time
 * much more than this.
 */
function pidsWithArg(arg: string): string[] {
  const out: string[] = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(arg)) out.push(pid)
    } catch {}
  }
  return out
}

function appCpuMs(entry: string): number {
  const [pid] = pidsWithArg(entry)
  if (!pid) throw new Error(`no process runs ${entry}`)
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
  return (Number(fields[11]) + Number(fields[12])) * CLOCK_TICK_MS
}

/** The spawned server stops with the app; the next run needs its data lock and port. */
async function serverGone(): Promise<void> {
  const deadline = performance.now() + 30_000
  while (pidsWithArg(dataDir).length > 0) {
    if (performance.now() > deadline) throw new Error(`a server on ${dataDir} is still running`)
    await Bun.sleep(100)
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

async function bundles(): Promise<string[]> {
  if (values.bundle?.length) return values.bundle.map((file) => path.resolve(file))
  // A user runs the production bundle (React's production build, NODE_ENV=production).
  const build = await buildClient(ENTRY, path.join(APP_DIR, 'dist-prod'), { production: true })
  if (!build.ok) {
    for (const line of build.logs) console.error(line)
    process.exit(1)
  }
  return [build.entry]
}

const subjectName = (entry: string) => path.relative(APP_DIR, entry)

const entries = await bundles()
const port = Number(values.port)
const dataDir = path.join(values.root, 'data')
await rm(values.root, { recursive: true, force: true })
await mkdir(values.out, { recursive: true })
await seedDataDir(dataDir, port)

// The launcher must spawn its own server, so no attach variables reach it.
const { TERMUL_SERVER_URL: _url, TERMUL_SERVER_TOKEN: _token, ...launcherEnv } = process.env

async function gpuixRun(entry: string, run: number, display: string): Promise<Sample> {
  const subject = subjectName(entry)
  const tag = `${path.basename(path.dirname(entry))}-${run}`
  const load1 = os.loadavg()[0]
  const started = performance.now()
  const app = await launch({
    command: 'bun',
    args: values.profile ? ['--cpu-prof-md', `--cpu-prof-dir=${path.join(values.out, 'profile', tag)}`, entry] : [entry],
    cwd: APP_DIR,
    env: {
      ...launcherEnv,
      DISPLAY: display,
      VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
      // Bundles built before the production entry existed need it from the env.
      NODE_ENV: 'production',
      GPUIX_BACKGROUND: '1',
      GPUIX_WINDOW_SIZE: `${WIDTH}x${HEIGHT}`,
      TERMUL_SERVER_BIN: defaultServerBinary(),
      TERMUL_GPUIX_DATA_DIR: dataDir,
      TERMUL_GPUIX_SERVER_PORT: String(port),
      TERMUL_GPUIX_STATE_DIR: path.join(values.root, `client-${tag}`)
    }
  })
  try {
    const windowMs = Math.round(performance.now() - started)
    const projectListMs = await firstSeen(app, started, async () => (await app.getByTestId('project-item-parity-alpha').count()) > 0)
    const dashboardMs = await firstSeen(app, started, async () => (await app.getByText(HEADING).count()) > 0)
    const dashboardCpuMs = appCpuMs(entry)
    const frame = path.join(values.out, `${tag}.png`)
    await grabFrame(display, WIDTH, HEIGHT, frame, await windowOrigin(display, WIDTH, HEIGHT))
    return { subject, run, load1, windowMs, projectListMs, dashboardMs, dashboardCpuMs, frame }
  } finally {
    await app.close()
    await serverGone()
  }
}

/** One idle run of B0's Chromium runner at the GPUIX window size; its first-project-list time. */
async function chromiumRun(run: number): Promise<Sample> {
  const out = path.join(values.out, `chromium-${run}`)
  const proc = Bun.spawn(
    [
      'bun', path.join(APP_DIR, 'tools/perf/run.ts'),
      '--scenarios', 'idle', '--runs', '1', '--page-metrics', 'off',
      '--port', values['chromium-port'], '--display', values['chromium-display'],
      '--width', String(WIDTH), '--height', String(HEIGHT),
      '--quiet-wait', '20', '--out', out
    ],
    { cwd: APP_DIR, stdout: 'ignore', stderr: 'inherit' }
  )
  if ((await proc.exited) !== 0) throw new Error(`chromium run ${run} failed`)
  const record = JSON.parse(await readFile(path.join(out, 'idle-run1.json'), 'utf8'))
  if (record.meta.status !== 'ok') throw new Error(`chromium run ${run}: ${JSON.stringify(record.errors)}`)
  return { subject: 'chromium', run, load1: record.meta.load1Before, projectListMs: record.metrics['startup.projectListMs'] }
}

const samples: Sample[] = []
const xvfb = await startXvfb(WIDTH + SCREEN_MARGIN, HEIGHT + SCREEN_MARGIN)
try {
  for (let run = 1; run <= Number(values.runs); run++) {
    // Rotate the order each round so no subject always runs first.
    const round = entries.map((_, i) => entries[(i + run - 1) % entries.length])
    for (const entry of round) {
      const sample = await gpuixRun(entry, run, xvfb.display)
      samples.push(sample)
      console.log(
        `run ${run} ${sample.subject}: automation up ${sample.windowMs} ms, project list ${sample.projectListMs} ms, dashboard ${sample.dashboardMs} ms (cpu ${sample.dashboardCpuMs} ms), load1 ${sample.load1}`
      )
    }
    if (values.chromium) {
      const sample = await chromiumRun(run)
      samples.push(sample)
      console.log(`run ${run} chromium: project list ${sample.projectListMs} ms, load1 ${sample.load1}`)
    }
  }
} finally {
  xvfb.stop()
}

const median = (xs: number[]) => (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2)
const METRICS = ['windowMs', 'projectListMs', 'dashboardMs', 'dashboardCpuMs'] as const
const summary: Record<string, Record<string, { median: number; min: number; max: number }>> = {}
for (const subject of [...entries.map(subjectName), ...(values.chromium ? ['chromium'] : [])]) {
  summary[subject] = {}
  for (const metric of METRICS) {
    const xs = samples
      .filter((s) => s.subject === subject && s[metric] !== undefined)
      .map((s) => s[metric] as number)
      .sort((a, b) => a - b)
    if (xs.length) summary[subject][metric] = { median: median(xs), min: xs[0], max: xs[xs.length - 1] }
  }
}
const bundleBytes = Object.fromEntries(
  await Promise.all(
    entries.map(async (entry) => {
      const dir = path.dirname(entry)
      const files = (await Array.fromAsync(new Bun.Glob('*.js').scan({ cwd: dir }))) as string[]
      const sizes = await Promise.all(files.map(async (file) => (await stat(path.join(dir, file))).size))
      return [subjectName(entry), sizes.reduce((a, b) => a + b, 0)]
    })
  )
)
await writeFile(path.join(values.out, 'results.json'), JSON.stringify({ samples, summary, bundleBytes, load: os.loadavg() }, null, 2))
for (const [subject, metrics] of Object.entries(summary)) {
  for (const [metric, s] of Object.entries(metrics)) console.log(`${subject} ${metric}: median ${s.median} ms (${s.min} to ${s.max})`)
}
for (const [subject, bytes] of Object.entries(bundleBytes)) console.log(`${subject}: ${bytes} bytes of JS`)
await rm(values.root, { recursive: true, force: true })
