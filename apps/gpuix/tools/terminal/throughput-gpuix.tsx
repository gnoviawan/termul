/**
 * GPUIX side of the throughput bench: write a file into TerminalView in
 * fixed chunks and record when xterm parsed the last chunk and when GPUI
 * painted the frame after it (a marker mounted after the final commit gets
 * bounds only once painted). Writes a JSON result and exits.
 *
 * bun tools/terminal/throughput-gpuix.tsx <input.bin> <result.json> [cols rows cellWidth cellHeight chunkBytes]
 */
import { writeFileSync } from 'node:fs'
import { type PublicInstance, render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { TerminalScreen } from '../../src/terminal/screen'
import { TerminalView } from '../../src/terminal/TerminalView'
import { terminalThemeFor } from '../../src/terminal/theme'
import { SCREEN } from './xvfb'

const [inputPath, resultFile, colsArg, rowsArg, cellWidthArg, cellHeightArg, chunkArg] =
  process.argv.slice(2)
if (!inputPath || !resultFile)
  throw new Error(
    'usage: throughput-gpuix.tsx <input.bin> <result.json> [cols rows cellWidth cellHeight chunkBytes]'
  )
const cols = Number(colsArg ?? 80)
const rows = Number(rowsArg ?? 24)
const fixedCell =
  cellWidthArg && cellHeightArg
    ? { width: Number(cellWidthArg), height: Number(cellHeightArg) }
    : undefined
const chunkBytes = Number(chunkArg ?? 65536)
const theme = terminalThemeFor('termul')
const screen = new TerminalScreen({ cols, rows, theme, frameMs: 16 })
const bytes = new Uint8Array(await Bun.file(inputPath).arrayBuffer())

function App() {
  const renderer = useGpuixRequired()
  const marker = useRef<PublicInstance | null>(null)
  const [metrics, setMetrics] = useState<{ width: number; height: number } | null>(null)
  const [revision, setRevision] = useState(0)
  const timing = useRef<{ start: number; parsed: number; finalRevision: number } | null>(null)
  const [done, setDone] = useState(false)
  useEffect(() => screen.onFrame((frame) => setRevision(frame.revision)), [])
  useEffect(() => {
    if (!metrics) return
    const start = performance.now()
    timing.current = { start, parsed: 0, finalRevision: 0 }
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes))
      const last = offset + chunkBytes >= bytes.length
      screen.write(
        chunk,
        last
          ? () => {
              timing.current!.parsed = performance.now()
              timing.current!.finalRevision = screen.frame().revision
              setDone(true)
            }
          : undefined
      )
    }
  }, [metrics])
  const finalRevision = timing.current?.finalRevision ?? Number.POSITIVE_INFINITY
  useEffect(() => {
    if (!done || revision < finalRevision) return
    const committed = performance.now()
    let cancelled = false
    const poll = () => {
      if (cancelled) return
      const bounds = marker.current ? renderer.getElementBounds?.(marker.current.id) : null
      if (!bounds) {
        setTimeout(poll, 1)
        return
      }
      const painted = performance.now()
      const t = timing.current!
      writeFileSync(
        resultFile,
        JSON.stringify({
          bytes: bytes.length,
          chunkBytes,
          writeMs: t.parsed - t.start,
          commitMs: committed - t.start,
          paintMs: painted - t.start,
          rows: screen.visibleText(),
          bufferLength: screen.frame().bufferLength,
          revision
        })
      )
      setTimeout(() => process.exit(0), 50)
    }
    setTimeout(poll, 0)
    return () => {
      cancelled = true
    }
  }, [done, revision, finalRevision, renderer])
  return (
    <div
      style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: theme.background }}
    >
      <div
        style={{
          display: 'flex',
          width: cols * (fixedCell ?? metrics ?? { width: 8 }).width,
          height: rows * (fixedCell ?? metrics ?? { height: 19 }).height
        }}
      >
        <TerminalView
          screen={screen}
          onInput={() => {}}
          onMetrics={setMetrics}
          cell={fixedCell}
          focused
          cursorBlink={false}
          testId="bench-terminal"
        />
      </div>
      {done && revision >= finalRevision && (
        <div ref={marker} style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1 }} />
      )}
    </div>
  )
}

render(<App />, {
  title: 'terminal throughput',
  width: SCREEN.width,
  height: SCREEN.height,
  focus: false
})
