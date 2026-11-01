#!/usr/bin/env node
// Reconnect lab: times the web client's recovery after connection faults.
//
//   node tools/reconnect-lab/run.mjs [--only s1,s3a] [--repeat 2] [--web-dir dist-web]
//        [--server-bin <path>] [--hide override+pause|override|pause|freeze] [--rtt <ms>]
//        [--out <dir>] [--headed]
//   node tools/reconnect-lab/run.mjs --from tools/reconnect-lab/out   (re-analyse a saved run)
//
// Prints one table per run and writes per-scenario timelines to
// tools/reconnect-lab/out/<scenario>.run<N>.log plus out/results.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startFaultProxy } from './fault-proxy.mjs'
import {
  defaultServerBinary,
  freePort,
  killAgents,
  LAB_DEVICE_ID,
  LAB_TOKEN,
  launchChat,
  loadPlaywright,
  registerProject,
  repoRoot,
  routeWebDir,
  startLabServer
} from './lab-env.mjs'
import {
  chunkAt,
  controlStateAt,
  controlTransitions,
  describe,
  isRecovered,
  recovery,
  slowestSteps
} from './metrics.mjs'
import { SCENARIOS } from './scenarios.mjs'

const LAB_DIR = resolve(repoRoot(), 'tools', 'reconnect-lab')
const RECOVERY_TIMEOUT_MS = 180_000

function parseArgs(argv) {
  const args = {
    only: null,
    repeat: 1,
    webDir: null,
    serverBin: null,
    hide: 'override+pause',
    headed: false,
    rttMs: 0
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => argv[++i]
    if (flag === '--only') args.only = value().split(',')
    else if (flag === '--repeat') args.repeat = Number(value())
    else if (flag === '--web-dir') args.webDir = resolve(value())
    else if (flag === '--server-bin') args.serverBin = resolve(value())
    else if (flag === '--hide') args.hide = value()
    else if (flag === '--rtt') args.rttMs = Number(value())
    else if (flag === '--out') args.out = resolve(value())
    else if (flag === '--from') args.from = resolve(value())
    else if (flag === '--headed') args.headed = true
    else throw new Error(`unknown flag ${flag}`)
  }
  if (!args.from) args.serverBin ??= defaultServerBinary()
  return args
}

const args = parseArgs(process.argv.slice(2))
const outDir = args.out ?? join(LAB_DIR, 'out')
mkdirSync(outDir, { recursive: true })
const scenarios = SCENARIOS.filter(
  (s) => !args.only || args.only.includes(s.id) || args.only.includes(s.name)
)
if (scenarios.length === 0) throw new Error(`no scenario matches ${args.only}`)

/** Where proxy/server/page events go: the running scenario's event list. */
let sink = null
const emit = (e) => sink?.push(e)

const cleanups = []
async function cleanup() {
  while (cleanups.length > 0) {
    await cleanups
      .pop()()
      .catch((err) => console.error(`cleanup: ${err.message}`))
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error(`\n${signal}: stopping lab processes`)
    void cleanup().then(() => process.exit(130))
  })
}

const serverLog = []
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const NOISY_SERVER_LINE = /watch subscribed|\[fs-watch\]|git_api|git_diff_stat_api|worktree_api/

async function main() {
  const serverPort = await freePort(8300)
  const server = await startLabServer({
    binary: args.serverBin,
    port: serverPort,
    onLine: (text) => {
      serverLog.push(`${new Date().toISOString()} ${text}`)
      const clean = text.replace(ANSI_SGR, '').replace(/^\S+Z\s+/, '')
      if (!NOISY_SERVER_LINE.test(clean))
        emit({ t: Date.now(), src: 'server', type: 'line', text: clean.slice(0, 400) })
    }
  })
  cleanups.push(() => server.stop())
  const proxy = await startFaultProxy({
    targetPort: serverPort,
    listenPort: await freePort(serverPort + 1),
    delayMs: args.rttMs / 2,
    onEvent: emit
  })
  cleanups.push(() => proxy.close())
  const origin = `http://127.0.0.1:${proxy.port}`
  console.log(
    `server ${args.serverBin} on :${serverPort}, proxy :${proxy.port}, web assets ${args.webDir ?? 'served by the server'}, hide method ${args.hide}, added rtt ${args.rttMs} ms`
  )

  const { chromium } = loadPlaywright()
  const browser = await chromium.launch({
    headless: !args.headed,
    args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks']
  })
  cleanups.push(() => browser.close())

  const probeSource = readFileSync(join(LAB_DIR, 'page-probe.js'), 'utf8')
  const allRuns = []
  for (let run = 1; run <= args.repeat; run++) {
    const rows = []
    for (const scenario of scenarios) {
      console.log(`\n[run ${run}] ${scenario.id} ${scenario.name}: ${scenario.returnDef}`)
      const row = await runScenario({ scenario, run, browser, server, proxy, origin, probeSource })
      rows.push(row)
      printRow(row)
    }
    allRuns.push({ run, rows })
    printTable(run, rows)
    printProbe(rows)
  }
  writeFileSync(
    join(outDir, 'results.json'),
    `${JSON.stringify({ args, runs: allRuns }, null, 2)}\n`
  )
  writeFileSync(join(outDir, 'server.log'), `${serverLog.join('\n')}\n`)
}

