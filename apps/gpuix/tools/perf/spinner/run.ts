/**
 * Spinner cost on GPUIX with and without the frame store, interleaved per run.
 * Each sample starts its own Xvfb and its own GPUIX process.
 *
 * bun tools/perf/spinner/run.ts [--runs 3] [--counts 1,10] [--seconds 15] [--out <file>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { LAVAPIPE_ICD, startXvfb } from '../../parity/shoot-gpuix.ts'
import { median } from '../stats.ts'

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    counts: { type: 'string', default: '1,10' },
    seconds: { type: 'string', default: '15' },
    out: { type: 'string', default: '/tmp/gpuix-f3/spinner/spinners.json' }
  }
})
const SCENE = path.join(import.meta.dir, 'scene.tsx')
const scratch = path.dirname(values.out)
const frameDir = path.join(scratch, 'frames')
mkdirSync(scratch, { recursive: true })

interface Sample {
  mode: string
  count: number
  uiCpuPct: number
  processCpuPct: number
  pssMB: number
  threads: Record<string, number>
}

async function once(mode: string, count: number, run: number): Promise<Sample> {
  const file = path.join(scratch, `${mode}-${count}-${run}.json`)
  const xvfb = await startXvfb(800, 600)
  try {
    const app = Bun.spawn(['bun', SCENE, mode, String(count), values.seconds, frameDir, file], {
      env: {
        ...process.env,
        DISPLAY: xvfb.display,
        VK_ICD_FILENAMES: LAVAPIPE_ICD,
        GPUIX_BACKGROUND: '1'
      },
      stdout: 'ignore',
      stderr: Bun.file(`${file}.log`)
    })
    const code = await app.exited
    if (code !== 0) throw new Error(`${mode} ${count} exited ${code}, see ${file}.log`)
    return JSON.parse(readFileSync(file, 'utf8')) as Sample
  } finally {
    xvfb.stop()
  }
}

const counts = values.counts.split(',').map(Number)
const samples: Sample[] = []
for (let run = 0; run < Number(values.runs); run++) {
  const order = counts.flatMap((n) => [
    ['source', n],
    ['frames', n]
  ]) as Array<[string, number]>
  if (run % 2 === 1) order.reverse()
  for (const [mode, count] of order) {
    const s = await once(mode, count, run)
    samples.push(s)
    console.log(
      `run ${run} ${mode.padEnd(6)} spinners=${count} gpuix-ui ${s.uiCpuPct.toFixed(1)}% process ${s.processCpuPct.toFixed(1)}% pss ${s.pssMB.toFixed(0)} MB ${JSON.stringify(s.threads)}`
    )
  }
}
writeFileSync(values.out, JSON.stringify({ args: values, samples }, null, 2))

const cell = (mode: string, count: number, key: keyof Sample) =>
  median(
    samples.filter((s) => s.mode === mode && s.count === count).map((s) => s[key] as number)
  ).toFixed(1)
console.log('\nmedians: spinners, mode, gpuix-ui % of a core, process % of a core, PSS MB')
for (const n of counts)
  for (const mode of ['source', 'frames'])
    console.log(
      `${n}\t${mode}\t${cell(mode, n, 'uiCpuPct')}\t${cell(mode, n, 'processCpuPct')}\t${cell(mode, n, 'pssMB')}`
    )
