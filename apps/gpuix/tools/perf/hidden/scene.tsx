/**
 * One measured window of GPUIX UI-thread cost: a ticker repaints at `hz`
 * while `panes` mounted panes of `rows` rows each sit hidden, the way
 * Termul keeps inactive chats and terminals mounted.
 *
 * - `none`: no hidden panes, the floor.
 * - `hidden`: `position: absolute` + `visibility: hidden`, what the compat
 *   layer emits for Tailwind's `absolute inset-0 invisible`.
 * - `parked`: the same panes, with each pane's content moved under a native
 *   node that is not reachable from the window root.
 * - `compat`: the same hidden panes, with the compat layer's
 *   `parkHiddenPanes` installed on the renderer.
 *
 * bun tools/perf/hidden/scene.tsx <mode> <panes> <rows> <seconds> <hz> <out.json>
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type PublicInstance, render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { parkHiddenPanes } from '../../../src/compat/park'

type Mode = 'none' | 'hidden' | 'parked' | 'compat'
const [mode, panesArg, rowsArg, secondsArg, hzArg, out] = process.argv.slice(2) as [Mode, string, string, string, string, string]
const panes = mode === 'none' ? 0 : Number(panesArg)
const rows = Number(rowsArg)
const seconds = Number(secondsArg)
const hz = Number(hzArg)
const WARMUP_MS = 3000
const PARK_ID = 2 ** 52

const FG = '#cdd6f4'
const MUTED = '#a6adc8'

function uiThreadTicks(): number {
  for (const tid of readdirSync('/proc/self/task')) {
    const raw = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8')
    if (raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')) !== 'gpuix-ui') continue
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return Number(fields[11]) + Number(fields[12])
  }
  throw new Error('no gpuix-ui thread')
}

function Row({ index }: { index: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 8, paddingTop: 2, paddingBottom: 2 }}>
      <text style={{ color: MUTED, fontSize: 12, width: 40 }}>{`${index}`}</text>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        <text style={{ color: FG, fontSize: 13 }}>{`Row ${index}: the agent streamed a line of prose here that wraps when the pane is narrow enough`}</text>
      </div>
    </div>
  )
}

let parkCreated = false
function Pane({ index }: { index: number }) {
  const renderer = useGpuixRequired()
  const content = useRef<PublicInstance | null>(null)
  useLayoutEffect(() => {
    if (mode !== 'parked' || !content.current) return
    const ops: unknown[][] = []
    if (!parkCreated) ops.push(['createElement', PARK_ID, 'div'])
    parkCreated = true
    ops.push(['appendChild', PARK_ID, content.current.id])
    renderer.applyBatch(JSON.stringify(ops))
  }, [renderer])
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, visibility: 'hidden' }}>
      <div ref={content} style={{ display: 'flex', flexDirection: 'column', padding: 16 }}>
        {Array.from({ length: rows }, (_, i) => (
          <Row key={i} index={index * rows + i} />
        ))}
      </div>
    </div>
  )
}

function App() {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(mode !== 'compat')
  useLayoutEffect(() => {
    if (mode !== 'compat') return
    const parking = parkHiddenPanes(renderer)
    setReady(true)
    return parking.uninstall
  }, [renderer])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000 / hz)
    return () => clearInterval(timer)
  }, [])
  return (
    <div style={{ width: '100%', height: '100%', backgroundColor: '#11111b', position: 'relative' }}>
      <div style={{ padding: 24 }}>
        <text style={{ color: FG, fontSize: 24 }}>{`tick ${tick}`}</text>
      </div>
      {ready && Array.from({ length: panes }, (_, i) => <Pane key={i} index={i} />)}
    </div>
  )
}

render(<App />, { title: 'hidden-panes', width: 1280, height: 800, focus: false })

setTimeout(() => {
  const t0 = performance.now()
  const ticks0 = uiThreadTicks()
  setTimeout(() => {
    const wallS = (performance.now() - t0) / 1000
    const uiS = (uiThreadTicks() - ticks0) / 100
    writeFileSync(out, JSON.stringify({ mode, panes, rows, hz, wallS, uiCpuPct: (uiS / wallS) * 100 }))
    process.exit(0)
  }, seconds * 1000)
}, WARMUP_MS)
