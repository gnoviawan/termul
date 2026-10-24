/**
 * `bun tools/chat/perf.ts [--runs 3] [--seconds 30] [--rate 20] [--chars 120] [--port 8194]
 *   [--clients gpuix,chromium] [--modes proc,probe]`
 *
 * Streaming cost of one open chat, GPUIX transcript scene against the web
 * client in Chromium, under the perf toolkit's stream-storm load (20 updates
 * a second, about 120 characters each). Each client starts the chat itself
 * (the web through its launcher, the scene through the store's `startChat`)
 * and sends the storm prompt, so it owns the live session as a user's chat
 * does.
 *
 * Every run pairs two passes per client:
 *
 * - `proc`: no probes. The process tree is sampled from /proc every 500 ms
 *   with the B0 runner's sampler (RSS, PSS, CPU % of one core).
 * - `probe`: frame and latency probes on. Web: a rAF loop for frame cadence
 *   and a MutationObserver for when each chunk's marker reaches the DOM, then
 *   the second animation frame after it (the one that follows its paint).
 *   GPUIX: GPUI's draw counter and draw time, and the commit of each chunk's
 *   marker into a native `<markdown>`, then the next drawn frame.
 *
 * Latency starts when the scenario agent wrote the chunk to its stdout (its
 * JSONL log), the same clock for both clients. Output: `perf-out/chat/`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Page } from 'playwright'
import {
  LAUNCHER_COMPOSER,
  START_CHAT_SELECTOR,
  waitForLauncher
} from '../../../../tools/perf/runner/scenario-ui.ts'
import { percentile } from '../../../../tools/perf/types.ts'
import { APP_DIR } from '../../build'
import { LAVAPIPE_ICD, startXvfb } from '../parity/shoot-gpuix'
import { DIST_WEB } from '../parity/shoot-web'
import {
  chromiumRole,
  descendants,
  readCmdline,
  startMachineSampler,
  startProcSampler
} from '../perf/proc-sampler'
import { summarizeProc } from '../perf/stats'
import type { StormChunkRecord } from './scenario-agent'
import { stormPrompt } from './scenario-agent'
import { buildScene } from './scene/build'
import type { SceneCommand, ScenePerf } from './scene/contract'
import {
  CHAT_AGENT_CONFIG_ID,
  CHAT_AGENT_NAME,
  CHAT_PROJECT_ID,
  type ChatServer,
  seedChat
} from './seed'

const WIDTH = 1280
const HEIGHT = 800
/** Seconds after the first chunk before sampling starts, and before the storm ends that it stops. */
const WARMUP_S = 5
const COOLDOWN_S = 2

type Client = 'gpuix' | 'chromium'
type Mode = 'proc' | 'probe'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runs: { type: 'string', default: '3' },
    seconds: { type: 'string', default: '30' },
    rate: { type: 'string', default: '20' },
    chars: { type: 'string', default: '120' },
    port: { type: 'string', default: '8194' },
    clients: { type: 'string', default: 'gpuix,chromium' },
    modes: { type: 'string', default: 'proc,probe' },
    out: { type: 'string', default: path.join(APP_DIR, 'perf-out/chat') }
  }
})
const STORM = {
  seconds: Number(values.seconds),
  rate: Number(values.rate),
  chunkChars: Number(values.chars)
}
const OUT = path.resolve(values.out as string)

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

function readStormLog(file: string): StormChunkRecord[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StormChunkRecord)
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

interface Launched {
  rootPid: number
  roleOf: (pid: number, cmd: string) => string
  /** Collect probe data (probe mode), after the storm. */
  collect(): Promise<{ frames: number[]; drawMs: number[]; painted: Record<number, number> }>
  close(): Promise<void>
}

