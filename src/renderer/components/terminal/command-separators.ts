import type { IMarker, Terminal } from '@xterm/xterm'

/**
 * Command Separator Decorator for Terminal Scrollback
 *
 * SCOPE:
 * Separators appear only for Termul's private prompt mark (OSC 133;A;termul)
 * when host spacing has injected a blank row above it:
 * - Termul's integrated zsh and bash shells emit `\033]133;A;termul\007`.
 * - The host-side prompt spacer injects blank rows before and after the mark
 *   when a completed visible line preceded it.
 * - The renderer checks that the row directly above the mark anchor is whitespace-only,
 *   confirming spacing, and that non-blank content exists further up in the buffer.
 * - Plain `133;A` marks from user prompts or readline/ZLE redisplay are ignored to
 *   avoid duplicate or glued lines.
 *
 * LIMITATIONS:
 * - Serialized restore has no lines: snapshot persistence (`restoreScrollback`)
 *   restores content without OSC sequences, so rehydrated sessions show no separators.
 * - Alternate-screen mode restore skips marks from replayed normal-buffer output:
 *   when mode restore re-enters alternate screen before transcript replay, marks
 *   from normal buffer replay are intentionally ignored.
 * - A partial row without a trailing newline (e.g. output without trailing newline)
 *   has no blank row above the anchor, so no line is drawn.
 */

const terminalMarkersMap = new WeakMap<Terminal, IMarker[]>()

/**
 * Check if the row at `row` contains only whitespace characters (or is empty).
 */
function isRowBlank(terminal: Terminal, row: number): boolean {
  if (row < 0) {
    return false
  }
  const line = terminal.buffer.active.getLine(row)
  return !line || line.translateToString(true).trim() === ''
}

/**
 * Check if any row above `anchorRow` contains non-whitespace text.
 * Scans backwards from `anchorRow - 1` to 0 and stops at the first non-blank row.
 */
function hasNonBlankRowAbove(terminal: Terminal, anchorRow: number): boolean {
  const buffer = terminal.buffer.active
  for (let r = anchorRow - 1; r >= 0; r--) {
    const line = buffer.getLine(r)
    if (line && line.translateToString(true).trim() !== '') {
      return true
    }
  }
  return false
}

/**
 * Prunes disposed markers and checks if any live marker is already on `anchorRow`.
 */
function isRowAlreadyMarked(liveMarkers: IMarker[], anchorRow: number): boolean {
  return liveMarkers.some((m) => m.line === anchorRow)
}

/**
 * Attach OSC 133;A;termul command separator line decoration to a terminal.
 * Idempotent per Terminal instance via a module-level WeakMap.
 */
export function attachCommandSeparators(terminal: Terminal): void {
  if (terminalMarkersMap.has(terminal)) {
    return
  }

  if (
    typeof terminal.parser?.registerOscHandler !== 'function' ||
    typeof terminal.registerMarker !== 'function' ||
    typeof terminal.registerDecoration !== 'function'
  ) {
    return
  }

  const markers: IMarker[] = []
  terminalMarkersMap.set(terminal, markers)

  terminal.parser.registerOscHandler(133, (data) => {
    if (data !== 'A;termul') {
      return false
    }

    if (terminal.buffer.active.type === 'alternate') {
      return false
    }

    const buffer = terminal.buffer.active
    const cursorOffset = buffer.cursorX >= terminal.cols ? 1 : 0
    const anchorRow = buffer.baseY + buffer.cursorY + cursorOffset

    if (!isRowBlank(terminal, anchorRow - 1)) {
      return false
    }

    if (!hasNonBlankRowAbove(terminal, anchorRow)) {
      return false
    }

    const currentMarkers = terminalMarkersMap.get(terminal) ?? []
    const liveMarkers = currentMarkers.filter((m) => !m.isDisposed && m.line !== -1)
    terminalMarkersMap.set(terminal, liveMarkers)

    if (isRowAlreadyMarked(liveMarkers, anchorRow)) {
      return false
    }

    const marker = terminal.registerMarker(cursorOffset)
    if (!marker) {
      return false
    }

    liveMarkers.push(marker)
    const decoration = terminal.registerDecoration({
      marker,
      width: terminal.cols
    })

    decoration?.onRender((element) => {
      element.classList.add('termul-command-separator')
    })

    return false
  })
}
