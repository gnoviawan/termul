import type { ITerminalOptions, ITheme } from '@xterm/xterm'

// Resize debounce delay in milliseconds - prevents flooding PTY with resize events during drag
export const RESIZE_DEBOUNCE_MS = 50

// Windows build number for ConPTY. Build 21376 (Windows 10 20H2) introduced stable ConPTY
// support. Using this value enables xterm.js to apply appropriate workarounds for ConPTY
// behavior (e.g., correct line wrapping calculations).
const CONPTY_MIN_BUILD_NUMBER = 21376

export const TERMINAL_THEME: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  selectionInactiveBackground: '#3a3d41',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

export const DEFAULT_TERMINAL_OPTIONS: ITerminalOptions = {
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  theme: TERMINAL_THEME,
  cursorBlink: true,
  cursorStyle: 'block',
  allowTransparency: false,
  scrollback: 10000,
  tabStopWidth: 4,
  convertEol: false,
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