async function runScenario({ scenario, run, browser, server, proxy, origin, probeSource }) {
  const events = []
  sink = events
  proxy.pass()
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()
  try {
    await context.exposeBinding('__labEmit', (_source, e) => emit(e))
    const config = { origin, token: LAB_TOKEN, deviceId: LAB_DEVICE_ID }
    await context.addInitScript({
      content: `window.__labConfig = ${JSON.stringify(config)};\n${probeSource}`
    })
    if (args.webDir) await routeWebDir(context, origin, args.webDir)
    const cdp = await context.newCDPSession(page)
    // Enabled once up front: enabling parses every script, which must not
    // land on the measured return path.
    if (args.hide.split('+').includes('pause')) await cdp.send('Debugger.enable')
    const project = await registerProject(server, scenario.name)

    const mark = (label) => {
      const t = Date.now()
      emit({ t, src: 'lab', type: 'mark', label })
      return t
    }
    const evaluate = (fn, arg) =>
      Promise.race([
        page.evaluate(fn, arg),
        sleep(10_000).then(() => Promise.reject(new Error('evaluate timed out')))
      ])
    const ctx = {
      proxy,
      sleep,
      mark,
      // Hide methods (combine with '+'): `override` flips document.visibilityState
      // and dispatches visibilitychange/blur; `pause` stops the page's JS with
      // Debugger.pause (events queue until resume, like a frozen tab);
      // `freeze` is CDP Page.setWebLifecycleState, which Playwright's always-
      // visible pages ignore (the p0 probe shows it).
      async hide(method = args.hide) {
        const t = mark(`hide (${method})`)
        const parts = method.split('+')
        if (parts.includes('override')) await evaluate(() => window.__labSetHidden(true))
        if (parts.includes('pause') || parts.includes('freeze')) await sleep(300)
        if (parts.includes('pause')) {
          await cdp.send('Debugger.enable')
          await cdp.send('Debugger.pause')
        }
        if (parts.includes('freeze'))
          await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
        return t
      },
      async show(method = args.hide) {
        const t = mark(`show (${method})`)
        const parts = method.split('+')
        if (parts.includes('freeze'))
          await cdp.send('Page.setWebLifecycleState', { state: 'active' })
        if (parts.includes('pause')) await cdp.send('Debugger.resume')
        if (parts.includes('override')) await evaluate(() => window.__labSetHidden(false))
        return t
      },
      waitForEvent: (predicate, timeoutMs) =>
        waitFor(() => events.some(predicate), timeoutMs, 'a scenario event'),
      waitRecovered: (returnAt, timeoutMs) => waitRecovered(events, returnAt, returnAt, timeoutMs)
    }

    const prompt = `[DURATION:${scenario.turnSec}] reconnect lab ${scenario.name}`
    mark('launch chat')
    await launchChat(page, origin, project, prompt)
    await waitFor(
      () => {
        const now = Date.now()
        const lastChunk = events.filter((e) => e.type === 'chunk').at(-1)
        return (
          chunkAt(events, now) >= 3 &&
          controlStateAt(controlTransitions(events), now) === 'connected' &&
          lastChunk &&
          now - lastChunk.t < 2_500
        )
      },
      120_000,
      'healthy streaming before the fault'
    )
    await sleep(2_000)
    mark('healthy: fault starts')

    const loadAtFault = loadavg()
      .map((n) => n.toFixed(1))
      .join(' ')
    const proxyBefore = proxy.stats()
    const { faultAt, returns } = await scenario.run(ctx)
    const lastReturn = returns.at(-1).t
    await waitRecovered(events, faultAt, lastReturn, RECOVERY_TIMEOUT_MS)
    await sleep(3_000)
    const end = Date.now()
    mark('window end')

    const windows = returns.map((r, i) => ({
      label: r.label ?? null,
      faultAt: i === 0 ? faultAt : r.t,
      returnAt: r.t,
      end: returns[i + 1]?.t ?? end
    }))
    const row = analyze(
      {
        run,
        id: scenario.id,
        name: scenario.name,
        returnDef: scenario.returnDef,
        loadavg: {
          atFault: loadAtFault,
          atEnd: loadavg()
            .map((n) => n.toFixed(1))
            .join(' ')
        },
        proxy: proxyDelta(proxyBefore, proxy.stats()),
        logFile: join(outDir, `${scenario.name}.run${run}.log`)
      },
      windows,
      events
    )
    writeTimeline(row, events)
    writeFileSync(row.logFile.replace(/\.log$/, '.events.json'), JSON.stringify(events))
    return row
  } catch (error) {
    const logFile = join(outDir, `${scenario.name}.run${run}.log`)
    writeTimeline(
      {
        id: scenario.id,
        name: scenario.name,
        run,
        error: String(error),
        results: [],
        steps: [],
        logFile
      },
      events
    )
    console.error(`  ${scenario.id} failed: ${error.stack ?? error}`)
    return {
      run,
      id: scenario.id,
      name: scenario.name,
      returnDef: scenario.returnDef,
      error: String(error),
      results: [],
      steps: []
    }
  } finally {
    proxy.pass()
    await Promise.race([context.close(), sleep(15_000)]).catch(() => {})
    await killAgents(server)
    sink = null
  }
}

