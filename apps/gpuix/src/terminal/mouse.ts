/**
 * Mouse reporting, following xterm.js `MouseStateService` and
 * `MouseService._triggerMouseEvent` (xterm/src/common/services, MIT): the
 * tracking mode decides which events reach the PTY, the encoding decides the
 * bytes. The headless build tracks both but only exposes the mode, so the
 * encoding is observed from DECSET/DECRST 1006 and 1016 on the parser.
 */
import type { Terminal } from '@xterm/headless'

/** `terminal.modes.mouseTrackingMode`. */
export type MouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any'
export type MouseEncoding = 'default' | 'sgr' | 'sgr-pixels'

export type MouseButton = 'left' | 'middle' | 'right' | 'none' | 'wheel'
/** Wheel events use `up`/`down` for the scroll direction, like xterm. */
export type MouseAction = 'down' | 'up' | 'move'

export interface MouseReport {
  /** Zero-based cell. */
  col: number
  row: number
  /** Pixels from the grid origin, for SGR-pixels. */
  x: number
  y: number
  button: MouseButton
  action: MouseAction
  shift: boolean
  alt: boolean
  ctrl: boolean
}

const BUTTON_CODE: Record<MouseButton, number> = {
  left: 0,
  middle: 1,
  right: 2,
  none: 3,
  wheel: 4
}
const MOVE = 32

function allowed(tracking: MouseTracking, report: MouseReport): boolean {
  switch (tracking) {
    case 'none':
      return false
    case 'x10':
      return report.button !== 'wheel' && report.action === 'down'
    case 'vt200':
      return report.action !== 'move'
    case 'drag':
      return !(report.action === 'move' && report.button === 'none')
    case 'any':
      return true
  }
}

function eventCode(report: MouseReport, sgr: boolean): number {
  let code = (report.ctrl ? 16 : 0) | (report.shift ? 4 : 0) | (report.alt ? 8 : 0)
  if (report.button === 'wheel') return code | 64 | (report.action === 'down' ? 1 : 0)
  code |= BUTTON_CODE[report.button] & 3
  if (report.action === 'move') code |= MOVE
  else if (report.action === 'up' && !sgr) code |= BUTTON_CODE.none
  return code
}

/**
 * The bytes xterm.js would send for `report`, or `null` when the mode filters
 * it out or the default encoding cannot express the cell.
 */
export function encodeMouse(
  report: MouseReport,
  tracking: MouseTracking,
  encoding: MouseEncoding
): string | null {
  if (report.button === 'wheel' && report.action === 'move') return null
  if (report.button === 'none' && report.action !== 'move') return null
  if (!allowed(tracking, report)) return null
  const e = tracking === 'x10' ? { ...report, ctrl: false, alt: false, shift: false } : report
  const col = e.col + 1
  const row = e.row + 1
  const release = e.action === 'up' && e.button !== 'wheel'
  if (encoding === 'sgr') return `\x1b[<${eventCode(e, true)};${col};${row}${release ? 'm' : 'M'}`
  if (encoding === 'sgr-pixels')
    return `\x1b[<${eventCode(e, true)};${e.x};${e.y}${release ? 'm' : 'M'}`
  const params = [eventCode(e, false) + 32, col + 32, row + 32]
  if (params.some((value) => value > 255)) return null
  return `\x1b[M${String.fromCharCode(...params)}`
}

/** Follows the mouse encoding a program selects, which `terminal.modes` does not report. */
export function trackMouseEncoding(terminal: Terminal): {
  readonly encoding: MouseEncoding
  dispose(): void
} {
  const state: { encoding: MouseEncoding } = { encoding: 'default' }
  const apply = (set: boolean) => (params: (number | number[])[]) => {
    for (const param of params) {
      const mode = Array.isArray(param) ? param[0] : param
      if (mode === 1006) state.encoding = set ? 'sgr' : 'default'
      else if (mode === 1016) state.encoding = set ? 'sgr-pixels' : 'default'
    }
    return false
  }
  const disposables = [
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, apply(true)),
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, apply(false)),
    // RIS resets the encoding without a DECRST.
    terminal.parser.registerEscHandler({ final: 'c' }, () => {
      state.encoding = 'default'
      return false
    })
  ]
  return {
    get encoding() {
      return state.encoding
    },
    dispose: () => {
      for (const disposable of disposables) disposable.dispose()
    }
  }
}
