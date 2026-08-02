import type { IDisposable, Terminal } from '@xterm/xterm'
import type { TerminalModes } from '../../shared/types/ipc.types'
import { DEFAULT_SCROLLBACK_LIMIT } from '../../shared/types/persistence.types'

/**
 * Registry to track xterm Terminal instances by terminal ID
 * This allows the auto-save hook to access terminal buffers for scrollback persistence
 */
const terminalRegistry = new Map<string, Terminal>()

// ---------------------------------------------------------------------------
// DEC private-mode tracker (R3)
//
// Tracks the DEC private-mode state (alt-screen, bracketed-paste,
// application-cursor, mouse tracking/SGR) per registered terminal via xterm's
// PUBLIC parser API (`terminal.parser.registerCsiHandler`). This is a passive
// observer: handlers return `false` so xterm's built-in mode handling still
// runs. Never reads xterm internals (`_core`/`_inputHandler`) and never
// hand-rolls a raw-stream CSI parser.
//
// Note: DEC private sequences (e.g. `\x1b[?1049h`) carry the `?` as the xterm
// `prefix` field (range 0x3c..0x3f), NOT `intermediates` (0x20..0x2f). xterm's
// own `setModePrivate`/`resetModePrivate` are registered with
// `{ prefix: '?', final: 'h' | 'l' }` — we mirror that exactly so the handlers
// actually fire.
// ---------------------------------------------------------------------------

interface ModeTracker {
  modes: TerminalModes
  disposables: IDisposable[]
}

const modeTrackers = new Map<string, ModeTracker>()

const EMPTY_MODES: TerminalModes = {
  alternateScreen: false,
  bracketedPaste: false,
  applicationCursor: false,
  mouseTracking: null,
  sgrMouseMode: false,
  sgrMousePixelsMode: false
}

/** Apply a DEC private-mode SET (`?...h`). Mutates `modes` in place. */
function applyModeSet(modes: TerminalModes, modeNum: number): void {
  switch (modeNum) {
    case 1049:
    case 1047:
    case 47:
      modes.alternateScreen = true
      break
    case 2004:
      modes.bracketedPaste = true
      break
    case 1:
      modes.applicationCursor = true
      break
    case 1000:
      modes.mouseTracking = 'x10'
      break
    case 1002:
      modes.mouseTracking = 'drag'
      break
    case 1003:
      modes.mouseTracking = 'any'
      break
    case 1006:
      modes.sgrMouseMode = true
      break
    case 1016:
      modes.sgrMousePixelsMode = true
      break
  }
}

/** Apply a DEC private-mode RESET (`?...l`). Mutates `modes` in place. */
function applyModeReset(modes: TerminalModes, modeNum: number): void {
  switch (modeNum) {
    case 1049:
    case 1047:
    case 47:
      modes.alternateScreen = false
      break
    case 2004:
      modes.bracketedPaste = false
      break
    case 1:
      modes.applicationCursor = false
      break
    case 1000:
      if (modes.mouseTracking === 'x10') modes.mouseTracking = null
      break
    case 1002:
      if (modes.mouseTracking === 'drag') modes.mouseTracking = null
      break
    case 1003:
      if (modes.mouseTracking === 'any') modes.mouseTracking = null
      break
    case 1006:
      modes.sgrMouseMode = false
      break
    case 1016:
      modes.sgrMousePixelsMode = false
      break
  }
}

/** Extract the mode number from a (possibly sub-parameterized) CSI param. */
function paramToModeNumber(param: number | number[]): number | undefined {
  if (typeof param === 'number') return param
  if (Array.isArray(param) && param.length > 0) return param[0]
  return undefined
}

/**
 * Start tracking DEC private modes for a terminal via xterm's public parser API.
 * Idempotent: re-starting for an id first disposes any prior registration.
 * No-ops gracefully when the terminal lacks a `parser.registerCsiHandler`
 * (e.g. minimal test mocks) so existing callers keep working unchanged.
 */
