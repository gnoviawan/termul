/**
 * Paints a `TerminalScreen` with GPUIX elements: one `<div>` per visible row,
 * one `<text>` per styled run, selection and cursor as absolute overlays.
 * Owns input: keys to bytes, wheel to scrollback, drag to selection, layout
 * to a resize. The screen model decides what is visible; this file only
 * paints the frame it is given.
 */

import { type EventPayload, type KeyEvent, type PublicInstance, useGpuix } from '@gpuix/react'
import { memo, type Ref, useCallback, useEffect, useRef, useState } from 'react'
import { log } from '../log'
import { copyText, pasteText } from './clipboard'
import {
  type CellMetrics,
  cellMetrics,
  registerTerminalFonts,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_WEIGHT_BOLD,
  TERMINAL_LINE_HEIGHT,
  terminalCharHeight
} from './fonts'
import { encodeKey, encodePaste } from './keys'
import { encodeMouse, type MouseAction, type MouseButton, type MouseTracking } from './mouse'
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
  /** Overrides the element's own focus state for the cursor shape (fixtures pin it). */
  focused?: boolean
  /**
   * False while the pane is hidden: no fit and no repaint. Showing it again
   * paints the screen's current frame at once, with no replay.
   */
  visible?: boolean
  hostRef?: Ref<PublicInstance>
  onAuxClick?: (event: EventPayload) => void
  /** Runs before the keymap. Return true when the caller took the key. */
  onKeyIntercept?: (event: KeyEvent) => boolean
  /** Copy and paste actions; the defaults use `clipboard.ts` directly. */
  onCopy?: (text: string) => void
  onPaste?: () => void
  /** A Ctrl/Cmd click on a cell. Return true when a link there was opened. */
  onLinkClick?: (point: CellPoint, event: EventPayload) => boolean
  autoFocus?: boolean
  testId?: string
  fontSize?: number
  lineHeight?: number
  /**
   * Fixed cell geometry, for example the one xterm.js measured in Chromium.
   * Without it the cell is derived from the font the way xterm.js does it:
   * `floor(advance)` wide and `floor(ceil(charHeight) * lineHeight)` tall.
   */
  cell?: CellMetrics
  /** Pixels between the element edge and the grid, like `.xterm` padding. */
  padding?: number
  /**
   * Width kept free at the right edge, as xterm's FitAddon keeps it for the
   * scrollbar (`DEFAULT_SCROLL_BAR_WIDTH`), so both clients fit the same grid.
   */
  scrollbarWidth?: number
}

const XTERM_SCROLL_BAR_WIDTH = 14

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

interface MeasuredGeometry extends Geometry {
  fontSize: number
  lineHeight: number
}

export function geometryFor(
  probe: { width: number; chars: number },
  fontSize: number,
  lineHeight: number,
  fixed?: CellMetrics
): Geometry {
  const advance = probe.width / probe.chars
  const cell = fixed ?? cellMetrics(advance, terminalCharHeight(fontSize), lineHeight)
  return { cell, glyphSize: fontSize * (cell.width / advance) }
}

const PROBE_CHARS = 100
const RESIZE_DEBOUNCE_MS = 50
const BLINK_MS = 600
const MOUSE_BUTTONS: Record<number, MouseButton> = { 0: 'left', 1: 'middle', 2: 'right' }

interface RowProps {
  row: ScreenRow
  cell: CellMetrics
  fontSize: number
  selection: [number, number] | null
  selectionColor: string
  cursor: {
    x: number
    char: string
    style: CursorStyle | 'outline'
    color: string
    accent: string
  } | null
}