/** Every number in a row comes from `windows` + `events`, so a saved run can be re-analysed. */
function analyze(row, windows, events) {
  const results = windows.map((w) => ({ ...w, ...recovery(events, w) }))
  const steps = windows.map((w, i) => {
    const r = results[i]
    return slowestSteps(events, {
      returnAt: w.returnAt,
      until: r.liveMs === null ? w.end : w.returnAt + r.liveMs
    })
  })
  const isResumeLog = (e) => e.type === 'log' && e.source === 'WsAcpTransport.resumeValidation'
  const resumeReasons = events
    .filter(isResumeLog)
    .map((e) => ({ t: e.t, reason: e.message.split(':')[0] }))
  const probe =
    row.id === 'p0'
      ? windows.map((w) => ({
          method: w.label,
          lifecycle: events
            .filter((e) => e.type === 'lifecycle' && e.t >= w.returnAt && e.t <= w.returnAt + 8_000)
            .map((e) => e.event),
          validateOnResume: events
            .filter((e) => isResumeLog(e) && e.t >= w.returnAt && e.t <= w.returnAt + 8_000)
            .map((e) => e.message.split(':')[0])
        }))
      : undefined
  return { ...row, results, steps, resumeReasons, probe }
}

/** `--from <dir>`: recompute every table and timeline from a saved run without a browser. */
function reanalyze(dir) {
  const saved = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))
  for (const { run, rows } of saved.runs) {
    const fresh = rows.map((row) => {
      if (row.error) return row
      const logFile = join(dir, `${row.name}.run${run}.log`)
      const events = JSON.parse(readFileSync(logFile.replace(/\.log$/, '.events.json'), 'utf8'))
      const windows = row.results.map(({ label, faultAt, returnAt, end }) => ({
        label,
        faultAt,
        returnAt,
        end
      }))
      const next = analyze({ ...row, logFile }, windows, events)
      writeTimeline(next, events)
      return next
    })
    printTable(run, fresh)
    printProbe(fresh)
  }
}

function proxyDelta(before, after) {
  const delta = {}
  for (const key of ['accepted', 'refused', 'reset', 'bytesUp', 'bytesDown'])
    delta[key] = after[key] - before[key]
  return delta
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

async function waitRecovered(events, faultAt, returnAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!isRecovered(events, { faultAt, returnAt, end: Date.now() })) {
    if (Date.now() > deadline) return false
    await sleep(250)
  }
  return true
}

const fmt = (ms) => (ms === null || ms === undefined ? 'never' : String(Math.round(ms)))

function median(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.floor(sorted.length / 2)]
}

function summarize(row) {
  if (row.error)
    return { connected: 'error', stream: 'error', live: 'error', overlay: '', ws: '', proxy: '' }
  if (row.results.length === 1) {
    const r = row.results[0]
    return {
      connected: fmt(r.connectedMs),
      stream: fmt(r.streamMs),
      live: fmt(r.liveMs),
      overlay: fmt(r.overlayMs),
      ws: `${r.wsOpened} (acp ${r.wsByRole.acp}, store ${r.wsByRole.store})`,
      proxy: String(r.proxyUpgrades)
    }
  }
  const list = (key) => row.results.map((r) => fmt(r[key])).join('/')
  return {
    connected: `med ${fmt(median(row.results.map((r) => r.connectedMs)))} [${list('connectedMs')}]`,
    stream: `med ${fmt(median(row.results.map((r) => r.streamMs)))} [${list('streamMs')}]`,
    live: `med ${fmt(median(row.results.map((r) => r.liveMs)))} [${list('liveMs')}]`,
    overlay: `[${list('overlayMs')}]`,
    ws: String(row.results.reduce((n, r) => n + r.wsOpened, 0)),
    proxy: String(row.results.reduce((n, r) => n + r.proxyUpgrades, 0))
  }
}

