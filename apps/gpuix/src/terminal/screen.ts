/**
 * The terminal screen model: xterm's own parser, buffers, reflow, scrollback
 * and alt screen through `@xterm/headless`, plus what the headless build
 * leaves to the embedder: a selection, frame coalescing and the visible rows
 * flattened into styled runs for painting.
 *
 * Coordinates: `row` is an absolute line index into the active buffer
 * (`viewportY + y` for a visible row `y`); `col` is a cell column.
 */
import { type IBufferCell, Terminal } from '@xterm/headless'
import { installColorReports } from './color-reports'
import { buildPalette, resolveCellColors, type TerminalPalette, type TerminalTheme } from './colors'
import { type MouseEncoding, trackMouseEncoding } from './mouse'

export interface StyledRun {
  text: string
  cols: number
  fg: string
  bg: string | null
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
}

export interface ScreenRow {
  /** Stable identity for memoised painting: changes when the row's content changes. */
  key: string
  runs: StyledRun[]
}

export interface CellPoint {
  row: number
  col: number
}

export interface Selection {
  anchor: CellPoint
  head: CellPoint
}

export interface ScreenFrame {
  cols: number
  rows: number
  viewportY: number
  baseY: number
  bufferLength: number
  rows_: ScreenRow[]
  cursor: { x: number; y: number; visible: boolean; char: string }
  /** Per visible row `[startCol, endCol)` of the selection, or `null`. */
  selection: Array<[number, number] | null>
  revision: number
}

export interface ScreenOptions {
  cols: number
  rows: number
  theme: TerminalTheme
  scrollback?: number
  /** Milliseconds to coalesce output before a frame is announced. */
  frameMs?: number
}

const ordered = (selection: Selection): [CellPoint, CellPoint] => {
  const { anchor, head } = selection
  const before = anchor.row < head.row || (anchor.row === head.row && anchor.col <= head.col)
  return before ? [anchor, head] : [head, anchor]
}

export class TerminalScreen {
  readonly terminal: Terminal
  palette: TerminalPalette
  /** The cell geometry the view last painted with, for tools that aim the pointer. */
  cellSize: { width: number; height: number } | null = null
  private selection: Selection | null = null
  private revision = 0
  private frameCache: ScreenFrame | null = null
  private rowCache = new Map<number, ScreenRow>()
  private pendingFrame: ReturnType<typeof setTimeout> | null = null
  private readonly frameMs: number
  private readonly listeners = new Set<(frame: ScreenFrame) => void>()
  private readonly cell: IBufferCell
  private readonly mouse: ReturnType<typeof trackMouseEncoding>