const RowView = memo(function RowView({
  row,
  cell,
  fontSize,
  selection,
  selectionColor,
  cursor
}: RowProps) {
  let x = 0
  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        height: cell.height,
        minHeight: cell.height,
        flexShrink: 0
      }}
    >
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
          <div
            key={i}
            style={{
              position: 'absolute',
              left,
              top: 0,
              width: run.cols * cell.width,
              height: cell.height,
              ...(run.bg ? { backgroundColor: run.bg } : {}),
              pointerEvents: 'none'
            }}
          >
            <text
              style={{
                width: run.cols * cell.width,
                height: cell.height,
                lineHeight: cell.height,
                fontFamily: TERMINAL_FONT_FAMILY,
                fontSize,
                fontWeight: run.bold ? TERMINAL_FONT_WEIGHT_BOLD : 400,
                ...(run.italic ? { fontStyle: 'italic' } : {}),
                color: run.fg,
                ...(run.underline
                  ? { textDecoration: 'underline' }
                  : run.strike
                    ? { textDecoration: 'line-through' }
                    : {}),
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
          style={{
            position: 'absolute',
            left: cursor.x * cell.width,
            top: 0,
            width: 1,
            height: cell.height,
            backgroundColor: cursor.color,
            pointerEvents: 'none'
          }}
        />
      )}
      {cursor && cursor.style === 'underline' && (
        <div
          style={{
            position: 'absolute',
            left: cursor.x * cell.width,
            top: cell.height - 1,
            width: cell.width,
            height: 1,
            backgroundColor: cursor.color,
            pointerEvents: 'none'
          }}
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
    focused: focusedProp,
    visible = true,
    autoFocus = true,
    testId = 'terminal',
    fontSize = TERMINAL_FONT_SIZE,
    lineHeight = TERMINAL_LINE_HEIGHT,
    cell: fixedCell,
    padding = 0,
    scrollbarWidth = XTERM_SCROLL_BAR_WIDTH,
    hostRef,
    onAuxClick,
    onKeyIntercept,
    onCopy,
    onPaste,
    onLinkClick
  } = props
  const { renderer } = useGpuix()
  const host = useRef<PublicInstance | null>(null)
  const [frame, setFrame] = useState<ScreenFrame>(() => screen.frame())
  const [measured, setMeasured] = useState<MeasuredGeometry | null>(null)
  // A font size or line height change measures again.
  const geometry =
    measured && measured.fontSize === fontSize && measured.lineHeight === lineHeight
      ? measured
      : null
  const cell = geometry?.cell ?? null
  if (cell) screen.cellSize = cell
  const glyphSize = geometry?.glyphSize ?? fontSize
  const [hasFocus, setHasFocus] = useState(false)
  const focused = focusedProp ?? hasFocus
  const [blinkOn, setBlinkOn] = useState(true)
  const hostSize = useRef<{ width: number; height: number } | null>(null)
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wheelRemainder = useRef(0)
  const dragging = useRef(false)
  /** The button held since the last press; simulated moves may not report one. */
  const pressed = useRef<MouseButton | null>(null)
  const lastMoveCell = useRef<string | null>(null)
  const lastClipboardOp = useRef(0)
  const palette = screen.palette

  // GPUI caches a family's resolution at first use, so nothing names Paper
  // Mono until registerFont has returned (it blocks for a few hundred ms).
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => {
    if (!renderer || fontsReady) return
    registerTerminalFonts(renderer)
    setFontsReady(true)
  }, [renderer, fontsReady])

  useEffect(() => {
    if (!visible) return
    setFrame(screen.frame())
    return screen.onFrame(setFrame)
  }, [screen, visible])

  useEffect(() => {
    setBlinkOn(true)
    if (!cursorBlink || !focused || !visible) return
    const timer = setInterval(() => setBlinkOn((on) => !on), BLINK_MS)
    return () => clearInterval(timer)
  }, [cursorBlink, focused, visible])

  const fit = useCallback(() => {
    const size = hostSize.current
    if (!size || !cell || !visible) return
    // A hidden or collapsing host reports a box smaller than one cell; keep the PTY size.
    const width = size.width - padding * 2 - scrollbarWidth
    if (width < cell.width || size.height < cell.height + padding * 2) return
    const cols = Math.max(2, Math.floor(width / cell.width))
    const rows = Math.max(1, Math.floor((size.height - padding * 2) / cell.height))
    if (cols === screen.cols && rows === screen.rows) return
    screen.resize(cols, rows)
    onResize?.(cols, rows)
    log.info('terminal', `terminal.resize ${JSON.stringify({ cols, rows })}`)
  }, [cell, padding, scrollbarWidth, screen, onResize, visible])

  useEffect(() => {
    fit()
  }, [fit])

  const onFocus = useCallback(() => setHasFocus(true), [])
  const onBlur = useCallback(() => setHasFocus(false), [])

  const setHost = useCallback(
    (instance: PublicInstance | null) => {
      host.current = instance
      if (typeof hostRef === 'function') hostRef(instance)
      else if (hostRef) hostRef.current = instance
    },
    [hostRef]
  )

  const onLayout = (event: EventPayload) => {
    hostSize.current = { width: event.width ?? 0, height: event.height ?? 0 }
    if (resizeTimer.current) clearTimeout(resizeTimer.current)
    resizeTimer.current = setTimeout(fit, RESIZE_DEBOUNCE_MS)
  }

  const gridPoint = (event: EventPayload): { x: number; y: number } | null => {
    const bounds = host.current && renderer?.getElementBounds?.(host.current.id)
    if (!bounds || !cell || event.x === undefined || event.y === undefined) return null
    return { x: event.x - bounds.x - padding, y: event.y - bounds.y - padding }
  }

  /** Selection boundary: the nearest column edge. */
  const cellAt = (event: EventPayload): CellPoint | null => {
    const point = gridPoint(event)
    if (!point || !cell) return null
    const col = Math.max(0, Math.min(screen.cols, Math.round(point.x / cell.width)))
    const y = Math.max(0, Math.min(screen.rows - 1, Math.floor(point.y / cell.height)))
    return { row: screen.rowAt(y), col }
  }

  /** The cell under the pointer, as a link hit or a mouse report uses it. */
  const cellUnder = (event: EventPayload) => {
    const point = gridPoint(event)
    if (!point || !cell) return null
    const col = Math.max(0, Math.min(screen.cols - 1, Math.floor(point.x / cell.width)))
    const row = Math.max(0, Math.min(screen.rows - 1, Math.floor(point.y / cell.height)))
    return {
      col,
      row,
      x: Math.max(0, Math.floor(point.x)),
      y: Math.max(0, Math.floor(point.y))
    }
  }

  const send = (data: string) => {
    screen.scrollToBottom()
    onInput(data)
  }

  /**
   * xterm.js mouse reporting: while a program tracks the mouse, events go to
   * the PTY, and Shift keeps the pointer for selection.
   */
  const reportMouse = (event: EventPayload, button: MouseButton, action: MouseAction): boolean => {
    const tracking = screen.modes.mouseTrackingMode as MouseTracking
    if (tracking === 'none' || event.modifiers?.shift) return false
    const at = cellUnder(event)
    if (!at) return true
    if (action === 'move') {
      const key = `${at.col},${at.row},${button}`
      if (key === lastMoveCell.current) return true
      lastMoveCell.current = key
    }
    const data = encodeMouse(
      {
        ...at,
        button,
        action,
        shift: false,
        alt: !!event.modifiers?.alt,
        ctrl: !!event.modifiers?.ctrl
      },
      tracking,
      screen.mouseEncoding
    )
    if (data) send(data)
    return true
  }

  const copy = (text: string) => {
    if (onCopy) onCopy(text)
    else void copyText(text)
  }
  const paste = () => {
    if (onPaste) {
      onPaste()
      return
    }
    void pasteText().then((text) => {
      if (text) send(encodePaste(text, screen.modes.bracketedPasteMode))
    })
  }

  const onKeyDown = (event: KeyEvent) => {
    if (onKeyIntercept?.(event)) return
    const now = Date.now()
    const action = encodeKey(event, {
      applicationCursor: screen.modes.applicationCursorKeysMode,
      hasSelection: screen.selectedText() !== '',
      mac: process.platform === 'darwin',
      now,
      lastClipboardOp: lastClipboardOp.current
    })
    if (action.type === 'none') return
    event.preventDefault()
    if (action.type === 'send') {
      screen.setSelection(null)
      send(action.data)
    } else if (action.type === 'select-all') {
      screen.selectAll()
    } else if (action.type === 'page') {
      screen.scrollLines(action.direction * screen.rows)
    } else if (action.type === 'copy') {
      const text = screen.selectedText()
      if (text) {
        lastClipboardOp.current = now
        copy(text)
      }
    } else if (action.type === 'paste') {
      lastClipboardOp.current = now
      paste()
    }
  }

  const onScroll = (event: EventPayload) => {
    if (!cell) return
    const pixels = event.precise ? (event.deltaY ?? 0) : (event.deltaY ?? 0) * cell.height
    wheelRemainder.current += -pixels / cell.height
    const lines = Math.trunc(wheelRemainder.current)
    if (!lines) return
    wheelRemainder.current -= lines
    if (screen.modes.mouseTrackingMode !== 'none' && !event.modifiers?.shift) {
      for (let i = 0; i < Math.abs(lines); i++)
        reportMouse(event, 'wheel', lines < 0 ? 'up' : 'down')
      return
    }
    if (screen.terminal.buffer.active.type === 'alternate') {
      // xterm.js turns the wheel into cursor keys on the alternate screen, so
      // less, vim and man scroll their own view.
      const prefix = screen.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['
      onInput(`${prefix}${lines < 0 ? 'A' : 'B'}`.repeat(Math.abs(lines)))
      return
    }
    screen.scrollLines(lines)
  }

  const onMouseDown = (event: EventPayload) => {
    if (host.current) renderer?.focusElement?.(host.current.id)
    const button = MOUSE_BUTTONS[event.button ?? 0]
    pressed.current = button ?? null
    // The DOM view opens a link on Ctrl or Meta click on every platform.
    const linkModifier = event.modifiers?.ctrl || event.modifiers?.cmd
    if (event.button === 0 && linkModifier && onLinkClick) {
      const at = cellUnder(event)
      if (at && onLinkClick({ row: screen.rowAt(at.row), col: at.col }, event)) return
    }
    if (button && reportMouse(event, button, 'down')) return
    const point = cellAt(event)
    if (!point) return
    if (event.button === 2) {
      // rightClickSelectsWord: a right press outside the selection selects the word under it.
      if (!screen.isSelected(point)) screen.setSelection(screen.wordAt(point))
      return
    }
    if (event.button !== 0) return
    if ((event.clickCount ?? 1) >= 2) {
      screen.setSelection(screen.wordAt(point))
      dragging.current = false
      return
    }
    dragging.current = true
    screen.setSelection(
      event.modifiers?.shift && screen.getSelection()
        ? { ...screen.getSelection()!, head: point }
        : { anchor: point, head: point }
    )
  }
  const onMouseMove = (event: EventPayload) => {
    const held =
      event.pressedButton === undefined
        ? (pressed.current ?? 'none')
        : (MOUSE_BUTTONS[event.pressedButton] ?? 'none')
    if (reportMouse(event, held, 'move')) return
    if (!dragging.current || held !== 'left') return
    const point = cellAt(event)
    const selection = screen.getSelection()
    if (point && selection) screen.setSelection({ anchor: selection.anchor, head: point })
  }
  const onMouseUp = (event: EventPayload) => {
    const button = MOUSE_BUTTONS[event.button ?? 0]
    pressed.current = null
    if (button && reportMouse(event, button, 'up')) return
    dragging.current = false
    const selection = screen.getSelection()
    if (
      selection &&
      selection.anchor.row === selection.head.row &&
      selection.anchor.col === selection.head.col
    ) {
      screen.setSelection(null)
    }
  }

  const cursorShape: CursorStyle | 'outline' = focused ? cursorStyle : 'outline'
  const showCursor = frame.cursor.visible && (!cursorBlink || !focused || blinkOn)

  // A hidden pane renders no interactive element. GPUI dispatches the mouse to
  // a visibility: hidden box, and GPUIX does not re-register listeners a
  // render removed, so the pane gets a fresh host each time it is shown; the
  // screen keeps its state, so the first shown frame is the current one.
  if (!visible) return <div key="hidden" style={{ flexGrow: 1 }} />

  return (
    // biome-ignore lint/a11y/useSemanticElements: GPUIX has no terminal element; a <textarea> would take the keys meant for the PTY
    <div
      key="shown"
      ref={setHost}
      testId={testId}
      role="textbox"
      aria-label="Terminal"
      tabIndex={0}
      // biome-ignore lint/a11y/noAutofocus: a terminal pane takes focus on mount like xterm's textarea does
      autoFocus={autoFocus}
      onLayout={onLayout}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onAuxClick={onAuxClick}
      onFocus={onFocus}
      onBlur={onBlur}
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
      {fontsReady && !cell && (
        <div style={{ display: 'flex', position: 'absolute', left: 0, top: 0, opacity: 0 }}>
          <text
            onLayout={(event) => {
              const next = geometryFor(
                { width: event.width ?? 0, chars: PROBE_CHARS },
                fontSize,
                lineHeight,
                fixedCell
              )
              log.info(
                'terminal',
                `terminal.geometry ${JSON.stringify({
                  advance: (event.width ?? 0) / PROBE_CHARS,
                  charHeight: terminalCharHeight(fontSize),
                  cellWidth: next.cell.width,
                  cellHeight: next.cell.height,
                  glyphSize: next.glyphSize
                })}`
              )
              setMeasured({ ...next, fontSize, lineHeight })
              onMetrics?.(next.cell)
            }}
            style={{
              fontFamily: TERMINAL_FONT_FAMILY,
              fontSize,
              lineHeight: fontSize * 1.2,
              color: palette.background,
              whiteSpace: 'nowrap'
            }}
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
                ? {
                    x: frame.cursor.x,
                    char: frame.cursor.char,
                    style: cursorShape,
                    color: palette.cursor,
                    accent: palette.cursorAccent
                  }
                : null
            }
          />
        ))}
    </div>
  )
}
