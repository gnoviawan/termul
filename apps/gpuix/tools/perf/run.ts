/**
 * Linux perf runner for the Termul desktop client candidates. See README.md.
 *
 *   bun run perf --scenarios stream-storm,pty-flood --runs 3   (from apps/gpuix)
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { REPO_DIR } from '../../build.ts'
import { DIST_WEB } from '../parity/shoot-web.ts'
import { startByteProxy } from './byte-proxy.ts'
import { chromiumDriver, launchChromium } from './clients/chromium.ts'
import type { ClientDriver } from './clients/client.ts'
import {
  chromiumRole,
  type MachineSample,
  type ProcSample,
  type RoleOf,
  startMachineSampler,
  startProcSampler,
  withPageRenderer
} from './proc-sampler.ts'
import { DEFAULTS, type Flags, type PhaseClock, SCENARIOS, type ScenarioName } from './scenarios.ts'
import { startPerfServer } from './server.ts'
import { aggregate, median, type Numbers, summarizePage, summarizeProc } from './stats.ts'

const HERE = import.meta.dir

interface Options {
  scenarios: ScenarioName[]
  runs: number
  client: 'chromium'
  gl: 'lavapipe' | 'swiftshader' | 'cpu'
  serverBin: string
  port: number
  display: string
  width: number
  height: number
  seed: number
  /** Wait before each run until the machine's busy CPU drops under this (% of one core). */
  quietBelowPct: number
  quietWaitS: number
  noPageMetrics: boolean
  distWeb: string
  outDir: string
  overrides: Flags
}

function parseArgs(argv: string[]): Options {
  const raw: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    raw[argv[i].slice(2)] = argv[i + 1]
    i++
  }
  const take = (key: string, fallback: string) => {
    const v = raw[key] ?? fallback
    delete raw[key]
    return v
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const opts: Options = {
    scenarios: take('scenarios', 'stream-storm,pty-flood').split(',') as ScenarioName[],
    runs: Number(take('runs', '3')),
    client: take('client', 'chromium') as 'chromium',
    gl: take('gl', 'lavapipe') as 'lavapipe' | 'swiftshader' | 'cpu',
    serverBin: take('server-bin', '/root/gpuix-bin/termul-server'),
    port: Number(take('port', '8196')),
    display: take('display', ':181'),
    width: Number(take('width', '1440')),
    height: Number(take('height', '900')),
    seed: Number(take('seed', '42')),
    quietBelowPct: Number(take('quiet-below', '150')),
    quietWaitS: Number(take('quiet-wait', '600')),
    noPageMetrics: take('page-metrics', 'on') === 'off',
    distWeb: path.resolve(take('dist-web', DIST_WEB)),
    outDir: path.resolve(take('out', path.join(HERE, 'results', `linux-${stamp}`))),
    overrides: {}
  }
  for (const s of opts.scenarios) if (!(s in SCENARIOS)) throw new Error(`unknown scenario ${s}`)
  for (const [k, v] of Object.entries(raw)) opts.overrides[k] = Number(v)
  return opts
}

const serverRole: RoleOf = (_pid, cmd) => {
  if (cmd.includes('termul-server')) return 'server'
  if (cmd.includes('fake-agent')) return 'agent'
  if (cmd.includes('terminal-probe')) return 'probe'
  return 'other'
}

