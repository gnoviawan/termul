/**
 * GPUIX UI-thread cost of mounted-but-hidden panes, against the same panes
 * parked off the window root. Each run starts its own Xvfb; modes and pane
 * counts are interleaved per run so drift lands on all of them alike.
 *
 * bun tools/perf/hidden/run.ts [--runs 3] [--panes 1,4,8] [--rows 150] [--seconds 8] [--hz 20] [--out <file>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { LAVAPIPE_ICD, startXvfb } from '../../parity/shoot-gpuix.ts'
import { median } from '../stats.ts'

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    panes: { type: 'string', default: '1,4,8' },
    rows: { type: 'string', default: '150' },
    seconds: { type: 'string', default: '8' },
    hz: { type: 'string', default: '20' },
    out: { type: 'string', default: '/tmp/gpuix-hidden/hidden-panes.json' }
  }
})
const SCENE = path.join(import.meta.dir, 'scene.tsx')
const scratch = path.dirname(values.out)
mkdirSync(scratch, { recursive: true })

interface Sample {
  mode: string
  panes: number
  uiCpuPct: number
}

async function once(mode: string, panes: number, run: number): Promise<Sample> {
  const file = path.join(scratch, `${mode}-${panes}-${run}.json`)
  const xvfb = await startXvfb(1280, 800)
  try {
    const app = Bun.spawn(['bun', SCENE, mode, String(panes), values.rows, values.seconds, values.hz, file], {
      env: { ...process.env, DISPLAY: xvfb.display, VK_ICD_FILENAMES: LAVAPIPE_ICD, GPUIX_BACKGROUND: '1' },
      stdout: 'ignore',
      stderr: Bun.file(`${file}.log`)
    })
    const code = await app.exited
    if (code !== 0) throw new Error(`${mode} ${panes} exited ${code}, see ${file}.log`)
    return JSON.parse(readFileSync(file, 'utf8')) as Sample
  } finally {
    xvfb.stop()
  }
}

const paneCounts = values.panes.split(',').map(Number)
const samples: Sample[] = []
for (let run = 0; run < Number(values.runs); run++) {
  const order = [['none', 0], ...paneCounts.flatMap((n) => [['hidden', n], ['parked', n]])] as Array<[string, number]>
  if (run % 2 === 1) order.reverse()
  for (const [mode, panes] of order) {
    const sample = await once(mode, panes, run)
    samples.push(sample)
    console.log(`run ${run} ${mode.padEnd(6)} panes=${panes} gpuix-ui ${sample.uiCpuPct.toFixed(1)}%`)
  }
}
writeFileSync(values.out, JSON.stringify({ args: values, samples }, null, 2))

console.log(`\nmedian gpuix-ui CPU, % of one core (${values.rows} rows per pane, ticker at ${values.hz} Hz)`)
const cell = (mode: string, panes: number) =>
  median(samples.filter((s) => s.mode === mode && s.panes === panes).map((s) => s.uiCpuPct)).toFixed(1)
console.log(`no panes: ${cell('none', 0)}`)
for (const n of paneCounts) console.log(`${n} panes: hidden ${cell('hidden', n)}, parked ${cell('parked', n)}`)
