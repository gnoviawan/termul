/**
 * Paints a `TerminalScreen` with GPUIX elements: one `<div>` per visible row,
 * one `<text>` per styled run, selection and cursor as absolute overlays.
 * Owns input: keys to bytes, wheel to scrollback, drag to selection, layout
 * to a resize. The screen model decides what is visible; this file only
 * paints the frame it is given.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { type EventPayload, type PublicInstance, useGpuix } from '@gpuix/react'
import { copyText, pasteText } from './clipboard'
import {
  type CellMetrics,
  cellMetrics,
  registerTerminalFonts,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_WEIGHT_BOLD,
  TERMINAL_LINE_HEIGHT
} from './fonts'
import { encodeKey, encodePaste } from './keys'
import { terminalLog } from './log'
import type { CellPoint, ScreenFrame, ScreenRow, TerminalScreen } from './screen'

export type CursorStyle = 'block' | 'bar' | 'underline'

export interface TerminalViewProps {
  screen: TerminalScreen
  /** Bytes the user typed or pasted, already encoded for the PTY. */
  onInput: (data: string) => void
  /** Called after the screen model has been resized to fit the element. */
  onResize?: (cols: number, rows: number) => void
  /** Reports the measured cell size and the painted grid origin once known. */
  onMetrics?: (metrics: CellMetrics) => void
  cursorStyle?: CursorStyle
  cursorBlink?: boolean
  focused?: boolean
  autoFocus?: boolean
  testId?: string
  fontSize?: number
  lineHeight?: number
  /**
   * Fixed cell geometry, for example the one xterm.js measured in Chromium.
   * Without it the cell is derived from the font the way xterm.js does it:
   * `floor(advance)` wide and `floor(charHeight * lineHeight)` tall.
   */
  cell?: CellMetrics
  /** Pixels between the element edge and the grid, like `.xterm` padding. */
  padding?: number
}

/**
 * xterm.js packs its glyphs into the floored cell with a negative
 * `letter-spacing`. GPUIX has none, so the glyph is scaled until its advance
 * is the cell width instead; the ink shrinks by the same few percent the
 * spacing would have removed.
 */
export interface Geometry {
  cell: CellMetrics
  glyphSize: number
}

export function geometryFor(probe: { width: number; height: number; chars: number }, fontSize: number, lineHeight: number, fixed?: CellMetrics): Geometry {
  const advance = probe.width / probe.chars
  const measured = cellMetrics(probe, lineHeight)
  const cell = fixed ?? { width: Math.floor(measured.width), height: measured.height }
  return { cell, glyphSize: fontSize * (cell.width / advance) }
}

const PROBE_CHARS = 100
const RESIZE_DEBOUNCE_MS = 50
const BLINK_MS = 600

interface RowProps {
  row: ScreenRow
  cell: CellMetrics
  fontSize: number
  selection: [number, number] | null
  selectionColor: string
  cursor: { x: number; char: string; style: CursorStyle | 'outline'; color: string; accent: string } | null
}

