import type { ITerminalOptions } from '@xterm/xterm'
import { MONO_STACK } from '@/lib/font-stacks'
import { getActiveTerminalTheme } from '@/lib/themes'

// Resize debounce delay in milliseconds - prevents flooding PTY with resize events during drag
export const RESIZE_DEBOUNCE_MS = 50

// Windows build number for ConPTY. Build 21376 (Windows 10 20H2) introduced stable ConPTY
// support. Using this value enables xterm.js to apply appropriate workarounds for ConPTY
// behavior (e.g., correct line wrapping calculations).
export const CONPTY_MIN_BUILD_NUMBER = 21376

export const DEFAULT_TERMINAL_OPTIONS: ITerminalOptions = {
  // Bundled Paper Mono on every OS. `monospace` covers glyphs the file lacks.
  fontFamily: MONO_STACK,
  fontSize: 14,
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: 'block',
  allowTransparency: false,
  scrollback: 10000,
  tabStopWidth: 4,
  convertEol: false,
  ignoreBracketedPasteMode: false,
  rightClickSelectsWord: true,
  // xterm screenReaderMode routes keystrokes through the a11y textarea path, which
  // can emit duplicate bytes to the PTY (see xtermjs/xterm.js#3467, repo #267).
  // Default off. The explicit user-facing setting is AppSettings.terminalScreenReaderMode
  // (Terminal Appearance > Screen reader mode); ConnectedTerminal applies it at
  // construction, so only new terminals pick it up.
  screenReaderMode: false
}

/**
 * Get platform-aware terminal options.
 * On Windows, adds windowsPty configuration for ConPTY compatibility.
 * Note: Uses navigator.platform (not process.platform) because this runs in
 * renderer process where Node.js APIs are not available.
 */
export function getTerminalOptions(platform: string): ITerminalOptions {
  const baseOptions: ITerminalOptions = {
    ...DEFAULT_TERMINAL_OPTIONS,
    theme: getActiveTerminalTheme()
  }

  if (platform.startsWith('Win')) {
    return {
      ...baseOptions,
      windowsPty: {
        backend: 'conpty',
        buildNumber: CONPTY_MIN_BUILD_NUMBER
      }
    }
  }

  return baseOptions
}
