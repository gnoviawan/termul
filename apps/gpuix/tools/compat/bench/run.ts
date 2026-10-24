/**
 * `bun tools/compat/bench/run.ts [--runs N] [--rows N] [--loop mount|rerender]`
 *
 * The compat performance gate: the real `ProjectItem` through the compat
 * runtime against a direct GPUIX hand-port of the same rows, same store,
 * same window. Each run is a fresh process under Xvfb + lavapipe with
 * production React; modes alternate so drift hits both. Prints the median
 * and spread (min..max) of every metric and the compat/hand ratio.
 *
 * `--loop` instead repeats one phase back to back with no sleeps and reports
 * the JS thread's CPU time per iteration, which contention from other
 * processes on a shared host does not inflate the way it inflates wall time.
 * `--profile DIR` writes a `bun --cpu-prof-md` profile of every run there.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { APP_DIR, buildClient } from '../../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import { LAVAPIPE_ICD, startXvfb } from '../../parity/shoot-gpuix'
import { stateRoot } from '../../shared/seed'

const STATE = stateRoot('/tmp/gpuix-c1')
mkdirSync(STATE, { recursive: true })

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runs: { type: 'string', default: '7' },
    rows: { type: 'string', default: '60' },
    loop: { type: 'string' },
    profile: { type: 'string' }
  }
})
if (values.loop !== undefined && values.loop !== 'mount' && values.loop !== 'rerender') {
  console.error('--loop takes mount or rerender')
  process.exit(2)
}

const build = await buildClient(
  path.join(APP_DIR, 'tools/compat/bench/main.ts'),
  path.join(APP_DIR, 'dist-bench'),
  { production: true }
)
for (const line of build.logs) console.error(line)
if (!build.ok) process.exit(1)

type Mode = 'compat' | 'hand'

type GateResult = {
  mode: string
  mountMs: number
  warmMountMs: number
  rerenderMs: number
  rssMb: number
  nodes: number
  renamedPainted: boolean
  hoverShowsActions: boolean
  frames: { p90Ms?: number; maxMs?: number; frames: number; samples: number }
}

type LoopResult = { iterations: number; msPerIteration: number; cpuMsPerIteration: number }

async function once<T>(mode: Mode, i: number): Promise<T> {
  const out = path.join(STATE, `bench-${mode}-${i}.json`)
  rmSync(out, { force: true })
  const xvfb = await startXvfb(WINDOW_WIDTH, WINDOW_HEIGHT)
  try {
    const profile = values.profile
      ? ['--cpu-prof-md', `--cpu-prof-dir=${path.resolve(values.profile, `${mode}-${i}`)}`]
      : []
    const child = Bun.spawn(['bun', ...profile, build.entry], {
      cwd: path.dirname(build.entry),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DISPLAY: xvfb.display,
        VK_ICD_FILENAMES: LAVAPIPE_ICD,
        GPUIX_BACKGROUND: '1',
        BENCH_MODE: mode,
        BENCH_OUT: out,
        BENCH_ROWS: values.rows,
        BENCH_PROFILE: values.loop ?? '',
        TERMUL_GPUIX_STATE_DIR: path.join(STATE, `bench-state-${i}`)
      },
      stdout: 'ignore',
      stderr: 'ignore'
    })
    const deadline = Date.now() + 120_000
    while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(100)
    if (child.exitCode === null) child.kill('SIGKILL')
    if (!existsSync(out)) throw new Error(`${mode} run ${i} wrote no result`)
    return JSON.parse(readFileSync(out, 'utf8')) as T
  } finally {
    xvfb.stop()
  }
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return { median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] }
}

async function compare<T>(
  describe: (mode: Mode, i: number, r: T) => string,
  metrics: [string, (r: T) => number][]
) {
  const results: Record<Mode, T[]> = { compat: [], hand: [] }
  const runs = Number(values.runs)
  for (let i = 0; i < runs; i++) {
    for (const mode of i % 2 === 0
      ? (['compat', 'hand'] as const)
      : (['hand', 'compat'] as const)) {
      const r = await once<T>(mode, i)
      results[mode].push(r)
      console.log(describe(mode, i, r))
    }
  }
  console.log(
    `\n${runs} runs per mode, ${values.rows} rows${values.loop ? `, ${values.loop} loop` : ''}`
  )
  for (const [name, pick] of metrics) {
    const c = stat(results.compat.map(pick))
    const h = stat(results.hand.map(pick))
    console.log(
      `${name.padEnd(20)} compat ${c.median.toFixed(2)} (${c.min.toFixed(2)}..${c.max.toFixed(2)})  hand ${h.median.toFixed(2)} (${h.min.toFixed(2)}..${h.max.toFixed(2)})  ratio ${(c.median / h.median).toFixed(2)}`
    )
  }
}

if (values.loop) {
  await compare<LoopResult>(
    (mode, i, r) =>
      `${mode} #${i}: ${r.iterations} iterations, cpu ${r.cpuMsPerIteration.toFixed(3)} ms, wall ${r.msPerIteration.toFixed(3)} ms per iteration`,
    [
      ['js cpu ms / iter', (r) => r.cpuMsPerIteration],
      ['wall ms / iter', (r) => r.msPerIteration]
    ]
  )
} else {
  await compare<GateResult>(
    (mode, i, r) =>
      `${mode} #${i}: mount ${r.mountMs.toFixed(1)} / warm ${r.warmMountMs.toFixed(1)} ms, rerender ${r.rerenderMs.toFixed(2)} ms, hover p90 ${r.frames.p90Ms?.toFixed(2)} ms (${r.frames.samples} samples), rss ${r.rssMb.toFixed(0)} MB, nodes ${r.nodes}, renamed painted ${r.renamedPainted}, hover shows actions ${r.hoverShowsActions}`,
    [
      ['cold mount ms', (r) => r.mountMs],
      ['warm mount ms', (r) => r.warmMountMs],
      ['re-render ms', (r) => r.rerenderMs],
      ['hover frame p90 ms', (r) => r.frames.p90Ms ?? Number.NaN],
      ['hover frame max ms', (r) => r.frames.maxMs ?? Number.NaN],
      ['rss MB', (r) => r.rssMb],
      ['GPUIX nodes', (r) => r.nodes]
    ]
  )
}