const RowView = memo(function RowView({ row, cell, fontSize, selection, selectionColor, cursor }: RowProps) {
  let x = 0
  return (
    <div style={{ display: 'flex', position: 'relative', height: cell.height, minHeight: cell.height, flexShrink: 0 }}>
      {selection && (
        <div
          style={{
            position: 'absolute',
            left: selection[0] * cell.width,
            top: 0,
            width: (selection[1] - selection[0]) * cell.width,
            height: cell.height,
            backgroundColor: selectionColor,
            pointerEvents: 'none'
          }}
        />
      )}
      {row.runs.map((run, i) => {
        const left = x * cell.width
        x += run.cols
        return (
          <div key={i} style={{ position: 'absolute', left, top: 0, width: run.cols * cell.width, height: cell.height, ...(run.bg ? { backgroundColor: run.bg } : {}), pointerEvents: 'none' }}>
            <text
              style={{
                width: run.cols * cell.width,
                height: cell.height,
                lineHeight: cell.height,
                fontFamily: TERMINAL_FONT_FAMILY,
                fontSize,
                fontWeight: run.bold ? TERMINAL_FONT_WEIGHT_BOLD : 400,
                color: run.fg,
                ...(run.underline ? { textDecoration: 'underline' } : run.strike ? { textDecoration: 'line-through' } : {}),
                whiteSpace: 'nowrap',
                userSelect: 'none'
              }}
            >
              {run.text}
            </text>
          </div>
        )
      })}
      {cursor && cursor.style === 'block' && (
        <div
          style={{
            position: 'absolute',
            left: cursor.x * cell.width,
            top: 0,
            width: cell.width,
            height: cell.height,
            backgroundColor: cursor.color,
            pointerEvents: 'none'
          }}
        >
          <text
            style={{
              width: cell.width,
              lineHeight: cell.height,
              fontFamily: TERMINAL_FONT_FAMILY,
              fontSize,
              color: cursor.accent,
              whiteSpace: 'nowrap',
              userSelect: 'none'
            }}
          >
            {cursor.char}
          </text>
        </div>
      )}
      {cursor && cursor.style === 'outline' && (
        <div
          style={{
            position: 'absolute',
            left: cursor.x * cell.width,
            top: 0,
            width: cell.width,
            height: cell.height,
            borderWidth: 1,
            borderColor: cursor.color,
            pointerEvents: 'none'
          }}
        />
      )}
      {cursor && cursor.style === 'bar' && (
        <div
          style={{ position: 'absolute', left: cursor.x * cell.width, top: 0, width: 1, height: cell.height, backgroundColor: cursor.color, pointerEvents: 'none' }}
        />
      )}
      {cursor && cursor.style === 'underline' && (
        <div
          style={{ position: 'absolute', left: cursor.x * cell.width, top: cell.height - 1, width: cell.width, height: 1, backgroundColor: cursor.color, pointerEvents: 'none' }}
        />
      )}
    </div>
  )
})

