/**
 * Frame cost of backdrop blur under Xvfb + lavapipe: runs `blur-cost-scene.tsx`
 * with each sigma, alternating, and reports wall-clock ms per frame (the
 * renderer drawing as fast as the scene changes) and the overlay's draw-time
 * stats. Needs the self-built addon in NAPI_RS_NATIVE_LIBRARY_PATH.
 *
 * bun tools/native/blur-cost.ts [--sigmas 0,8] [--runs 3] [--seconds 4] [--out DIR]
 */
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { LAVAPIPE_ICD, SCREEN_MARGIN, startXvfb } from '../parity/shoot-gpuix'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    sigmas: { type: 'string', default: '0,8' },
    runs: { type: 'string', default: '3' },
    seconds: { type: 'string', default: '4' },
    out: { type: 'string', default: '/tmp/gpuix-blur-cost' }
  }
})
const out = path.resolve(values.out as string)
mkdirSync(out, { recursive: true })
const sigmas = (values.sigmas as string).split(',').map(Number)
const runs = Number(values.runs)

const xvfb = await startXvfb(WINDOW_WIDTH + SCREEN_MARGIN, WINDOW_HEIGHT + SCREEN_MARGIN)
const results: Record<string, number[]> = {}
try {
  for (let run = 0; run < runs; run++) {
    for (const sigma of sigmas) {
      const file = path.join(out, `sigma-${sigma}-run-${run}.json`)
      const scene = Bun.spawn(
        [
          'bun',
          path.join(import.meta.dir, 'blur-cost-scene.tsx'),
          file,
          String(sigma),
          values.seconds as string
        ],
        {
          env: {
            ...process.env,
            DISPLAY: xvfb.display,
            VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
            GPUIX_BACKGROUND: '1'
          },
          stdout: 'ignore',
          stderr: 'ignore'
        }
      )
      if ((await scene.exited) !== 0)
        throw new Error(`scene sigma ${sigma} exited ${scene.exitCode}`)
      const result = JSON.parse(readFileSync(file, 'utf8'))
      results[sigma] = [...(results[sigma] ?? []), result.msPerFrame]
      console.log(
        `sigma ${sigma} run ${run}: ${result.frames} frames in ${Math.round(result.elapsedMs)} ms, ${result.msPerFrame.toFixed(1)} ms/frame, draw p90 ${result.stats.p90Ms?.toFixed(1)} ms`
      )
    }
  }
} finally {
  xvfb.stop()
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
for (const sigma of sigmas)
  console.log(
    `median sigma ${sigma}: ${median(results[sigma] ?? []).toFixed(1)} ms/frame over ${runs} runs`
  )