  constructor(options: ScreenOptions) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback ?? 10000,
      allowProposedApi: true,
      tabStopWidth: 4,
      convertEol: false
    })
    this.palette = buildPalette(options.theme)
    this.frameMs = options.frameMs ?? 16
    this.cell = this.terminal.buffer.active.getNullCell()
    this.terminal.onWriteParsed(() => this.invalidate())
    this.terminal.onScroll(() => this.invalidate())
    this.terminal.onResize(() => this.invalidate())
    this.terminal.onCursorMove(() => this.invalidate())
    this.mouse = trackMouseEncoding(this.terminal)
    installColorReports(this.terminal, () => this.palette)
  }

  /** The mouse report encoding the running program selected (DECSET 1006/1016). */
  get mouseEncoding(): MouseEncoding {
    return this.mouse.encoding
  }

  get cols(): number {
    return this.terminal.cols
  }
  get rows(): number {
    return this.terminal.rows
  }
  get modes() {
    return this.terminal.modes
  }

  write(data: Uint8Array | string, done?: () => void): void {
    this.terminal.write(data, done)
  }

  resize(cols: number, rows: number): void {
    if (cols === this.terminal.cols && rows === this.terminal.rows) return
    this.terminal.resize(cols, rows)
    this.selection = null
    this.invalidate()
  }

  setTheme(theme: TerminalTheme): void {
    this.palette = buildPalette(theme)
    this.rowCache.clear()
    this.invalidate()
  }

  scrollLines(amount: number): void {
    this.terminal.scrollLines(amount)
    this.invalidate()
  }

  scrollToLine(line: number): void {
    this.terminal.scrollToLine(line)
    this.invalidate()
  }

  /** Repaint every row, for a change the row keys do not see. */
  refresh(): void {
    this.rowCache.clear()
    this.invalidate()
  }

  scrollToBottom(): void {
    this.terminal.scrollToBottom()
    this.invalidate()
  }

  /** Visible row `y` plus the current viewport offset. */
  rowAt(y: number): number {
    return this.terminal.buffer.active.viewportY + y
  }

  setSelection(selection: Selection | null): void {
    this.selection = selection
    this.invalidate()
  }

  selectAll(): void {
    const buffer = this.terminal.buffer.active
    this.setSelection({
      anchor: { row: 0, col: 0 },
      head: { row: buffer.length - 1, col: this.terminal.cols }
    })
  }

  /** Whether a cell boundary point lies inside the current selection. */
  isSelected(point: CellPoint): boolean {
    if (!this.selection) return false
    const [start, end] = ordered(this.selection)
    const after = point.row > start.row || (point.row === start.row && point.col >= start.col)
    const before = point.row < end.row || (point.row === end.row && point.col < end.col)
    return after && before
  }

  getSelection(): Selection | null {
    return this.selection
  }

  selectedText(): string {
    if (!this.selection) return ''
    const [start, end] = ordered(this.selection)
    if (start.row === end.row && start.col === end.col) return ''
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let row = start.row; row <= end.row; row++) {
      const line = buffer.getLine(row)
      if (!line) continue
      const from = row === start.row ? start.col : 0
      const to = row === end.row ? end.col : this.terminal.cols
      const text = line.translateToString(true, from, to)
      if (lines.length && !line.isWrapped) lines.push('\n')
      lines.push(text)
    }
    return lines.join('')
  }

  /**
   * Select the next (or previous) occurrence of `term` after the selection,
   * wrapping around the buffer, and scroll it into view. Plain text, case
   * sensitive, one line at a time: the cases the DOM search handle offers.
   */
  find(term: string, backwards = false): boolean {
    if (!term) return false
    const buffer = this.terminal.buffer.active
    const lines = buffer.length
    const from = this.selection ? ordered(this.selection)[backwards ? 0 : 1] : null
    for (let i = 0; i <= lines; i++) {
      const offset = backwards ? -i : i
      const row = ((from?.row ?? (backwards ? lines - 1 : 0)) + offset + lines) % lines
      const text = buffer.getLine(row)?.translateToString(false) ?? ''
      let col: number
      if (backwards) {
        const limit = i === 0 && from ? from.col - 1 : text.length
        col = limit < 0 ? -1 : text.lastIndexOf(term, limit)
      } else {
        col = text.indexOf(term, i === 0 && from ? from.col : 0)
      }
      if (col < 0) continue
      this.setSelection({ anchor: { row, col }, head: { row, col: col + term.length } })
      if (row < buffer.viewportY || row >= buffer.viewportY + this.terminal.rows)
        this.scrollToLine(Math.max(0, row - (this.terminal.rows >> 1)))
      return true
    }
    return false
  }

  /** Word boundaries around a cell, for double-click selection. */
  wordAt(point: CellPoint): Selection | null {
    const line = this.terminal.buffer.active.getLine(point.row)
    if (!line) return null
    const text = line.translateToString(false)
    const isWord = (ch: string) => /[^\s]/.test(ch)
    if (!isWord(text[point.col] ?? ' ')) return null
    let from = point.col
    let to = point.col
    while (from > 0 && isWord(text[from - 1]!)) from--
    while (to < text.length && isWord(text[to]!)) to++
    return { anchor: { row: point.row, col: from }, head: { row: point.row, col: to } }
  }

  onFrame(listener: (frame: ScreenFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Current frame; rows are cached by content so unchanged rows keep identity. */
  frame(): ScreenFrame {
    if (this.frameCache) return this.frameCache
    const buffer = this.terminal.buffer.active
    const { cols, rows } = this.terminal
    const viewportY = buffer.viewportY
    const rows_: ScreenRow[] = []
    for (let y = 0; y < rows; y++) {
      const row = this.rowRuns(viewportY + y)
      const cached = this.rowCache.get(y)
      rows_.push(cached && cached.key === row.key ? cached : row)
    }
    this.rowCache = new Map(rows_.map((row, y) => [y, row]))
    const cursorRow = buffer.baseY + buffer.cursorY
    const cursorY = cursorRow - viewportY
    const cursorLine = buffer.getLine(cursorRow)
    const cursorCell = cursorLine?.getCell(Math.min(buffer.cursorX, cols - 1), this.cell)
    this.frameCache = {
      cols,
      rows,
      viewportY,
      baseY: buffer.baseY,
      bufferLength: buffer.length,
      rows_,
      cursor: {
        x: Math.min(buffer.cursorX, cols - 1),
        y: cursorY,
        visible: this.terminal.modes.showCursor !== false && cursorY >= 0 && cursorY < rows,
        char: cursorCell?.getChars() || ' '
      },
      selection: this.selectionColumns(viewportY, rows, cols),
      revision: this.revision
    }
    return this.frameCache
  }

  /** The visible rows as plain text, like xterm's `translateToString(true)`. */
  visibleText(): string[] {
    const buffer = this.terminal.buffer.active
    const out: string[] = []
    for (let y = 0; y < this.terminal.rows; y++) {
      out.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
    }
    return out
  }

  dispose(): void {
    if (this.pendingFrame) clearTimeout(this.pendingFrame)
    this.listeners.clear()
    this.mouse.dispose()
    this.terminal.dispose()
  }

  private invalidate(): void {
    this.frameCache = null
    this.revision++
    if (this.pendingFrame || this.listeners.size === 0) return
    this.pendingFrame = setTimeout(() => {
      this.pendingFrame = null
      const frame = this.frame()
      for (const listener of this.listeners) listener(frame)
    }, this.frameMs)
  }

  private selectionColumns(
    viewportY: number,
    rows: number,
    cols: number
  ): Array<[number, number] | null> {
    const out: Array<[number, number] | null> = new Array(rows).fill(null)
    if (!this.selection) return out
    const [start, end] = ordered(this.selection)
    for (let y = 0; y < rows; y++) {
      const row = viewportY + y
      if (row < start.row || row > end.row) continue
      const from = row === start.row ? start.col : 0
      const to = row === end.row ? end.col : cols
      if (to > from) out[y] = [from, to]
    }
    return out
  }

  private rowRuns(row: number): ScreenRow {
    const line = this.terminal.buffer.active.getLine(row)
    const runs: StyledRun[] = []
    const keyParts: string[] = []
    if (!line) return { key: '', runs }
    const cols = this.terminal.cols
    let current: StyledRun | null = null
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x, this.cell)
      if (!cell) break
      const width = cell.getWidth()
      if (width === 0) continue
      const { fg, bg } = resolveCellColors(cell, this.palette)
      const bold = cell.isBold() !== 0
      const italic = cell.isItalic() !== 0
      const underline = cell.isUnderline() !== 0
      const strike = cell.isStrikethrough() !== 0
      const chars = cell.getChars() || ' '
      const same =
        current &&
        current.fg === fg &&
        current.bg === bg &&
        current.bold === bold &&
        current.italic === italic &&
        current.underline === underline &&
        current.strike === strike
      if (same && current) {
        current.text += chars
        current.cols += width
      } else {
        current = { text: chars, cols: width, fg, bg, bold, italic, underline, strike }
        runs.push(current)
      }
    }
    for (const run of runs) {
      keyParts.push(
        `${run.fg}${run.bg ?? ''}${run.bold ? 'b' : ''}${run.italic ? 'i' : ''}${run.underline ? 'u' : ''}${run.strike ? 's' : ''}${run.cols}:${run.text}`
      )
    }
    return { key: keyParts.join('\u0001'), runs }
  }
}