export function startTrackingModes(terminalId: string, terminal: Terminal): void {
  stopTrackingModes(terminalId)
  // xterm's public parser surface is `terminal.parser`. Access defensively via a
  // structural cast so partial mocks (no parser) narrow cleanly without reading
  // any xterm internals.
  const parser = (
    terminal as unknown as {
      parser?: {
        registerCsiHandler?: (
          id: { prefix?: string; intermediates?: string; final: string },
          callback: (params: (number | number[])[]) => boolean
        ) => IDisposable
      }
    }
  ).parser
  if (!parser || typeof parser.registerCsiHandler !== 'function') return

  const modes: TerminalModes = { ...EMPTY_MODES }
  const disposables: IDisposable[] = []

  const setHandler = parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    for (const param of params) {
      const modeNum = paramToModeNumber(param)
      if (modeNum !== undefined) applyModeSet(modes, modeNum)
    }
    // Passive observer: return false so xterm's built-in setModePrivate handler
    // still runs and actually applies the mode to the terminal.
    return false
  })
  const resetHandler = parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    for (const param of params) {
      const modeNum = paramToModeNumber(param)
      if (modeNum !== undefined) applyModeReset(modes, modeNum)
    }
    return false
  })
  disposables.push(setHandler, resetHandler)
  modeTrackers.set(terminalId, { modes, disposables })
}

/**
 * Get a snapshot of the currently-tracked DEC private modes for a terminal.
 * Returns `undefined` when no tracker is registered for the id (best-effort:
 * callers treat absence as "no modes to replay" and degrade to content-only).
 */
export function getTerminalModes(terminalId: string): TerminalModes | undefined {
  const tracker = modeTrackers.get(terminalId)
  return tracker ? { ...tracker.modes } : undefined
}

/** Stop tracking DEC private modes for a terminal (dispose the CSI handlers). */
export function stopTrackingModes(terminalId: string): void {
  const tracker = modeTrackers.get(terminalId)
  if (!tracker) return
  for (const disposable of tracker.disposables) {
    try {
      disposable.dispose()
    } catch {
      // Best-effort cleanup — never throw from a registry teardown.
    }
  }
  modeTrackers.delete(terminalId)
}

/**
 * Build the DEC private-mode rehydrate escape sequences for a captured mode
 * snapshot, emitting only the modes currently ON (ported from Orca's
 * `buildRehydrateSequences` table). Returns `''` when there is nothing to
 * replay (normal shell / no modes active) so content restores as before.
 */
export function buildRehydrateSequences(modes?: TerminalModes | null): string {
  if (!modes) return ''
  const seqs: string[] = []
  if (modes.alternateScreen) seqs.push('\x1b[0m\x1b[?1049h')
  if (modes.bracketedPaste) seqs.push('\x1b[?2004h')
  if (modes.applicationCursor) seqs.push('\x1b[?1h')
  if (modes.mouseTracking === 'x10') seqs.push('\x1b[?1000h')
  if (modes.mouseTracking === 'drag') seqs.push('\x1b[?1002h')
  if (modes.mouseTracking === 'any') seqs.push('\x1b[?1003h')
  if (modes.sgrMouseMode) seqs.push('\x1b[?1006h')
  if (modes.sgrMousePixelsMode) seqs.push('\x1b[?1016h')
  return seqs.join('')
}

/**
 * Cache for scroll positions during pane transitions
 * Maps terminal ID to scroll position (viewportY offset from buffer base)
 */
const scrollPositionCache = new Map<string, number>()

/**
 * Register a terminal instance for scrollback persistence
 */
export function registerTerminal(terminalId: string, terminal: Terminal): void {
  terminalRegistry.set(terminalId, terminal)
  // R3: begin DEC private-mode tracking via the public parser API. No-ops for
  // terminals without a parser surface (minimal test mocks).
  startTrackingModes(terminalId, terminal)
}

/**
 * Unregister a terminal when it's disposed
 */
export function unregisterTerminal(terminalId: string): void {
  terminalRegistry.delete(terminalId)
  stopTrackingModes(terminalId)
}

/**
 * Destroy a terminal completely - unregister and clean up scroll position cache
 * Use this for permanent terminal closure. Use unregisterTerminal for transient pane transitions.
 */
export function destroyTerminal(terminalId: string): void {
  terminalRegistry.delete(terminalId)
  scrollPositionCache.delete(terminalId)
  stopTrackingModes(terminalId)
}

/**
 * Get a terminal instance by ID
 */
