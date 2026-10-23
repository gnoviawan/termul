/**
 * Geometry of the GPUIX code editor, matched to the web editor's CodeMirror
 * box (measured in Chromium at 1280x800 by `tools/editor/web-shot.ts`):
 * 13px Paper Mono on 20.8px rows, 4px content padding above the first line,
 * 6px before each line, and a gutter of right-aligned 13px monospace line
 * numbers (3px right, 5px left padding, 20px minimum) beside a fold column.
 *
 * Rows never wrap and each character is one column (tabs expand), so every
 * mapping between a document position and a point is arithmetic.
 */

import type { EditorState } from '@codemirror/state'
import { columnAt, posAtColumn } from './model'

export const FONT_SIZE = 13
export const LINE_HEIGHT = 20.8
export const PAD_TOP = 4
export const PAD_LEFT = 6
export const PAD_RIGHT = 2
export const GUTTER_FONT = 'DejaVu Sans Mono'
export const GUTTER_LINE_HEIGHT = 18.2
/** DejaVu Sans Mono's advance at 13px (Chromium: 23.66px gutter for two digits). */
export const GUTTER_ADVANCE = 7.828
export const NUMBER_PAD_LEFT = 5
export const NUMBER_PAD_RIGHT = 3
export const FOLD_WIDTH = GUTTER_ADVANCE + 2
/** Paper Mono's advance at 13px, until the view measures it. */
export const DEFAULT_CHAR_WIDTH = 7.878

export interface Viewport {
  width: number
  height: number
  scrollTop: number
  scrollLeft: number
  charWidth: number
}

export function numbersWidth(lines: number): number {
  const digits = Math.max(String(lines).length, 1)
  return Math.max(20, digits * GUTTER_ADVANCE + NUMBER_PAD_LEFT + NUMBER_PAD_RIGHT)
}

/** Gutter width including its 1px border. */
export function gutterWidth(lines: number): number {
  return numbersWidth(lines) + FOLD_WIDTH + 1
}

export function contentHeight(lines: number): number {
  return PAD_TOP * 2 + lines * LINE_HEIGHT
}

export function lineTop(line: number): number {
  return PAD_TOP + (line - 1) * LINE_HEIGHT
}

/** First and last line any part of which is inside the viewport, plus `overscan` lines each side. */
export function visibleLines(lines: number, viewport: Viewport, overscan = 0): [number, number] {
  const first = Math.floor((viewport.scrollTop - PAD_TOP) / LINE_HEIGHT) + 1 - overscan
  const last = Math.ceil((viewport.scrollTop + viewport.height - PAD_TOP) / LINE_HEIGHT) + overscan
  return [Math.max(1, first), Math.min(lines, Math.max(1, last))]
}

/** Top-left of the caret at `pos`, in content coordinates (before scrolling). */
export function caretPoint(state: EditorState, pos: number, charWidth: number): { x: number; y: number } {
  const line = state.doc.lineAt(pos)
  return { x: PAD_LEFT + columnAt(state, pos) * charWidth, y: lineTop(line.number) }
}

/** The document position nearest a point in content-viewport coordinates. */
export function posAtPoint(state: EditorState, x: number, y: number, viewport: Viewport): number {
  const docY = y + viewport.scrollTop - PAD_TOP
  const line = Math.floor(docY / LINE_HEIGHT) + 1
  if (line < 1) return 0
  if (line > state.doc.lines) return state.doc.length
  const column = Math.round((x + viewport.scrollLeft - PAD_LEFT) / viewport.charWidth)
  return posAtColumn(state, line, column)
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Selection wash rectangles for lines `first`..`last`, in content coordinates. */
export function selectionRects(
  state: EditorState,
  first: number,
  last: number,
  charWidth: number,
  rightEdge: number
): Rect[] {
  const { from, to, empty } = state.selection.main
  if (empty) return []
  const rects: Rect[] = []
  const startLine = Math.max(first, state.doc.lineAt(from).number)
  const endLine = Math.min(last, state.doc.lineAt(to).number)
  for (let n = startLine; n <= endLine; n++) {
    const line = state.doc.line(n)
    const left = from > line.from ? caretPoint(state, from, charWidth).x : PAD_LEFT
    const right = to <= line.to ? caretPoint(state, to, charWidth).x : rightEdge
    if (right > left) rects.push({ x: left, y: lineTop(n), width: right - left, height: LINE_HEIGHT })
  }
  return rects
}

/** Scroll offsets that keep the caret at `pos` on screen, moving as little as possible. */
export function followCaret(
  state: EditorState,
  pos: number,
  viewport: Viewport,
  maxScrollTop: number,
  maxScrollLeft: number
): { scrollTop: number; scrollLeft: number } {
  const { x, y } = caretPoint(state, pos, viewport.charWidth)
  let { scrollTop, scrollLeft } = viewport
  if (y < scrollTop) scrollTop = y - PAD_TOP
  else if (y + LINE_HEIGHT > scrollTop + viewport.height) scrollTop = y + LINE_HEIGHT + PAD_TOP - viewport.height
  if (x < scrollLeft + PAD_LEFT) scrollLeft = x - PAD_LEFT
  else if (x + viewport.charWidth > scrollLeft + viewport.width) scrollLeft = x + viewport.charWidth * 4 - viewport.width
  return {
    scrollTop: Math.min(Math.max(0, scrollTop), maxScrollTop),
    scrollLeft: Math.min(Math.max(0, scrollLeft), maxScrollLeft)
  }
}

/** Widest line, in columns. */
export function maxColumns(state: EditorState): number {
  let widest = 0
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    if (line.length > widest) widest = columnAt(state, line.to)
  }
  return widest
}

/** A line's text with tabs expanded, as `<code>` paints it. */
export function displayLine(text: string, tabSize: number): string {
  if (!text.includes('\t')) return text
  let out = ''
  for (const ch of text) {
    if (ch === '\t') out += ' '.repeat(tabSize - (out.length % tabSize))
    else out += ch
  }
  return out
}