function printRow(row) {
  const s = summarize(row)
  console.log(
    `  connected-after ${s.connected} ms, stream-resumed-after ${s.stream} ms, live-again-after ${s.live} ms, reconnecting-visible ${s.overlay} ms, ws ${s.ws}`
  )
}

function printProbe(rows) {
  for (const row of rows) {
    if (!row.probe) continue
    console.log(
      '\nLifecycle probe (link blackholed across hide/show, so a resume probe must fail and log its reason):'
    )
    for (const p of row.probe) {
      const reasons =
        p.validateOnResume.length > 0
          ? p.validateOnResume.join(', ')
          : 'none (validateOnResume never ran)'
      console.log(
        `  ${p.method.padEnd(16)} lifecycle events after show: ${p.lifecycle.join(', ') || 'none'}; validateOnResume: ${reasons}`
      )
    }
  }
}

function printTable(run, rows) {
  const header = [
    'scenario',
    'connected-after-ms',
    'stream-resumed-after-ms',
    'live-again-after-ms',
    'reconnecting-visible-ms',
    'ws-connections (page)',
    'ws-upgrades (proxy)'
  ]
  const body = rows.map((row) => {
    const s = summarize(row)
    return [`${row.id} ${row.name}`, s.connected, s.stream, s.live, s.overlay, s.ws, s.proxy]
  })
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)))
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`
  console.log(`\nRun ${run}`)
  console.log(line(header))
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`)
  for (const r of body) console.log(line(r))
}

function writeTimeline(row, events) {
  const sorted = [...events].sort((a, b) => a.t - b.t)
  const origin = row.results?.[0]?.returnAt ?? sorted[0]?.t ?? Date.now()
  const rel = (t) => {
    const s = (t - origin) / 1000
    return `R${s >= 0 ? '+' : '-'}${Math.abs(s).toFixed(3).padStart(8)}s`
  }
  const lines = [`# ${row.id} ${row.name} run ${row.run}: ${row.returnDef ?? ''}`]
  if (row.error) lines.push(`# ERROR ${row.error}`)
  if (row.proxy) lines.push(`# proxy from fault to end: ${JSON.stringify(row.proxy)}`)
  if (row.loadavg)
    lines.push(
      `# host loadavg (1/5/15 min) at fault ${row.loadavg.atFault}, at end ${row.loadavg.atEnd}`
    )
  for (const [i, r] of (row.results ?? []).entries()) {
    lines.push(
      `# window ${i + 1}${r.label ? ` (${r.label})` : ''}: return at ${rel(r.returnAt)}, state at return ${r.stateAtReturn}, connected-after ${fmt(r.connectedMs)} ms, stream-resumed-after ${fmt(r.streamMs)} ms, live-again-after ${fmt(r.liveMs)} ms (live chunk at return ~${r.liveChunkAtReturn}, DOM had ${r.baseChunk}; gap since last chunk before fault ${fmt(r.streamGapMs)} ms), main thread busy ${fmt(r.mainThreadBusyMs)} ms of that, reconnecting visible ${fmt(r.overlayMs)} ms after return / ${fmt(r.overlayTotalMs)} ms total, ws opened ${r.wsOpened} ${JSON.stringify(r.wsByRole)}, proxy upgrades ${r.proxyUpgrades}`
    )
    for (const step of row.steps[i] ?? []) {
      lines.push(
        `#   slow step ${fmt(step.ms)} ms: ${rel(step.from.t)} ${step.from.label}  ==>  ${rel(step.to.t)} ${step.to.label}`
      )
    }
  }
  if (row.resumeReasons?.length) {
    lines.push(
      `# resumeValidation failures: ${row.resumeReasons.map((r) => `${rel(r.t)} ${r.reason}`).join('; ')}`
    )
  }
  lines.push(
    '# timestamps are relative to the first return instant R (page events use the page clock)'
  )
  for (const e of sorted) {
    if (e.type === 'ws-heartbeat') continue
    lines.push(`${rel(e.t)} ${e.src.padEnd(6)} ${describe(e)}`)
  }
  writeFileSync(row.logFile, `${lines.join('\n')}\n`)
}

try {
  if (args.from) reanalyze(args.from)
  else await main()
} catch (error) {
  console.error(error.stack ?? error)
  process.exitCode = 1
} finally {
  await cleanup()
}