/** Web probe: frame deltas from rAF, and for each marker the second rAF after it reached the DOM. */
function installWebProbe(): void {
  const w = window as unknown as {
    __chatPerf: { frames: number[]; painted: Record<number, number> }
  }
  const perf = { frames: [] as number[], painted: {} as Record<number, number> }
  w.__chatPerf = perf
  let last = 0
  const loop = (t: number) => {
    if (last) perf.frames.push(t - last)
    last = t
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  const seen = new Set<number>()
  new MutationObserver((records) => {
    const fresh: number[] = []
    for (const record of records) {
      const text = record.type === 'characterData' ? (record.target.textContent ?? '') : ''
      const added = [...record.addedNodes].map((node) => node.textContent ?? '').join(' ')
      for (const match of `${text} ${added}`.matchAll(/mk(\d+)x/g)) {
        const id = Number(match[1])
        if (!seen.has(id)) {
          seen.add(id)
          fresh.push(id)
        }
      }
    }
    if (fresh.length === 0) return
    requestAnimationFrame(() =>
      requestAnimationFrame((t) => {
        for (const id of fresh) perf.painted[id] = performance.timeOrigin + t
      })
    )
    // An init script runs before <body> exists, so observe the document itself.
  }).observe(document, { subtree: true, childList: true, characterData: true })
}

async function launchChromiumClient(
  server: ChatServer,
  display: string,
  mode: Mode
): Promise<Launched> {
  const { chat } = server
  const browser = await chromium.launch({
    headless: false,
    env: { ...process.env, DISPLAY: display, VK_ICD_FILENAMES: LAVAPIPE_ICD },
    args: [
      '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks',
      '--use-angle=vulkan',
      '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE',
      '--ignore-gpu-blocklist',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--window-position=0,0'
    ]
  })
  const rootPid = descendants(process.pid).find(
    (pid) =>
      pid !== process.pid &&
      /chrom/i.test(readCmdline(pid)) &&
      !readCmdline(pid).includes('--type=')
  )
  if (!rootPid) throw new Error('no Chromium root process')
  const context = await browser.newContext({
    viewport: null,
    colorScheme: 'dark',
    serviceWorkers: 'block'
  })
  await context.addInitScript(
    ({ token, deviceId }) => {
      localStorage.setItem('termul.webAuthToken', token)
      localStorage.setItem('termul.deviceId', deviceId)
    },
    { token: chat.token, deviceId: chat.deviceId }
  )
  await context.route(`${chat.baseUrl}/**`, async (route) => {
    const request = route.request()
    const file = path.join(
      DIST_WEB,
      new URL(request.url()).pathname === '/' ? 'index.html' : new URL(request.url()).pathname
    )
    if (
      request.method() === 'GET' &&
      file.startsWith(DIST_WEB) &&
      existsSync(file) &&
      !file.endsWith(path.sep)
    ) {
      await route.fulfill({ path: file })
      return
    }
    await route.continue()
  })
  const page: Page = await context.newPage()
  if (mode === 'probe') await page.addInitScript(installWebProbe)
  await page.goto(chat.baseUrl)
  await waitForLauncher(page)
  await page
    .locator(`button[aria-label$="Currently ${CHAT_AGENT_NAME}"]:visible`)
    .first()
    .waitFor({ timeout: 30_000 })
  const composer = page.locator(LAUNCHER_COMPOSER).first()
  await composer.click()
  await composer.pressSequentially(stormPrompt(STORM), { delay: 5 })
  await page.locator(START_CHAT_SELECTOR).first().click()
  return {
    rootPid,
    roleOf: chromiumRole,
    collect: async () => {
      const perf = await page.evaluate(
        () =>
          (
            window as unknown as {
              __chatPerf: { frames: number[]; painted: Record<number, number> }
            }
          ).__chatPerf
      )
      return { frames: perf.frames, drawMs: [], painted: perf.painted }
    },
    close: () => browser.close()
  }
}

async function launchGpuixClient(
  server: ChatServer,
  entry: string,
  display: string,
  mode: Mode,
  dir: string
): Promise<Launched> {
  const control = path.join(dir, 'control.json')
  const perfOut = path.join(dir, 'scene-perf.json')
  let seq = 1
  const command = (body: Record<string, unknown>) =>
    writeFileSync(control, JSON.stringify({ seq: seq++, ...body } as SceneCommand))
  writeFileSync(control, JSON.stringify({ seq: 0, scroll: 'bottom' }))
  const log = path.join(dir, 'gpuix.log')
  const app = Bun.spawn(['bun', entry], {
    cwd: path.dirname(entry),
    env: {
      ...process.env,
      DISPLAY: display,
      VK_ICD_FILENAMES: LAVAPIPE_ICD,
      GPUIX_BACKGROUND: '1',
      TERMUL_SERVER_URL: server.chat.baseUrl,
      TERMUL_SERVER_TOKEN: server.chat.token,
      TERMUL_GPUIX_STATE_DIR: path.join(dir, 'client'),
      CHAT_START: `${CHAT_AGENT_CONFIG_ID}|${CHAT_PROJECT_ID}|${server.chat.root}`,
      CHAT_DEVICE: server.chat.deviceId,
      CHAT_BOX: '477,49,794,536',
      CHAT_CONTROL: control,
      ...(mode === 'probe' ? { CHAT_PERF_OUT: perfOut } : {})
    },
    stdout: Bun.file(log),
    stderr: 'ignore'
  })
  await waitFor(
    () => existsSync(log) && /chat-scene: started /.test(readFileSync(log, 'utf8')),
    60_000,
    'the scene to start its chat'
  )
  command({ prompt: stormPrompt(STORM) })
  return {
    rootPid: app.pid,
    roleOf: (pid) => (pid === app.pid ? 'app' : 'child'),
    collect: async () => {
      command({ flushPerf: true })
      await waitFor(() => existsSync(perfOut), 30_000, 'the scene perf flush')
      const perf = JSON.parse(readFileSync(perfOut, 'utf8')) as ScenePerf
      const painted: Record<number, number> = {}
      let f = 0
      const ids = Object.keys(perf.commits)
        .map(Number)
        .sort((a, b) => perf.commits[a] - perf.commits[b])
      for (const id of ids) {
        while (f < perf.frames.length && perf.frames[f].t <= perf.commits[id]) f++
        if (f < perf.frames.length) painted[id] = perf.frames[f].t
      }
      const frames = perf.frames.slice(1).map((frame, i) => frame.t - perf.frames[i].t)
      return { frames, drawMs: perf.frames.map((frame) => frame.drawMs), painted }
    },
    close: async () => {
      app.kill('SIGTERM')
      await Promise.race([app.exited, Bun.sleep(3000)])
      if (app.exitCode === null) app.kill('SIGKILL')
    }
  }
}

function quarter(values: number[], index: number): number[] {
  const size = Math.ceil(values.length / 4)
  return values.slice(index * size, (index + 1) * size)
}

async function runOnce(client: Client, mode: Mode, run: number, entry: string) {
  const dir = path.join(OUT, `${client}-${mode}-run${run}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const stormLog = path.join(dir, 'storm.jsonl')
  const server = await seedChat({
    port: Number(values.port),
    prompts: 0,
    agentEnv: { CHAT_STORM_LOG: stormLog }
  })
  const xvfb = await startXvfb(WIDTH + 64, HEIGHT + 64)
  let launched: Launched | null = null
  try {
    launched =
      client === 'gpuix'
        ? await launchGpuixClient(server, entry, xvfb.display, mode, dir)
        : await launchChromiumClient(server, xvfb.display, mode)
    await waitFor(() => readStormLog(stormLog).length > 0, 60_000, 'the first storm chunk')
    const first = readStormLog(stormLog)[0].t
    await Bun.sleep(Math.max(0, first + WARMUP_S * 1000 - Date.now()))
    const sampler = startProcSampler(launched.rootPid, launched.roleOf)
    const machine = startMachineSampler()
    const windowStart = Date.now()
    await Bun.sleep(Math.max(0, first + (STORM.seconds - COOLDOWN_S) * 1000 - Date.now()))
    const samples = sampler.stop()
    const busy = machine.stop()
    const windowEnd = Date.now()
    await Bun.sleep(COOLDOWN_S * 1000 + 1500)
    const chunks = readStormLog(stormLog)
    const metrics: Record<string, number> = {
      ...summarizeProc(samples, ''),
      'machine.cpuBusyPct': round(busy.reduce((a, b) => a + b.busy, 0) / Math.max(1, busy.length)),
      'storm.chunks': chunks.length
    }
    if (mode === 'probe') {
      const probe = await launched.collect()
      const inWindow = (t: number) => t >= windowStart && t <= windowEnd
      const latency = chunks
        .filter((chunk) => probe.painted[chunk.id] !== undefined && inWindow(chunk.t))
        .map((chunk) => probe.painted[chunk.id] - chunk.t)
      Object.assign(metrics, {
        'frame.count': probe.frames.length,
        'frame.p50Ms': round(percentile(probe.frames, 0.5)),
        'frame.p95Ms': round(percentile(probe.frames, 0.95)),
        'frame.p99Ms': round(percentile(probe.frames, 0.99)),
        ...(probe.drawMs.length
          ? {
              'draw.p50Ms': round(percentile(probe.drawMs, 0.5), 2),
              'draw.p95Ms': round(percentile(probe.drawMs, 0.95), 2),
              'draw.maxMs': round(Math.max(...probe.drawMs), 2),
              // Growth with reply length: the storm's reply is short in the
              // first quarter of frames and longest in the last.
              'draw.firstQuarterP50Ms': round(percentile(quarter(probe.drawMs, 0), 0.5), 2),
              'draw.lastQuarterP50Ms': round(percentile(quarter(probe.drawMs, 3), 0.5), 2)
            }
          : {}),
        'latency.chunks': latency.length,
        'latency.p50Ms': round(percentile(latency, 0.5)),
        'latency.p95Ms': round(percentile(latency, 0.95)),
        'latency.maxMs': round(latency.length ? Math.max(...latency) : 0)
      })
    }
    const record = { client, mode, run, storm: STORM, windowMs: windowEnd - windowStart, metrics }
    writeFileSync(path.join(dir, 'result.json'), JSON.stringify(record))
    console.log(JSON.stringify(record))
    return record
  } finally {
    await launched?.close().catch(() => undefined)
    xvfb.stop()
    await server.stop()
  }
}

await mkdir(OUT, { recursive: true })
const entry = await buildScene()
const records: Awaited<ReturnType<typeof runOnce>>[] = []
for (let run = 1; run <= Number(values.runs); run++) {
  for (const client of (values.clients as string).split(',') as Client[]) {
    for (const mode of (values.modes as string).split(',') as Mode[]) {
      try {
        records.push(await runOnce(client, mode, run, entry))
      } catch (error) {
        console.error(`[chat-perf] ${client} ${mode} run ${run} failed: ${String(error)}`)
      }
    }
  }
}

const summary: Record<string, Record<string, number>> = {}
for (const client of ['gpuix', 'chromium'] as Client[]) {
  const keys = new Set(
    records.filter((r) => r.client === client).flatMap((r) => Object.keys(r.metrics))
  )
  for (const key of keys) {
    const values = records
      .filter((r) => r.client === client && key in r.metrics)
      .map((r) => r.metrics[key])
    summary[client] = { ...summary[client], [key]: round(percentile(values, 0.5), 2) }
  }
}
writeFileSync(
  path.join(OUT, 'summary.json'),
  JSON.stringify({ storm: STORM, summary, records }, null, 2)
)
console.log(JSON.stringify(summary, null, 2))
