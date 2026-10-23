/**
 * GPUIX side of the throughput bench: writes a file into a TerminalView in
 * fixed chunks, all queued at once like a PTY flood, and records when xterm
 * parsed the last chunk, how many frames GPUIX committed on the way, and when
 * the frame holding the final state was laid out (a marker mounted with that
 * commit gets bounds only after GPUI has laid out and painted the window).
 *
 * bun dist/terminal/throughput-gpuix.js <input.bin> <result.json> <cols> <rows> <cellWidth> <cellHeight> <chunkBytes>
 */
import { renameSync, writeFileSync } from 'node:fs'
import { type PublicInstance, render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { TerminalScreen } from '../../src/terminal/screen'
import { TerminalView } from '../../src/terminal/TerminalView'
import { terminalThemeFor } from '../../src/terminal/theme'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'

const [inputPath, resultFile, colsArg, rowsArg, cellWidthArg, cellHeightArg, chunkArg] =
  process.argv.slice(2)
if (!inputPath || !resultFile || !chunkArg) {
  throw new Error(
    'usage: throughput-gpuix.js <input.bin> <result.json> <cols> <rows> <cellWidth> <cellHeight> <chunkBytes>'
  )
}
const cols = Number(colsArg)
const rows = Number(rowsArg)
const cell = { width: Number(cellWidthArg), height: Number(cellHeightArg) }
const chunkBytes = Number(chunkArg)
const theme = terminalThemeFor('termul')
const screen = new TerminalScreen({ cols, rows, theme, frameMs: 16 })
const bytes = new Uint8Array(await Bun.file(inputPath).arrayBuffer())

interface Timing {
  start: number
  parsed: number
  finalRevision: number
  frames: number
}

function App() {
  const renderer = useGpuixRequired()
  const marker = useRef<PublicInstance | null>(null)
  const [measured, setMeasured] = useState(false)
  const [revision, setRevision] = useState(0)
  const [parsed, setParsed] = useState(false)
  const timing = useRef<Timing>({ start: 0, parsed: 0, finalRevision: 0, frames: 0 })
  useEffect(
    () =>
      screen.onFrame((frame) => {
        timing.current.frames++
        setRevision(frame.revision)
      }),
    []
  )
  useEffect(() => {
    if (!measured) return
    timing.current.start = performance.now()
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const end = Math.min(bytes.length, offset + chunkBytes)
      screen.write(
        bytes.subarray(offset, end),
        end === bytes.length
          ? () => {
              timing.current.parsed = performance.now()
              timing.current.finalRevision = screen.frame().revision
              setParsed(true)
            }
          : undefined
      )
    }
  }, [measured])
  const settled = parsed && revision >= timing.current.finalRevision
  useEffect(() => {
    if (!settled) return
    let cancelled = false
    const poll = () => {
      if (cancelled) return
      const bounds = marker.current ? renderer.getElementBounds?.(marker.current.id) : null
      if (!bounds) {
        setTimeout(poll, 1)
        return
      }
      const t = timing.current
      writeFileSync(
        `${resultFile}.tmp`,
        JSON.stringify({
          writeMs: t.parsed - t.start,
          paintMs: performance.now() - t.start,
          frames: t.frames,
          rows: screen.visibleText(),
          bufferLength: screen.frame().bufferLength
        })
      )
      renameSync(`${resultFile}.tmp`, resultFile)
    }
    setTimeout(poll, 0)
    return () => {
      cancelled = true
    }
  }, [settled, renderer])
  return (
    <div
      style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: theme.background }}
    >
      <div style={{ display: 'flex', width: cols * cell.width, height: rows * cell.height }}>
        <TerminalView
          screen={screen}
          onInput={() => {}}
          onMetrics={() => setMeasured(true)}
          cell={cell}
          focused
          cursorBlink={false}
          testId="bench-terminal"
        />
      </div>
      {settled && (
        <div ref={marker} style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1 }} />
      )}
    </div>
  )
}

render(<App />, {
  title: 'terminal throughput',
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
  focus: false
})
