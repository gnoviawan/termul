import type { Terminal } from '@xterm/xterm'
import type { TerminalModes } from '../../../shared/types/ipc.types'

/**
 * Snapshot the DEC private modes a cached xterm currently holds, as the
 * `TerminalModes` that `buildRehydrateSequences` replays. Read before
 * `terminal.reset()` wipes them, so a trimmed missed-output tail lands in the
 * same alt-screen/paste/cursor/mouse state the app left the terminal in.
 * xterm's public `modes` does not expose the mouse encoding (1006/1016), so
 * only the tracking mode itself is restored; a full tail re-emits the rest.
 */
export function snapshotXtermModes(terminal: Pick<Terminal, 'modes' | 'buffer'>): TerminalModes {
  const { modes } = terminal
  const mouseTracking: TerminalModes['mouseTracking'] =
    modes.mouseTrackingMode === 'drag'
      ? 'drag'
      : modes.mouseTrackingMode === 'any'
        ? 'any'
        : modes.mouseTrackingMode === 'none'
          ? null
          : // xterm 'vt200' (DEC 1000) and 'x10' (DEC 9) both map to the
            // registry's 'x10', which replays DEC 1000.
            'x10'
  return {
    alternateScreen: terminal.buffer.active.type === 'alternate',
    bracketedPaste: modes.bracketedPasteMode,
    applicationCursor: modes.applicationCursorKeysMode,
    mouseTracking
  }
}
