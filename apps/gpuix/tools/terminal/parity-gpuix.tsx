/**
 * GPUIX side of the parity check: replays the first `limit` bytes of a
 * recording into a TerminalView with the cell size xterm.js measured, then
 * writes the visible text, every cell and the grid bounds to the ready file.
 *
 * bun dist/terminal/parity-gpuix.js <bytes.bin> <limit> <ready.json> <cols> <rows> <cellWidth> <cellHeight>
 */
import { renameSync, writeFileSync } from 'node:fs'
import { type PublicInstance, render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { TerminalScreen } from '../../src/terminal/screen'
import { TerminalView } from '../../src/terminal/TerminalView'
import { terminalThemeFor } from '../../src/terminal/theme'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { cellRows } from './cells'

const [bytesPath, limitArg, readyFile, colsArg, rowsArg, cellWidthArg, cellHeightArg] =
  process.argv.slice(2)
if (!bytesPath || !readyFile || !cellHeightArg) {
  throw new Error(
    'usage: parity-gpuix.js <bytes.bin> <limit> <ready.json> <cols> <rows> <cellWidth> <cellHeight>'
  )
}
const cols = Number(colsArg)
const rows = Number(rowsArg)
const cell = { width: Number(cellWidthArg), height: Number(cellHeightArg) }
const theme = terminalThemeFor('termul')
const screen = new TerminalScreen({ cols, rows, theme, frameMs: 16 })
const bytes = new Uint8Array(await Bun.file(bytesPath).arrayBuffer()).subarray(0, Number(limitArg))

function App() {
  const renderer = useGpuixRequired()
  const host = useRef<PublicInstance | null>(null)
  const [measured, setMeasured] = useState(false)
  const [written, setWritten] = useState(false)
  useEffect(() => {
    if (measured) screen.write(bytes, () => setWritten(true))
  }, [measured])
  useEffect(() => {
    if (!written) return
    const timer = setTimeout(() => {
      const bounds = host.current ? renderer.getElementBounds?.(host.current.id) : null
      if (!bounds) throw new Error('parity grid has no bounds after paint')
      const frame = screen.frame()
      writeFileSync(
        `${readyFile}.tmp`,
        JSON.stringify({
          rows: screen.visibleText(),
          cells: cellRows(screen.terminal),
          cursor: { x: frame.cursor.x, y: frame.cursor.y },
          grid: { x: bounds.x, y: bounds.y, width: cols * cell.width, height: rows * cell.height },
          bufferLength: frame.bufferLength
        })
      )
      renameSync(`${readyFile}.tmp`, readyFile)
    }, 300)
    return () => clearTimeout(timer)
  }, [written, renderer])
  return (
    <div
      style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: theme.background }}
    >
      <div
        ref={host}
        style={{ display: 'flex', width: cols * cell.width, height: rows * cell.height }}
      >
        <TerminalView
          screen={screen}
          onInput={() => {}}
          onMetrics={() => setMeasured(true)}
          cell={cell}
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
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
  focus: false
})