export function getTerminal(terminalId: string): Terminal | undefined {
  return terminalRegistry.get(terminalId)
}

/**
 * Extract scrollback content from a terminal's buffer
 * Returns array of lines with ANSI escape sequences preserved
 */
export function extractScrollback(
  terminalId: string,
  maxLines: number = DEFAULT_SCROLLBACK_LIMIT
): string[] | undefined {
  const terminal = terminalRegistry.get(terminalId)
  if (!terminal) return undefined

  const buffer = terminal.buffer.active
  const lines: string[] = []

  // Get total lines (scrollback + viewport)
  const totalLines = buffer.length

  // Calculate start line to respect maxLines limit
  const startLine = Math.max(0, totalLines - maxLines)

  for (let i = startLine; i < totalLines; i++) {
    const line = buffer.getLine(i)
    if (line) {
      // translateToString(trimRight=false) preserves trailing whitespace and ANSI sequences
      lines.push(line.translateToString(false))
    }
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }

  return lines.length > 0 ? lines : undefined
}

/**
 * Restore scrollback content to a terminal.
 *
 * When `modes` are supplied (R3), the DEC private-mode rehydrate sequences
 * (`buildRehydrateSequences`) are emitted BEFORE the content join, so the
 * restored xterm re-enters alt-screen / bracketed-paste / cursor / mouse
 * modes first and the captured content then writes to the (now-alt) buffer.
 * When `modes` is absent/empty, behaves exactly as before (content-only).
 */
export function restoreScrollback(
  terminal: Terminal,
  scrollback: string[],
  modes?: TerminalModes | null
): void {
  if (!scrollback || scrollback.length === 0) return

  try {
    const modeSeqs = buildRehydrateSequences(modes)
    // Join lines with newlines and write to terminal.
    // This restores the visual content without executing commands.
    const content = `${scrollback.join('\r\n')}\r\n`
    terminal.write(modeSeqs ? `${modeSeqs}${content}` : content)
  } catch (err) {
    console.error('Failed to restore scrollback:', err)
  }
}

/**
 * Get count of registered terminals (for testing)
 */
export function getRegistrySize(): number {
  return terminalRegistry.size
}

/** Invoke callback for every registered xterm instance (e.g. live theme preview). */
export function forEachTerminal(callback: (terminal: Terminal) => void): void {
  for (const terminal of terminalRegistry.values()) {
    callback(terminal)
  }
}

/**
 * Clear all registered terminals (for testing)
 */
export function clearRegistry(): void {
  terminalRegistry.clear()
  scrollPositionCache.clear()
  for (const id of Array.from(modeTrackers.keys())) stopTrackingModes(id)
}

/**
 * Capture the current scroll position of a terminal before unmount
 * Stores the viewportY position for restoration after remount
 */
export function captureScrollPosition(terminalId: string): void {
  const terminal = terminalRegistry.get(terminalId)
  if (terminal?.buffer?.active) {
    const viewportY = terminal.buffer.active.viewportY
    scrollPositionCache.set(terminalId, viewportY)
  }
}

/**
 * Get cached scroll position for a terminal
 * Returns undefined if no cached position exists
 */
export function getCachedScrollPosition(terminalId: string): number | undefined {
  return scrollPositionCache.get(terminalId)
}

/**
 * Clear cached scroll position for a terminal
 * Call after successful restoration to prevent stale data
 */
export function clearScrollPosition(terminalId: string): void {
  scrollPositionCache.delete(terminalId)
}

/**
 * Restore scroll position to a terminal
 * Scrolls the terminal to the cached position if available
 * Returns true if restoration was performed, false otherwise
 */
export function restoreScrollPosition(terminalId: string, terminal: Terminal): boolean {
  const cachedPosition = scrollPositionCache.get(terminalId)
  if (cachedPosition !== undefined && terminal.scrollToLine) {
    // Use scrollToLine to restore position
    // The buffer line index is calculated from the base
    try {
      terminal.scrollToLine(cachedPosition)
      // Clear cache after successful restoration
      scrollPositionCache.delete(terminalId)
      return true
    } catch {
      // Clear cache on error to prevent stale data
      scrollPositionCache.delete(terminalId)
      return false
    }
  }
  return false
}