async function startXvfb(display: string, width: number, height: number): Promise<ChildProcess> {
  const xvfb = spawn(
    'Xvfb',
    [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'],
    {
      stdio: 'ignore'
    }
  )
  await sleep(700)
  if (xvfb.exitCode !== null) throw new Error(`Xvfb ${display} exited (display in use?)`)
  return xvfb
}

/**
 * Other units share this machine. Before a run, poll 5 s windows of
 * whole-machine CPU until one falls under the threshold or time runs out.
 * The run goes ahead either way; the record says how quiet it was.
 */
async function waitForQuiet(
  belowPct: number,
  waitS: number
): Promise<{ waitedS: number; busyPct: number }> {
  const started = Date.now()
  for (;;) {
    const sampler = startMachineSampler()
    await sleep(5000)
    const busy = sampler.stop().map((m) => m.busy)
    const busyPct = Math.round(busy.reduce((a, b) => a + b, 0) / busy.length)
    const waitedS = Math.round((Date.now() - started) / 1000)
    if (busyPct < belowPct || waitedS >= waitS) return { waitedS, busyPct }
  }
}

const within = <T extends { t: number }>(samples: T[], from: number, to: number) =>
  samples.filter((s) => s.t >= from && s.t <= to)

interface PhaseWindow {
  name: string
  from: number
  to: number
  bytes: { down: number; up: number }
  page: Numbers
}

async function runOnce(opts: Options, scenario: ScenarioName, runIndex: number) {
  const flags: Flags = { ...DEFAULTS[scenario], ...opts.overrides }
  const scratch = path.join('/tmp/gpuix-b0', `${scenario}-${runIndex}`)
  mkdirSync(scratch, { recursive: true })
  const errors: string[] = []
  const notes: Record<string, unknown> = {}
  const windows: PhaseWindow[] = []
  const quiet = await waitForQuiet(opts.quietBelowPct, opts.quietWaitS)
  const load1Before = os.loadavg()[0]

  const xvfb = await startXvfb(opts.display, opts.width, opts.height)
  const server = await startPerfServer({
    binary: opts.serverBin,
    port: opts.port,
    stateRoot: scratch,
    agentEnv: {
      PERF_AGENT_SEED: String(opts.seed),
      PERF_AGENT_RATE: String(flags.rate ?? 20),
      PERF_AGENT_CHUNK_CHARS: '120',
      PERF_AGENT_UNIQUE_SESSIONS: '1'
    }
  })
  const serverSampler = startProcSampler(server.pid, serverRole)
  const machineSampler = startMachineSampler()
  const proxy = await startByteProxy(opts.port, opts.port + 1).catch(async (err) => {
    await server.stop()
    throw err
  })
  let driver: ClientDriver | null = null
  let sampler: ReturnType<typeof startProcSampler> | null = null
  let clientSamples: ProcSample[] = []
  let serverSamples: ProcSample[] = []
  let machineSamples: MachineSample[] = []
  let processes: Array<{ pid: number; role: string; cmd: string }> = []
  const startup: Numbers = {}
  try {
    const t0 = performance.now()
    const wall0 = Date.now()
    const handle = await launchChromium({
      url: proxy.url,
      display: opts.display,
      width: opts.width,
      height: opts.height,
      distWeb: opts.distWeb,
      gl: opts.gl,
      noPageMetrics: opts.noPageMetrics
    })
    sampler = startProcSampler(handle.rootPid, chromiumRole)
    driver = chromiumDriver(handle)
    notes.client = handle.version
    notes.backend = handle.backend
    startup['startup.processUpMs'] = Math.round(handle.launchedMs)
    await driver.waitForProjectList()
    startup['startup.projectListMs'] = Math.round(performance.now() - t0)
    await driver.waitForLauncher()
    startup['startup.launcherReadyMs'] = Math.round(performance.now() - t0)
    const bootPage = await driver.endPhase('boot')
    windows.push({
      name: 'startup',
      from: wall0,
      to: Date.now(),
      bytes: proxy.counters(),
      page: bootPage && !opts.noPageMetrics ? summarizePage(bootPage, Date.now() - wall0) : {}
    })

    const d = driver
    const clock: PhaseClock = {
      phase: async (name, body) => {
        await d.beginPhase(name)
        proxy.reset()
        const from = Date.now()
        await body()
        const to = Date.now()
        const bytes = proxy.counters()
        const page = await d.endPhase(name)
        windows.push({
          name,
          from,
          to,
          bytes,
          page: page && !opts.noPageMetrics ? summarizePage(page, to - from) : {}
        })
      },
      note: (key, value) => {
        notes[key] = value
      },
      error: (message) => {
        errors.push(message)
      }
    }
    await SCENARIOS[scenario]({ driver: d, clock, flags, seed: opts.seed, scratch })
  } catch (err) {
    errors.push(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
  } finally {
    if (sampler) {
      clientSamples = sampler.stop()
      processes = sampler.processes()
      notes.pageRendererPid = withPageRenderer(
        clientSamples,
        new Map(processes.map((p) => [p.pid, p.role]))
      )
    }
    await driver?.handle.close()
    await proxy.close()
    serverSamples = serverSampler.stop()
    machineSamples = machineSampler.stop()
    await server.stop()
    xvfb.kill()
    notes.serverSamples = serverSamples.length
    notes.serverProc = Object.fromEntries(
      windows.map((w) => [w.name, summarizeProc(within(serverSamples, w.from, w.to), 'server.')])
    )
  }

  const metrics: Numbers = { ...startup }
  for (const w of windows) {
    const seconds = (w.to - w.from) / 1000
    Object.assign(
      metrics,
      prefixed(w.name, summarizeProc(within(clientSamples, w.from, w.to), 'proc.'))
    )
    Object.assign(metrics, prefixed(w.name, w.page))
    const serverCpu =
      summarizeProc(within(serverSamples, w.from, w.to), 'server.')['server.total.cpuMeanPct'] ?? 0
    const machine = within(machineSamples, w.from, w.to).map((m) => m.busy)
    const machineCpu = machine.length ? machine.reduce((a, b) => a + b, 0) / machine.length : 0
    const clientCpu = metrics[`${w.name}.proc.total.cpuMeanPct`] ?? 0
    metrics[`${w.name}.server.cpuMeanPct`] = serverCpu
    metrics[`${w.name}.machine.cpuBusyPct`] = Math.round(machineCpu)
    metrics[`${w.name}.machine.foreignCpuPct`] = Math.round(
      Math.max(0, machineCpu - clientCpu - serverCpu)
    )
    metrics[`${w.name}.durationS`] = Math.round(seconds * 10) / 10
    metrics[`${w.name}.bytesDownKBps`] = Math.round(w.bytes.down / 1024 / seconds)
    metrics[`${w.name}.bytesUpKBps`] = Math.round(w.bytes.up / 1024 / seconds)
  }
  Object.assign(metrics, probeMetrics(notes))
  if (typeof notes.chatsOpen === 'number') metrics.chatsOpen = notes.chatsOpen
  const chatStart = notes.chatStartMs as number[] | undefined
  if (chatStart?.length) {
    metrics['chat.firstStartMs'] = chatStart[0]
    const loaded = chatStart.slice(1)
    if (loaded.length) {
      metrics['chat.startUnderLoadP50Ms'] = median(loaded)
      metrics['chat.startUnderLoadMaxMs'] = Math.max(...loaded)
    }
  }
  if (typeof notes.switches === 'number') metrics['chat.switches'] = notes.switches
  return {
    meta: {
      scenario,
      run: runIndex,
      client: opts.client,
      clientVersion: notes.client,
      backend: notes.backend,
      gl: opts.gl,
      pageMetrics: !opts.noPageMetrics,
      seed: opts.seed,
      flags,
      viewport: `${opts.width}x${opts.height}`,
      startedAt: new Date().toISOString(),
      gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR }).toString().trim(),
      quietWaitS: quiet.waitedS,
      preRunBusyPct: quiet.busyPct,
      load1Before,
      load1After: os.loadavg()[0],
      status: errors.some((e) => e.startsWith('fatal')) ? 'failed' : 'ok'
    },
    metrics,
    errors,
    notes,
    processes,
    procSeries: clientSamples.filter((_, i) => i % 2 === 0).map(({ pids: _pids, ...rest }) => rest)
  }
}

