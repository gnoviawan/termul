/**
 * Linux perf runner for the Termul desktop client candidates. See README.md.
 *
 *   bun run perf --scenarios stream-storm,pty-flood --runs 3   (from apps/gpuix)
 *   bun run perf --client chromium,gpuix ...                   (interleaved per run)
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
import type { ChatStartPart, ClientDriver, ClientKind, GlMode } from './clients/client.ts'
import { gpuixDriver, launchGpuix } from './clients/gpuix.ts'
import { launchTauri, tauriDriver } from './clients/tauri.ts'
import {
  chromiumRole,
  type MachineSample,
  type ProcSample,
  type RoleOf,
  startMachineSampler,
  startProcSampler,
  waitForQuiet,
  withPageRenderer
} from './proc-sampler.ts'
import { DEFAULTS, type Flags, type PhaseClock, SCENARIOS, type ScenarioName } from './scenarios.ts'
import { type ScreenLog, startScreenLog, summarizeScreen } from './screen-frames.ts'
import { PERF_PROJECT_NAME, startPerfServer } from './server.ts'
import { aggregate, median, type Numbers, summarizePage, summarizeProc } from './stats.ts'
import { snapshotThreads, type ThreadSnapshot, threadCpu } from './thread-sampler.ts'

const HERE = import.meta.dir

interface Options {
  scenarios: ScenarioName[]
  runs: number
  clients: ClientKind[]
  gl: GlMode
  serverBin: string
  /** Per-client server binary, so each client can run against its own branch's server. */
  serverBinOf: Partial<Record<ClientKind, string>>
  /** The Windows desktop app build for the `tauri` client (see README). */
  tauriExe: string
  port: number
  display: string
  width: number
  height: number
  seed: number
  /** Wait before each run until the machine's busy CPU drops under this (% of one core). */
  quietBelowPct: number
  quietWaitS: number
  noPageMetrics: boolean
  /** Log X DAMAGE events on the run's display for screen frame timing. */
  screenFrames: boolean
  /** Per-run server state, client state and probe files go under here. */
  stateRoot: string
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
  const serverBinOf: Options['serverBinOf'] = {}
  for (const client of CLIENTS) {
    const bin = take(`server-bin-${client}`, '')
    if (bin) serverBinOf[client] = path.resolve(bin)
  }
  const opts: Options = {
    scenarios: take('scenarios', 'stream-storm,pty-flood').split(',') as ScenarioName[],
    runs: Number(take('runs', '3')),
    clients: take('client', 'chromium').split(',') as ClientKind[],
    gl: take('gl', WIN ? 'gpu' : 'lavapipe') as GlMode,
    serverBin: path.resolve(take('server-bin', '/root/gpuix-bin/termul-server')),
    serverBinOf,
    tauriExe: take('tauri-exe', ''),
    port: Number(take('port', '8196')),
    display: take('display', ':181'),
    width: Number(take('width', '1440')),
    height: Number(take('height', '900')),
    seed: Number(take('seed', '42')),
    quietBelowPct: Number(take('quiet-below', '150')),
    quietWaitS: Number(take('quiet-wait', '600')),
    noPageMetrics: take('page-metrics', 'on') === 'off',
    // X DAMAGE frame logging has no Windows counterpart here.
    screenFrames: !WIN && take('screen-frames', 'on') !== 'off',
    stateRoot: path.resolve(
      take(
        'state-root',
        process.env.GPUIX_STATE_ROOT ?? (WIN ? path.join(os.tmpdir(), 'gpuixb0') : '/tmp/gpuix-b0')
      )
    ),
    distWeb: path.resolve(take('dist-web', DIST_WEB)),
    outDir: path.resolve(take('out', path.join(HERE, 'results', `linux-${stamp}`))),
    overrides: {}
  }
  for (const s of opts.scenarios) if (!(s in SCENARIOS)) throw new Error(`unknown scenario ${s}`)
  for (const c of opts.clients) if (!CLIENTS.includes(c)) throw new Error(`unknown client ${c}`)
  for (const [k, v] of Object.entries(raw)) opts.overrides[k] = Number(v)
  return opts
}

