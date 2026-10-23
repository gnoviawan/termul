import { describe, expect, test } from 'bun:test'
import { encodeMouse, type MouseReport } from './mouse'
import { TerminalScreen } from './screen'
import { terminalThemeFor } from './theme'

const at = (over: Partial<MouseReport>): MouseReport => ({
  col: 9,
  row: 4,
  x: 77,
  y: 90,
  button: 'left',
  action: 'down',
  shift: false,
  alt: false,
  ctrl: false,
  ...over
})

const write = (screen: TerminalScreen, data: string) =>
  new Promise<void>((done) => screen.write(data, done))

describe('encodeMouse', () => {
  test('SGR press and release carry 1-based cells and m for release', () => {
    expect(encodeMouse(at({}), 'vt200', 'sgr')).toBe('\x1b[<0;10;5M')
    expect(encodeMouse(at({ action: 'up' }), 'vt200', 'sgr')).toBe('\x1b[<0;10;5m')
    expect(encodeMouse(at({ button: 'right', ctrl: true }), 'vt200', 'sgr')).toBe('\x1b[<18;10;5M')
  })

  test('default encoding adds 32 and reports a release as button 3', () => {
    expect(encodeMouse(at({}), 'vt200', 'default')).toBe('\x1b[M *%')
    expect(encodeMouse(at({ action: 'up' }), 'vt200', 'default')).toBe('\x1b[M#*%')
    expect(encodeMouse(at({ col: 300 }), 'vt200', 'default')).toBeNull()
  })

  test('the tracking mode filters events like xterm', () => {
    expect(encodeMouse(at({ action: 'up' }), 'x10', 'sgr')).toBeNull()
    expect(encodeMouse(at({ ctrl: true }), 'x10', 'sgr')).toBe('\x1b[<0;10;5M')
    expect(encodeMouse(at({ action: 'move' }), 'vt200', 'sgr')).toBeNull()
    expect(encodeMouse(at({ action: 'move' }), 'drag', 'sgr')).toBe('\x1b[<32;10;5M')
    expect(encodeMouse(at({ action: 'move', button: 'none' }), 'drag', 'sgr')).toBeNull()
    expect(encodeMouse(at({ action: 'move', button: 'none' }), 'any', 'sgr')).toBe('\x1b[<35;10;5M')
    expect(encodeMouse(at({ button: 'wheel', action: 'up' }), 'vt200', 'sgr')).toBe(
      '\x1b[<64;10;5M'
    )
    expect(encodeMouse(at({ button: 'wheel', action: 'down' }), 'vt200', 'sgr')).toBe(
      '\x1b[<65;10;5M'
    )
    expect(encodeMouse(at({}), 'none', 'sgr')).toBeNull()
    expect(encodeMouse(at({}), 'vt200', 'sgr-pixels')).toBe('\x1b[<0;77;90M')
  })

  test('the screen follows the encoding a program selects', async () => {
    const screen = new TerminalScreen({ cols: 20, rows: 5, theme: terminalThemeFor('termul') })
    expect(screen.mouseEncoding).toBe('default')
    await write(screen, '\x1b[?1000h\x1b[?1006h')
    expect([screen.modes.mouseTrackingMode, screen.mouseEncoding]).toEqual(['vt200', 'sgr'])
    await write(screen, '\x1b[?1006l')
    expect(screen.mouseEncoding).toBe('default')
    await write(screen, '\x1b[?1016h\x1bc')
    expect([screen.modes.mouseTrackingMode, screen.mouseEncoding]).toEqual(['none', 'default'])
  })
})
