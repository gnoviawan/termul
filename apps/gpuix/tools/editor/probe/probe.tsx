/**
 * Design probe for the GPUIX code editor. Two shapes over the same 5,000-line
 * TypeScript file, in one window:
 *
 * - `textarea`: the stock `<textarea>` holds the whole document at full
 *   height inside one scroller (the editing surface a highlighted underlay
 *   would sit under).
 * - `rows`: a JS-owned viewport paints only the visible lines, each a row of
 *   Lezer-highlighted `<text>` runs, with keys taken by a focusable box.
 *
 * Each mode reports mount-to-first-layout, frame times over a wheel scroll,
 * keystroke-to-commit latency, and which key events reach JS. Results go to
 * `$PROBE_OUT` as JSON, then the process exits.
 */
import { writeFileSync } from 'node:fs'
import { javascript } from '@codemirror/lang-javascript'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import {
  type EventPayload,
  type KeyEvent,
  type NativeRenderer,
  type PublicInstance,
  render,
  useGpuixRequired
} from '@gpuix/react'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const MODE = process.env.PROBE_MODE ?? 'rows'
const OUT = process.env.PROBE_OUT ?? '/tmp/gpuix-e1/probe.json'
const LINES = Number(process.env.PROBE_LINES ?? 5000)
const PLAIN = process.env.PROBE_PLAIN === '1'
const LH = 20.8
const VIEW = { width: 1000, height: 700 }
const COLORS: Record<string, string> = {
  'tok-keyword': '#95d0cd',
  'tok-string': '#d898d8',
  'tok-number': '#e6b387',
  'tok-comment': '#7f848e',
  'tok-variableName': '#94c2fa',
  'tok-typeName': '#e6b387',
  'tok-propertyName': '#94c2fa',
  'tok-punctuation': '#9da5b4',
  'tok-operator': '#9da5b4'
}

const source = Array.from(
  { length: LINES },
  (_, i) => `export function f${i}(a: number, b: string): string { return \`\${a} \${b}\` /* c */ }`
).join('\n')

const report: Record<string, unknown> = { mode: MODE, lines: LINES, plain: PLAIN }
const renderMs: number[] = []
const t0 = performance.now()

interface Stats {
  frames: number
  p90Ms?: number
  p99Ms?: number
  maxMs?: number
}

/** The live renderer's test methods, present on the desktop napi build. */
type Live = NativeRenderer & {
  setDebugFrameOverlay(mode: string): string
  resetDebugFrameOverlayStats(): void
  getDebugFrameOverlayStats(): Stats
  simulateScrollWheel(x: number, y: number, dx: number, dy: number): void
  simulateKeystrokes(keys: string): void
  simulateKeyDown(key: string): void
  simulateKeyUp(key: string): void
  focusElement(id: number): void
}

async function frames(renderer: Live, run: () => Promise<void>): Promise<Stats> {
  renderer.resetDebugFrameOverlayStats()
  await run()
  await Bun.sleep(100)
  return renderer.getDebugFrameOverlayStats()
}

async function wheel(renderer: Live, x: number, y: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    renderer.simulateScrollWheel(x, y, 0, -60)
    await Bun.sleep(16)
  }
}

function TextareaProbe() {
  const renderer = useGpuixRequired() as Live
  const [value, setValue] = useState(source)
  const changes = useRef<number[]>([])
  const ups = useRef<string[]>([])
  const id = useRef<number | null>(null)
  useEffect(() => {
    void (async () => {
      await Bun.sleep(1500)
      renderer.setDebugFrameOverlay('minimal')
      report.scroll = await frames(renderer, () => wheel(renderer, 400, 300))
      renderer.focusElement(id.current!)
      const typed: number[] = []
      report.typing = await frames(renderer, async () => {
        for (let i = 0; i < 20; i++) {
          const at = performance.now()
          const before = changes.current.length
          renderer.simulateKeystrokes('x')
          while (changes.current.length === before && performance.now() - at < 2000)
            await Bun.sleep(1)
          typed.push(performance.now() - at)
          await Bun.sleep(30)
        }
      })
      report.keystrokeToChangeMs = typed
      for (const key of ['down', 'left', 'backspace', 'pagedown', 'ctrl-z']) {
        renderer.simulateKeyDown(key)
        renderer.simulateKeyUp(key)
        await Bun.sleep(80)
      }
      report.keyUpSeen = ups.current
      writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(0)
    })()
  }, [renderer])
  return (
    <div
      testId="scroller"
      style={{ ...VIEW, overflow: 'scroll', backgroundColor: '#111' }}
      onLayout={() => {
        report.firstLayoutMs ??= performance.now() - t0
      }}
    >
      <textarea
        ref={(i: PublicInstance | null) => {
          id.current = i?.id ?? null
        }}
        value={value}
        minRows={LINES}
        maxRows={LINES}
        style={{ width: 2400, fontSize: 13, lineHeight: LH, color: '#ddd' }}
        onChange={(e: EventPayload) => {
          changes.current.push(performance.now())
          setValue(e.value ?? '')
        }}
        onKeyUp={(e: KeyEvent) => ups.current.push(e.key ?? '')}
      />
    </div>
  )
}

interface Run {
  text: string
  color: string
}