export function TerminalView(props: TerminalViewProps) {
  const {
    screen,
    onInput,
    onResize,
    onMetrics,
    cursorStyle = 'block',
    cursorBlink = false,
    focused = true,
    autoFocus = true,
    testId = 'terminal',
    fontSize = TERMINAL_FONT_SIZE,
    lineHeight = TERMINAL_LINE_HEIGHT,
    cell: fixedCell,
    padding = 0
  } = props
  const { renderer } = useGpuix()
  const host = useRef<PublicInstance | null>(null)
  const [frame, setFrame] = useState<ScreenFrame>(() => screen.frame())
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const cell = geometry?.cell ?? null
  const glyphSize = geometry?.glyphSize ?? fontSize
  const [blinkOn, setBlinkOn] = useState(true)
  const hostSize = useRef<{ width: number; height: number } | null>(null)
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wheelRemainder = useRef(0)
  const dragging = useRef(false)
  const palette = screen.palette

  useEffect(() => {
    if (renderer) registerTerminalFonts(renderer)
  }, [renderer])

  useEffect(() => screen.onFrame(setFrame), [screen])

  useEffect(() => {
    setBlinkOn(true)
    if (!cursorBlink || !focused) return
    const timer = setInterval(() => setBlinkOn((on) => !on), BLINK_MS)
    return () => clearInterval(timer)
  }, [cursorBlink, focused])

  const fit = useCallback(() => {
    const size = hostSize.current
    if (!size || !cell) return
    const cols = Math.max(2, Math.floor((size.width - padding * 2) / cell.width))
    const rows = Math.max(1, Math.floor((size.height - padding * 2) / cell.height))
    if (cols === screen.cols && rows === screen.rows) return
    screen.resize(cols, rows)
    onResize?.(cols, rows)
    terminalLog('info', 'terminal.resize', { cols, rows })
  }, [cell, padding, screen, onResize])

  useEffect(() => {
    fit()
  }, [fit])

  const onLayout = (event: EventPayload) => {
    hostSize.current = { width: event.width ?? 0, height: event.height ?? 0 }
    if (resizeTimer.current) clearTimeout(resizeTimer.current)
    resizeTimer.current = setTimeout(fit, RESIZE_DEBOUNCE_MS)
  }

  const cellAt = (event: EventPayload): CellPoint | null => {
    const bounds = host.current && renderer?.getElementBounds?.(host.current.id)
    if (!bounds || !cell || event.x === undefined || event.y === undefined) return null
    const col = Math.max(0, Math.min(screen.cols, Math.round((event.x - bounds.x - padding) / cell.width)))
    const y = Math.max(0, Math.min(screen.rows - 1, Math.floor((event.y - bounds.y - padding) / cell.height)))
    return { row: screen.rowAt(y), col }
  }

  const send = (data: string) => {
    screen.scrollToBottom()
    onInput(data)
  }

  const onKeyDown = (event: EventPayload) => {
    const action = encodeKey(event, screen.modes.applicationCursorKeysMode)
    if (action.type === 'none') return
    event.preventDefault()
    if (action.type === 'send') {
      screen.setSelection(null)
      send(action.data)
    } else if (action.type === 'page') {
      screen.scrollLines(action.direction * screen.rows)
    } else if (action.type === 'copy') {
      const text = screen.selectedText()
      if (text) void copyText(text)
    } else if (action.type === 'paste') {
      void pasteText().then((text) => {
        if (text) send(encodePaste(text, screen.modes.bracketedPasteMode))
      })
    }
  }

  const onScroll = (event: EventPayload) => {
    if (!cell || screen.terminal.buffer.active.type === 'alternate') return
    const pixels = event.precise ? (event.deltaY ?? 0) : (event.deltaY ?? 0) * cell.height
    wheelRemainder.current += -pixels / cell.height
    const lines = Math.trunc(wheelRemainder.current)
    if (!lines) return
    wheelRemainder.current -= lines
    screen.scrollLines(lines)
  }

  const onMouseDown = (event: EventPayload) => {
    if (host.current) renderer?.focusElement?.(host.current.id)
    if (event.button !== 0) return
    const point = cellAt(event)
    if (!point) return
    if ((event.clickCount ?? 1) >= 2) {
      screen.setSelection(screen.wordAt(point))
      dragging.current = false
      return
    }
    dragging.current = true
    screen.setSelection(event.modifiers?.shift && screen.getSelection() ? { ...screen.getSelection()!, head: point } : { anchor: point, head: point })
  }
  const onMouseMove = (event: EventPayload) => {
    if (!dragging.current || event.pressedButton !== 0) return
    const point = cellAt(event)
    const selection = screen.getSelection()
    if (point && selection) screen.setSelection({ anchor: selection.anchor, head: point })
  }
  const onMouseUp = () => {
    dragging.current = false
    const selection = screen.getSelection()
    if (selection && selection.anchor.row === selection.head.row && selection.anchor.col === selection.head.col) {
      screen.setSelection(null)
    }
  }

  const cursorShape: CursorStyle | 'outline' = focused ? cursorStyle : 'outline'
  const showCursor = frame.cursor.visible && (!cursorBlink || !focused || blinkOn)

  return (
    <div
      ref={host}
      testId={testId}
      tabIndex={0}
      autoFocus={autoFocus}
      onLayout={onLayout}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
        padding,
        overflow: 'hidden',
        backgroundColor: palette.background,
        cursor: 'text'
      }}
    >
      {!cell && (
        <div style={{ display: 'flex', position: 'absolute', left: 0, top: 0, opacity: 0 }}>
          <text
            onLayout={(event) => {
              const next = geometryFor({ width: event.width ?? 0, height: event.height ?? 0, chars: PROBE_CHARS }, fontSize, lineHeight, fixedCell)
              terminalLog('info', 'terminal.geometry', {
                advance: (event.width ?? 0) / PROBE_CHARS,
                charHeight: event.height ?? 0,
                cellWidth: next.cell.width,
                cellHeight: next.cell.height,
                glyphSize: next.glyphSize
              })
              setGeometry(next)
              onMetrics?.(next.cell)
            }}
            style={{ fontFamily: TERMINAL_FONT_FAMILY, fontSize, lineHeight: fontSize * 1.2, color: palette.background, whiteSpace: 'nowrap' }}
          >
            {'M'.repeat(PROBE_CHARS)}
          </text>
        </div>
      )}
      {cell &&
        frame.rows_.map((row, y) => (
          <RowView
            key={y}
            row={row}
            cell={cell}
            fontSize={glyphSize}
            selection={frame.selection[y] ?? null}
            selectionColor={palette.selection}
            cursor={
              showCursor && frame.cursor.y === y
                ? { x: frame.cursor.x, char: frame.cursor.char, style: cursorShape, color: palette.cursor, accent: palette.cursorAccent }
                : null
            }
          />
        ))}
    </div>
  )
}
