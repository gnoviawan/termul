import type { ThemeTerminalColors } from './types'

/**
 * Terminal colors for the two Termul themes, frozen at the values the
 * palette produced before the brand moved to the Interfere blue. Terminal
 * output stays the same when `primary` or `accent` changes.
 */
export const TERMUL_DARK_TERMINAL: ThemeTerminalColors = {
  selectionBackground: '#2958a3',
  selectionInactiveBackground: '#262727',
  black: '#070809',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#3b82f6',
  cyan: '#38bdf8',
  brightBlack: '#6b6c6d',
  brightRed: '#f16060',
  brightGreen: '#43ce76',
  brightYellow: '#edbe2d',
  brightBlue: '#5895f7',
  brightMagenta: '#5895f7',
  brightCyan: '#56c7f9',
  brightWhite: '#e8e8e9'
}

export const TERMUL_LIGHT_TERMINAL: ThemeTerminalColors = {
  selectionBackground: '#6ca1f8',
  selectionInactiveBackground: '#f0f0f0',
  black: '#e0e0e0',
  red: '#cd3131',
  green: '#098658',
  yellow: '#cd9731',
  blue: '#3b82f6',
  magenta: '#811f3f',
  cyan: '#0598bc',
  brightBlack: '#929292',
  brightRed: '#b92c2c',
  brightGreen: '#08794f',
  brightYellow: '#b9882c',
  brightBlue: '#3575dd',
  brightMagenta: '#741c39',
  brightCyan: '#0589a9',
  brightWhite: '#0b0b0b'
}