function lineRuns(state: EditorState, line: number): Run[] {
  const { from, to, text } = state.doc.line(line)
  const tree = ensureSyntaxTree(state, to, 1000)
  const runs: Run[] = []
  let at = from
  if (tree) {
    highlightTree(
      tree,
      classHighlighter,
      (f, t, cls) => {
        if (f > at) runs.push({ text: state.sliceDoc(at, f), color: '#ddd' })
        runs.push({ text: state.sliceDoc(f, t), color: COLORS[cls.split(' ')[0]!] ?? '#ddd' })
        at = t
      },
      from,
      to
    )
  }
  if (at < to) runs.push({ text: state.sliceDoc(at, to), color: '#ddd' })
  const merged: Run[] = []
  for (const run of runs) {
    const prev = merged[merged.length - 1]
    if (prev && (prev.color === run.color || run.text.trim() === '')) prev.text += run.text
    else merged.push({ ...run })
  }
  report.runsPerLine = merged.length
  return merged.length ? merged : [{ text, color: '#ddd' }]
}

function RowsProbe() {
  const renderer = useGpuixRequired() as Live
  const [state, setState] = useState(() =>
    EditorState.create({ doc: source, extensions: [javascript({ typescript: true })] })
  )
  const [top, setTop] = useState(0)
  const commits = useRef(0)
  const downs = useRef<string[]>([])
  const box = useRef<number | null>(null)
  commits.current++
  const renderStart = performance.now()
  useLayoutEffect(() => {
    renderMs.push(performance.now() - renderStart)
  })
  useEffect(() => {
    void (async () => {
      await Bun.sleep(1500)
      renderer.setDebugFrameOverlay('minimal')
      report.scroll = await frames(renderer, () => wheel(renderer, 400, 300))
      renderer.focusElement(box.current!)
      const typed: number[] = []
      report.typing = await frames(renderer, async () => {
        for (let i = 0; i < 20; i++) {
          const at = performance.now()
          const before = commits.current
          renderer.simulateKeystrokes('x')
          while (commits.current === before && performance.now() - at < 2000) await Bun.sleep(1)
          typed.push(performance.now() - at)
          await Bun.sleep(30)
        }
      })
      report.keystrokeToCommitMs = typed
      for (const key of ['down', 'left', 'backspace', 'pagedown', 'ctrl-z', 'enter', 'tab']) {
        renderer.simulateKeystrokes(key)
        await Bun.sleep(80)
      }
      report.keyDownSeen = downs.current
      report.rowsRenderToCommitMs = renderMs.slice(-40)
      writeFileSync(OUT, JSON.stringify(report, null, 2))
      process.exit(0)
    })()
  }, [renderer])
  const first = Math.max(1, Math.floor(top / LH) + 1)
  const last = Math.min(state.doc.lines, first + Math.ceil(VIEW.height / LH) + 1)
  const rows = []
  if (MODE === 'code') {
    const from = state.doc.line(first).from
    const to = state.doc.line(last).to
    const numbers = []
    for (let n = first; n <= last; n++) numbers.push(String(n).padStart(5))
    rows.push(
      <div
        key="window"
        style={{
          position: 'absolute',
          top: (first - 1) * LH - top,
          left: 0,
          display: 'flex',
          flexDirection: 'row'
        }}
      >
        <code
          code={numbers.join('\n')}
          style={{ width: 48, fontSize: 13, lineHeight: LH, color: '#666' }}
        />
        <code
          code={state.sliceDoc(from, to)}
          language="typescript"
          style={{ width: 900, fontSize: 13, lineHeight: LH }}
        />
      </div>
    )
  }
  for (let n = first; n <= last && MODE !== 'code'; n++) {
    rows.push(
      <div
        key={n}
        style={{
          position: 'absolute',
          top: (n - 1) * LH - top,
          left: 0,
          height: LH,
          display: 'flex',
          flexDirection: 'row'
        }}
      >
        <text style={{ width: 48, color: '#666', fontSize: 13, lineHeight: LH }}>{String(n)}</text>
        {(PLAIN ? [{ text: state.doc.line(n).text, color: '#ddd' }] : lineRuns(state, n)).map(
          (run, i) => (
            <text
              key={i}
              style={{ color: run.color, fontSize: 13, lineHeight: LH, whiteSpace: 'nowrap' }}
            >
              {run.text}
            </text>
          )
        )}
      </div>
    )
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: probe key sink
    <div
      ref={(i: PublicInstance | null) => {
        box.current = i?.id ?? null
      }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the probe's key sink must take focus
      tabIndex={0}
      testId="scroller"
      style={{ ...VIEW, overflow: 'hidden', position: 'relative', backgroundColor: '#111' }}
      onLayout={() => {
        report.firstLayoutMs ??= performance.now() - t0
      }}
      onScroll={(e: EventPayload) =>
        setTop((t) =>
          Math.max(0, Math.min(state.doc.lines * LH - VIEW.height, t - (e.deltaY ?? 0)))
        )
      }
      onKeyDown={(e: KeyEvent) => {
        downs.current.push(e.key ?? '')
        if (e.keyChar && e.keyChar.length === 1) {
          const pos = state.doc.line(first + 2).from + 4
          setState((s) => s.update({ changes: { from: pos, insert: e.keyChar! } }).state)
        }
      }}
    >
      {rows}
    </div>
  )
}

render(MODE === 'textarea' ? <TextareaProbe /> : <RowsProbe />, {
  title: `editor-probe ${MODE}`,
  width: VIEW.width,
  height: VIEW.height,
  focus: false
})