const CLIENTS: ClientKind[] = ['chromium', 'gpuix', 'tauri']
const WIN = process.platform === 'win32'

/** The GPUIX client is one Bun process; anything it starts would be `other`. */
const gpuixRole: RoleOf = (_pid, cmd) => (/dist[\\/]main\.js/.test(cmd) ? 'app' : 'other')

/**
 * The desktop app runs its Rust core in process, so its tree also holds what
 * the server tree holds for the other clients: agents, shells and probes.
 */
const tauriRole: RoleOf = (pid, cmd) => {
  if (cmd.includes('fake-agent')) return 'agent'
  if (cmd.includes('terminal-probe')) return 'probe'
  if (/msedgewebview2/i.test(cmd)) return chromiumRole(pid, cmd)
  if (/termul-manager/i.test(cmd)) return 'app'
  return 'other'
}

const serverRole: RoleOf = (_pid, cmd) => {
  if (cmd.includes('termul-server')) return 'server'
  if (cmd.includes('fake-agent')) return 'agent'
  if (cmd.includes('terminal-probe')) return 'probe'
  return 'other'
}

/** Windows clients draw on the interactive desktop, so there is no display to start. */
async function startXvfb(
  display: string,
  width: number,
  height: number
): Promise<ChildProcess | null> {
  if (WIN) return null
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

const within = <T extends { t: number }>(samples: T[], from: number, to: number) =>
  samples.filter((s) => s.t >= from && s.t <= to)

interface PhaseWindow {
  name: string
  from: number
  to: number
  bytes: { down: number; up: number }
  page: Numbers
  threads?: { before: ThreadSnapshot; after: ThreadSnapshot }
}

async function runOnce(
  opts: Options,
  client: ClientKind,
  scenario: ScenarioName,
  runIndex: number
) {
  const flags: Flags = { ...DEFAULTS[scenario], ...opts.overrides }
  // No dashes: the GPUIX lane types probe paths as keystrokes.
  const scratch = path.join(opts.stateRoot, `${client}${scenario.replace(/-/g, '')}${runIndex}`)
  mkdirSync(scratch, { recursive: true })
  const errors: string[] = []
  const notes: Record<string, unknown> = {}
  const windows: PhaseWindow[] = []
  const quiet = await waitForQuiet(opts.quietBelowPct, opts.quietWaitS)
  const load1Before = os.loadavg()[0]

  const xvfb = await startXvfb(opts.display, opts.width, opts.height)
  const screen: ScreenLog | null = opts.screenFrames ? await startScreenLog(opts.display) : null
  const agentEnv = {
    PERF_AGENT_SEED: String(opts.seed),
    PERF_AGENT_RATE: String(flags.rate ?? 20),
    PERF_AGENT_CHUNK_CHARS: '120',
    PERF_AGENT_UNIQUE_SESSIONS: '1'
  }
  // The desktop app carries its own core; every other client talks to a server.
  const serverBin = client === 'tauri' ? null : (opts.serverBinOf[client] ?? opts.serverBin)
  const server = serverBin
    ? await startPerfServer({ binary: serverBin, port: opts.port, stateRoot: scratch, agentEnv })
    : null
  const serverSampler = server ? startProcSampler(server.pid, serverRole) : null
  const machineSampler = startMachineSampler()
  const proxy = await startByteProxy(opts.port, opts.port + 1).catch(async (err) => {
    await server?.stop()
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
    const launchOpts = {
      url: proxy.url,
      display: opts.display,
      width: opts.width,
      height: opts.height,
      distWeb: opts.distWeb,
      gl: opts.gl,
      noPageMetrics: opts.noPageMetrics
    }
    if (client === 'gpuix') {
      const handle = await launchGpuix({
        ...launchOpts,
        clientStateDir: path.join(scratch, 'client')
      })
      sampler = startProcSampler(handle.rootPid, gpuixRole)
      driver = gpuixDriver(handle)
    } else if (client === 'tauri') {
      if (!opts.tauriExe) throw new Error('the tauri client needs --tauri-exe')
      const handle = await launchTauri({
        ...launchOpts,
        exe: opts.tauriExe,
        projectDir: path.join(scratch, PERF_PROJECT_NAME),
        agentEnv
      })
      sampler = startProcSampler(handle.rootPid, tauriRole)
      driver = tauriDriver(handle, opts.width, opts.height)
    } else {
      const handle = await launchChromium(launchOpts)
      sampler = startProcSampler(handle.rootPid, chromiumRole)
      driver = chromiumDriver(handle)
    }
    const handle = driver.handle
    notes.client = handle.version
    notes.backend = handle.backend
    startup['startup.processUpMs'] = Math.round(handle.launchedMs)
    const since = () => Math.round(performance.now() - t0 - (handle.launchOverheadMs ?? 0))
    await driver.waitForProjectList()
    startup['startup.projectListMs'] = since()
    await driver.waitForLauncher()
    startup['startup.launcherReadyMs'] = since()
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
        const before = snapshotThreads(d.handle.rootPid)
        const from = Date.now()
        await body()
        const to = Date.now()
        const after = snapshotThreads(d.handle.rootPid)
        const bytes = proxy.counters()
        const page = await d.endPhase(name)
        windows.push({
          name,
          from,
          to,
          bytes,
          page: page && !opts.noPageMetrics ? summarizePage(page, to - from) : {},
          threads: { before, after }
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
    notes.chatStartParts = d.chatStartParts()
  } catch (err) {
    errors.push(`fatal: ${err instanceof Error ? err.stack : String(err)}`)
  } finally {
    const crash = await driver?.crashed().catch(() => null)
    if (crash) errors.push(`fatal: app crashed: ${crash}`)
    if (sampler) {
      clientSamples = sampler.stop()
      processes = sampler.processes()
      const roleOfPid = new Map(processes.map((p) => [p.pid, p.role]))
      if (client !== 'gpuix') notes.pageRendererPid = withPageRenderer(clientSamples, roleOfPid)
      const pageRenderer = notes.pageRendererPid
      const role = (pid: number) =>
        pid === pageRenderer ? 'page-renderer' : (roleOfPid.get(pid) ?? 'other')
      notes.threads = Object.fromEntries(
        windows.flatMap((w) =>
          w.threads ? [[w.name, threadCpu(w.threads.before, w.threads.after, role)]] : []
        )
      )
    }
    await driver?.handle.close()
    await screen?.stop()
    await proxy.close()
    serverSamples = serverSampler?.stop() ?? []
    machineSamples = machineSampler.stop()
    await server?.stop()
    xvfb?.kill()
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
    if (screen)
      Object.assign(
        metrics,
        prefixed(w.name, summarizeScreen(screen.frames(w.from, w.to), w.to - w.from))
      )
    const serverProc = summarizeProc(within(serverSamples, w.from, w.to), 'server.')
    const serverCpu = serverProc['server.total.cpuMeanPct'] ?? 0
    const machine = within(machineSamples, w.from, w.to).map((m) => m.busy)
    const machineCpu = machine.length ? machine.reduce((a, b) => a + b, 0) / machine.length : 0
    const clientCpu = metrics[`${w.name}.proc.total.cpuMeanPct`] ?? 0
    metrics[`${w.name}.machine.cpuBusyPct`] = Math.round(machineCpu)
    metrics[`${w.name}.machine.foreignCpuPct`] = Math.round(
      Math.max(0, machineCpu - clientCpu - serverCpu)
    )
    metrics[`${w.name}.durationS`] = Math.round(seconds * 10) / 10
    // The whole product: the client plus the backend, agents and shells it
    // relies on, which live in the server tree or, for the desktop app, its own.
    metrics[`${w.name}.product.cpuMeanPct`] = Math.round((clientCpu + serverCpu) * 10) / 10
    metrics[`${w.name}.product.pssMedianMB`] =
      Math.round(
        ((metrics[`${w.name}.proc.total.pssMedianMB`] ?? 0) +
          (serverProc['server.total.pssMedianMB'] ?? 0)) *
          10
      ) / 10
    if (client !== 'tauri') {
      metrics[`${w.name}.server.cpuMeanPct`] = serverCpu
      metrics[`${w.name}.bytesDownKBps`] = Math.round(w.bytes.down / 1024 / seconds)
      metrics[`${w.name}.bytesUpKBps`] = Math.round(w.bytes.up / 1024 / seconds)
    }
  }
  // On Windows the probe's cursor position request is answered on the server
  // side (replies kept coming after the client closed), so it does not time the client.
  if (!WIN) Object.assign(metrics, probeMetrics(notes))
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
  const parts = notes.chatStartParts as ChatStartPart[] | undefined
  if (parts && parts.length > 1) {
    metrics['chat.typeUnderLoadP50Ms'] = median(parts.slice(1).map((p) => p.typeMs))
    metrics['chat.openUnderLoadP50Ms'] = median(parts.slice(1).map((p) => p.openMs))
  }
  if (typeof notes.switches === 'number') metrics['chat.switches'] = notes.switches
  return {
    meta: {
      scenario,
      run: runIndex,
      client,
      clientVersion: notes.client,
      backend: notes.backend,
      gl: opts.gl,
      serverBin,
      platform: process.platform,
      pageMetrics: client === 'chromium' && !opts.noPageMetrics,
      screenFrames: opts.screenFrames,
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
  // One client keeps B0's flat layout; several get a directory each, so
  // perf:report can take them as separate columns.
  const dirOf = (client: ClientKind) =>
    opts.clients.length > 1 ? path.join(opts.outDir, client) : opts.outDir
  const byClient = new Map<ClientKind, Record<string, Numbers[]>>()
  for (const client of opts.clients) {
    mkdirSync(dirOf(client), { recursive: true })
    byClient.set(client, {})
  }
  const writeAggregate = (client: ClientKind) => {
    const byScenario = byClient.get(client) ?? {}
    const summary = {
      machine,
      client,
      gl: opts.gl,
      runs: opts.runs,
      scenarios: Object.fromEntries(
        Object.entries(byScenario).map(([s, runs]) => [
          s,
          { okRuns: runs.length, metrics: aggregate(runs) }
        ])
      )
    }
    writeFileSync(path.join(dirOf(client), 'aggregate.json'), JSON.stringify(summary, null, 1))
  }
  // Interleaved: run 1 of every scenario on every client, then run 2, so
  // drift and other units' load hit every cell alike. Even runs reverse the
  // client order, so neither client always goes first.
  for (let run = 1; run <= opts.runs; run++) {
    const order = run % 2 === 0 ? [...opts.clients].reverse() : opts.clients
    for (const scenario of opts.scenarios) {
      for (const client of order) {
        console.log(`[perf] ${client} ${scenario} run ${run}/${opts.runs}`)
        const record = await runOnce(opts, client, scenario, run)
        writeFileSync(
          path.join(dirOf(client), `${scenario}-run${run}.json`),
          JSON.stringify({ machine, ...record })
        )
        console.log(
          `[perf]   status=${record.meta.status} errors=${record.errors.length} preRunBusy=${record.meta.preRunBusyPct}% waited=${record.meta.quietWaitS}s load1=${record.meta.load1Before.toFixed(1)}`
        )
        for (const e of record.errors) console.log(`[perf]   ! ${e.split('\n')[0]}`)
        if (record.meta.status === 'ok') {
          const byScenario = byClient.get(client) ?? {}
          byScenario[scenario] ??= []
          byScenario[scenario].push(record.metrics)
        }
        writeAggregate(client)
      }
    }
  }
  console.log(`[perf] wrote ${opts.outDir}`)
}

await main()
process.exit(0)
