/**
 * One measured window of N visible spinners and nothing else changing: what
 * the spinners alone cost the GPUIX UI thread, the JS thread and memory.
 *
 * - `source`: no frame store, so every step sends the frame's SVG markup.
 * - `frames`: `installCometFrames`, so every step sends a frame file's path.
 *
 * bun tools/perf/spinner/scene.tsx <mode> <spinners> <seconds> <frame-dir> <out.json>
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { render } from '@gpuix/react'
import { installCometFrames } from '../../../src/env/comet-frames'
import { Spinner } from '../../../src/ui/spinner'

const [mode, countArg, secondsArg, frameDir, out] = process.argv.slice(2)
if (mode !== 'source' && mode !== 'frames')
  throw new Error(`mode must be source or frames, got ${mode}`)
const count = Number(countArg)
const seconds = Number(secondsArg)
const WARMUP_MS = 4000

if (mode === 'frames') installCometFrames(frameDir)

/** CPU ticks per thread name, with numbered workers (llvmpipe-0, -1, ...) summed as `name-N`. */
function threadTicks(): Map<string, number> {
  const ticks = new Map<string, number>()
  for (const tid of readdirSync('/proc/self/task')) {
    const raw = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8')
    const name = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')).replace(/-\d+$/, '-N')
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    ticks.set(name, (ticks.get(name) ?? 0) + Number(fields[11]) + Number(fields[12]))
  }
  return ticks
}

function pssMB(): number {
  const line = readFileSync('/proc/self/smaps_rollup', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('Pss:'))
  return Number(line?.split(/\s+/)[1]) / 1024
}

function App() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#11111b',
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
        padding: 24
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <Spinner key={i} size={i % 2 === 0 ? 12 : 16} decorative />
      ))}
    </div>
  )
}

render(<App />, { title: 'spinners', width: 800, height: 600, focus: false })

setTimeout(() => {
  const t0 = performance.now()
  const before = threadTicks()
  setTimeout(() => {
    const wallS = (performance.now() - t0) / 1000
    const threads: Record<string, number> = {}
    for (const [name, ticks] of threadTicks()) {
      const pct = ((ticks - (before.get(name) ?? 0)) / 100 / wallS) * 100
      if (pct >= 1) threads[name] = Math.round(pct)
    }
    const processCpuPct = Object.values(threads).reduce((a, b) => a + b, 0)
    writeFileSync(
      out,
      JSON.stringify({
        mode,
        count,
        wallS,
        uiCpuPct: threads['gpuix-ui'] ?? 0,
        processCpuPct,
        pssMB: pssMB(),
        threads
      })
    )
    process.exit(0)
  }, seconds * 1000)
}, WARMUP_MS)