function prefixed(phase: string, values: Numbers): Numbers {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [`${phase}.${k}`, v]))
}

interface PacedResult {
  lines: number
  seconds: number
  bytes: number
  rttMs: Array<number | null>
}
interface BurstResult {
  lines: number
  bytes: number
  totalMs: number | null
  writeMs: number
}

function probeMetrics(notes: Record<string, unknown>): Numbers {
  const out: Numbers = {}
  const paced = notes.paced as PacedResult[] | undefined
  if (paced) {
    const rtts = paced.flatMap((p) => p.rttMs)
    const ok = rtts.filter((r): r is number => r !== null).sort((a, b) => a - b)
    out['probe.pacedRttP50Ms'] = Math.round(median(ok) * 10) / 10
    out['probe.pacedRttP95Ms'] = Math.round((ok[Math.round(0.95 * (ok.length - 1))] ?? 0) * 10) / 10
    out['probe.pacedRttMaxMs'] = Math.round((ok[ok.length - 1] ?? 0) * 10) / 10
    out['probe.pacedTimeouts'] = rtts.length - ok.length
    out['probe.pacedProbes'] = rtts.length
    out['probe.pacedLinesPerSecPerTerminal'] = Math.round(
      median(paced.map((p) => p.lines / p.seconds))
    )
  }
  const burst = notes.burst as BurstResult | undefined
  if (burst) {
    out['probe.burstLines'] = burst.lines
    out['probe.burstMB'] = Math.round((burst.bytes / 1024 / 1024) * 100) / 100
    if (burst.totalMs !== null) {
      out['probe.burstTotalMs'] = Math.round(burst.totalMs)
      out['probe.burstMBps'] =
        Math.round((burst.bytes / 1024 / 1024 / (burst.totalMs / 1000)) * 100) / 100
    }
    out['probe.burstWriteMs'] = Math.round(burst.writeMs)
  }
  return out
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  mkdirSync(opts.outDir, { recursive: true })
  const machine = {
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1024 ** 3),
    kernel: os.release(),
    bun: Bun.version
  }
  const byScenario: Record<string, Numbers[]> = {}
  for (let run = 1; run <= opts.runs; run++) {
    for (const scenario of opts.scenarios) {
      console.log(`[perf] ${scenario} run ${run}/${opts.runs}`)
      const record = await runOnce(opts, scenario, run)
      writeFileSync(
        path.join(opts.outDir, `${scenario}-run${run}.json`),
        JSON.stringify({ machine, ...record }, null, 1)
      )
      console.log(
        `[perf]   status=${record.meta.status} errors=${record.errors.length} preRunBusy=${record.meta.preRunBusyPct}% waited=${record.meta.quietWaitS}s`
      )
      for (const e of record.errors) console.log(`[perf]   ! ${e.split('\n')[0]}`)
      if (record.meta.status === 'ok') {
        byScenario[scenario] ??= []
        byScenario[scenario].push(record.metrics)
      }
    }
  }
  const summary = {
    machine,
    client: opts.client,
    gl: opts.gl,
    runs: opts.runs,
    scenarios: Object.fromEntries(
      Object.entries(byScenario).map(([s, runs]) => [
        s,
        { okRuns: runs.length, metrics: aggregate(runs) }
      ])
    )
  }
  writeFileSync(path.join(opts.outDir, 'aggregate.json'), JSON.stringify(summary, null, 1))
  console.log(`[perf] wrote ${opts.outDir}`)
}

await main()
process.exit(0)
