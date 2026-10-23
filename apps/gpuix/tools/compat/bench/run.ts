/**
 * `bun tools/compat/bench/run.ts [--runs N] [--rows N]`
 *
 * The compat performance gate: the real `ProjectItem` through the compat
 * runtime against a direct GPUIX hand-port of the same rows, same store,
 * same window. Each run is a fresh process under Xvfb + lavapipe with
 * production React; modes alternate so drift hits both. Prints the median
 * and spread (min..max) of every metric and the compat/hand ratio.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { APP_DIR, buildClient } from '../../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import { LAVAPIPE_ICD, startXvfb } from '../../parity/shoot-gpuix'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { runs: { type: 'string', default: '7' }, rows: { type: 'string', default: '60' } }
})

const build = await buildClient(path.join(APP_DIR, 'tools/compat/bench/main.ts'), path.join(APP_DIR, 'dist-bench'), { production: true })
for (const line of build.logs) console.error(line)
if (!build.ok) process.exit(1)

type Result = {
  mode: string
  mountMs: number
  warmMountMs: number
  rerenderMs: number
  rssMb: number
  nodes: number
  frames: { p90Ms?: number; maxMs?: number; frames: number; samples: number }
}

async function once(mode: 'compat' | 'hand', i: number): Promise<Result> {
  const out = `/tmp/gpuix-c1/bench-${mode}-${i}.json`
  rmSync(out, { force: true })
  const xvfb = await startXvfb(WINDOW_WIDTH, WINDOW_HEIGHT)
  try {
    const child = Bun.spawn(['bun', build.entry], {
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
        TERMUL_GPUIX_STATE_DIR: `/tmp/gpuix-c1/bench-state-${i}`
      },
      stdout: 'ignore',
      stderr: 'ignore'
    })
    const deadline = Date.now() + 60_000
    while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(100)
    if (child.exitCode === null) child.kill('SIGKILL')
    if (!existsSync(out)) throw new Error(`${mode} run ${i} wrote no result`)
    return JSON.parse(readFileSync(out, 'utf8')) as Result
  } finally {
    xvfb.stop()
  }
}

const results: Record<'compat' | 'hand', Result[]> = { compat: [], hand: [] }
const runs = Number(values.runs)
for (let i = 0; i < runs; i++) {
  for (const mode of i % 2 === 0 ? (['compat', 'hand'] as const) : (['hand', 'compat'] as const)) {
    const r = await once(mode, i)
    results[mode].push(r)
    console.log(`${mode} #${i}: mount ${r.mountMs.toFixed(1)} / warm ${r.warmMountMs.toFixed(1)} ms, rerender ${r.rerenderMs.toFixed(2)} ms, hover p90 ${r.frames.p90Ms?.toFixed(2)} ms (${r.frames.samples} samples), rss ${r.rssMb.toFixed(0)} MB, nodes ${r.nodes}`)
  }
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return { median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] }
}
const metrics: [string, (r: Result) => number][] = [
  ['cold mount ms', (r) => r.mountMs],
  ['warm mount ms', (r) => r.warmMountMs],
  ['re-render ms', (r) => r.rerenderMs],
  ['hover frame p90 ms', (r) => r.frames.p90Ms ?? Number.NaN],
  ['hover frame max ms', (r) => r.frames.maxMs ?? Number.NaN],
  ['rss MB', (r) => r.rssMb],
  ['GPUIX nodes', (r) => r.nodes]
]
console.log(`\n${runs} runs per mode, ${values.rows} rows`)
for (const [name, pick] of metrics) {
  const c = stat(results.compat.map(pick))
  const h = stat(results.hand.map(pick))
  console.log(
    `${name.padEnd(20)} compat ${c.median.toFixed(2)} (${c.min.toFixed(2)}..${c.max.toFixed(2)})  hand ${h.median.toFixed(2)} (${h.min.toFixed(2)}..${h.max.toFixed(2)})  ratio ${(c.median / h.median).toFixed(2)}`
  )
}
