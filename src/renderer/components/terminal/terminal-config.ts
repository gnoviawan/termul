import type { ITerminalOptions, ITheme } from '@xterm/xterm'
import { getActiveTerminalTheme } from '@/lib/themes'

// Resize debounce delay in milliseconds - prevents flooding PTY with resize events during drag
export const RESIZE_DEBOUNCE_MS = 50

// Windows build number for ConPTY. Build 21376 (Windows 10 20H2) introduced stable ConPTY
// support. Using this value enables xterm.js to apply appropriate workarounds for ConPTY
// behavior (e.g., correct line wrapping calculations).
export const CONPTY_MIN_BUILD_NUMBER = 21376

export const TERMINAL_THEME: ITheme = getActiveTerminalTheme()

export const DEFAULT_TERMINAL_OPTIONS: ITerminalOptions = {
  // Cross-platform monospace stack:
  // - JetBrains Mono Variable: bundled via @fontsource-variable, available everywhere.
  // - Cascadia / Menlo / Consolas / SF Mono: native fallbacks per OS.
  // - Ubuntu Mono / DejaVu Sans Mono: ships with most Linux distros.
  fontFamily:
    '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Monaco, Consolas, "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  theme: TERMINAL_THEME,
  cursorBlink: true,
  cursorStyle: 'block',
  allowTransparency: false,
  scrollback: 10000,
  tabStopWidth: 4,
  convertEol: false,
  ignoreBracketedPasteMode: false,
  rightClickSelectsWord: true,
  screenReaderMode: true
}

/**
 * Get platform-aware terminal options.
 * On Windows, adds windowsPty configuration for ConPTY compatibility.
 * Note: Uses navigator.platform (not process.platform) because this runs in
 * renderer process where Node.js APIs are not available.
 */
export function getTerminalOptions(platform: string): ITerminalOptions {
  const baseOptions: ITerminalOptions = {
    ...DEFAULT_TERMINAL_OPTIONS
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
