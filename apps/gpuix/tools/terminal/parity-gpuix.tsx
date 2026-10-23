/**
 * GPUIX side of the parity check: paint a recorded byte stream with
 * TerminalView at a fixed grid, then write the visible text, the cursor and
 * the painted grid box to READY_FILE so the driver can crop the X capture.
 *
 * bun tools/terminal/parity-gpuix.tsx <bytes.bin> <ready.json> <cols> <rows> [cellWidth cellHeight]
 */
import { writeFileSync } from 'node:fs'
import { type PublicInstance, render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { TerminalScreen } from '../../src/terminal/screen'
import { TerminalView } from '../../src/terminal/TerminalView'
import { terminalThemeFor } from '../../src/terminal/theme'
import { SCREEN } from './xvfb'

const [bytesPath, readyFile, colsArg, rowsArg, cellWidthArg, cellHeightArg] = process.argv.slice(2)
if (!bytesPath || !readyFile)
  throw new Error(
    'usage: parity-gpuix.tsx <bytes.bin> <ready.json> [cols rows cellWidth cellHeight]'
  )
const cols = Number(colsArg ?? 80)
const rows = Number(rowsArg ?? 24)
const fixedCell =
  cellWidthArg && cellHeightArg
    ? { width: Number(cellWidthArg), height: Number(cellHeightArg) }
    : undefined
const theme = terminalThemeFor('termul')
const screen = new TerminalScreen({ cols, rows, theme, frameMs: 16 })
const bytes = new Uint8Array(await Bun.file(bytesPath).arrayBuffer())

function App() {
  const renderer = useGpuixRequired()
  const host = useRef<PublicInstance | null>(null)
  const [metrics, setMetrics] = useState<{ width: number; height: number } | null>(null)
  const [written, setWritten] = useState(false)
  useEffect(() => {
    if (!metrics) return
    screen.write(bytes, () => setWritten(true))
  }, [metrics])
  useEffect(() => {
    if (!written || !metrics) return
    const timer = setTimeout(() => {
      const bounds = host.current ? renderer.getElementBounds?.(host.current.id) : null
      writeFileSync(
        readyFile,
        JSON.stringify({
          rows: screen.visibleText(),
          cursor: { x: screen.frame().cursor.x, y: screen.frame().cursor.y },
          cell: metrics,
          grid: bounds
            ? {
                x: bounds.x,
                y: bounds.y,
                width: cols * metrics.width,
                height: rows * metrics.height
              }
            : null,
          bufferLength: screen.frame().bufferLength,
          revision: screen.frame().revision
        })
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [written, metrics, renderer])
  return (
    <div
      style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: theme.background }}
    >
      <div
        ref={host}
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
          testId="parity-terminal"
        />
      </div>
    </div>
  )
}

render(<App />, {
  title: 'terminal parity',
  width: SCREEN.width,
  height: SCREEN.height,
  focus: false
})
