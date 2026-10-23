import { describe, expect, test } from 'bun:test'
import { encodeKey, encodePaste } from './keys'
import { TerminalScreen } from './screen'
import { terminalThemeFor } from './theme'

const write = (screen: TerminalScreen, data: string) =>
  new Promise<void>((done) => screen.write(data, done))

describe('TerminalScreen', () => {
  test('flattens styled cells into runs with xterm colour semantics', async () => {
    const screen = new TerminalScreen({ cols: 20, rows: 3, theme: terminalThemeFor('termul') })
    await write(screen, 'ab\x1b[1;31mcd\x1b[0m\x1b[38;2;1;2;3me\x1b[7mf\x1b[0m\x1b[2mg\x1b[0m')
    const frame = screen.frame()
    const runs = frame.rows_[0]!.runs.map((r) => [r.text, r.fg, r.bg, r.bold])
    expect(runs).toEqual([
      ['ab', '#e5e5e6', null, false],
      ['cd', '#f16060', null, true],
      ['e', '#010203', null, false],
      ['f', '#08090a', '#010203', false],
      ['g', '#e5e5e680', null, false],
      [' '.repeat(13), '#e5e5e6', null, false]
    ])
    expect(frame.cursor).toEqual({ x: 7, y: 0, visible: true, char: ' ' })
    expect(screen.visibleText()).toEqual(['abcdefg', '', ''])
  })

  test('256-colour cube and grey ramp match xterm', async () => {
    const screen = new TerminalScreen({ cols: 10, rows: 1, theme: terminalThemeFor('termul') })
    await write(screen, '\x1b[38;5;196ma\x1b[38;5;244mb\x1b[48;5;21mc')
    const runs = screen.frame().rows_[0]!.runs
    expect(runs[0]!.fg).toBe('#ff0000')
    expect(runs[1]!.fg).toBe('#808080')
    expect(runs[2]!.bg).toBe('#0000ff')
  })

  test('scrollback, wheel offset and selection text', async () => {
    const screen = new TerminalScreen({ cols: 10, rows: 2, theme: terminalThemeFor('termul') })
    await write(screen, 'one\r\ntwo\r\nthree\r\nfour')
    expect(screen.visibleText()).toEqual(['three', 'four'])
    screen.scrollLines(-2)
    expect(screen.visibleText()).toEqual(['one', 'two'])
    screen.setSelection({ anchor: { row: 0, col: 1 }, head: { row: 1, col: 2 } })
    expect(screen.selectedText()).toBe('ne\ntw')
    expect(screen.frame().selection).toEqual([
      [1, 10],
      [0, 2]
    ])
    screen.scrollToBottom()
    expect(screen.frame().viewportY).toBe(2)
  })

  test('alternate screen and application cursor mode flow through', async () => {
    const screen = new TerminalScreen({ cols: 10, rows: 2, theme: terminalThemeFor('termul') })
    await write(screen, 'main\x1b[?1049h\x1b[Halt\x1b[?1h')
    expect(screen.visibleText()).toEqual(['alt', ''])
    expect(screen.modes.applicationCursorKeysMode).toBe(true)
    await write(screen, '\x1b[?1049l')
    expect(screen.visibleText()).toEqual(['main', ''])
  })

  test('wrapped long line keeps its continuation', async () => {
    const screen = new TerminalScreen({ cols: 5, rows: 3, theme: terminalThemeFor('termul') })
    await write(screen, '0123456789ab')
    expect(screen.visibleText()).toEqual(['01234', '56789', 'ab'])
    screen.setSelection({ anchor: { row: 0, col: 3 }, head: { row: 1, col: 2 } })
    expect(screen.selectedText()).toBe('3456')
  })
})

describe('encodeKey', () => {
  const send = (key: string, modifiers = {}, keyChar?: string) =>
    encodeKey({ key, keyChar, modifiers }, false)
  test('xterm key table for a non-mac platform', () => {
    expect(send('enter')).toEqual({ type: 'send', data: '\r' })
    expect(send('up')).toEqual({ type: 'send', data: '\x1b[A' })
    expect(encodeKey({ key: 'up' }, true)).toEqual({ type: 'send', data: '\x1bOA' })
    expect(send('up', { shift: true })).toEqual({ type: 'send', data: '\x1b[1;2A' })
    expect(send('c', { ctrl: true })).toEqual({ type: 'send', data: '\x03' })
    expect(send('x', { alt: true })).toEqual({ type: 'send', data: '\x1bx' })
    expect(send('f5')).toEqual({ type: 'send', data: '\x1b[15~' })
    expect(send('f1', { ctrl: true })).toEqual({ type: 'send', data: '\x1b[1;5P' })
    expect(send('backspace', { alt: true })).toEqual({ type: 'send', data: '\x1b\x7f' })
    expect(send('tab', { shift: true })).toEqual({ type: 'send', data: '\x1b[Z' })
    expect(send('a', { shift: true }, 'A')).toEqual({ type: 'send', data: 'A' })
    expect(send('pageup', { shift: true })).toEqual({ type: 'page', direction: -1 })
    expect(send('v', { ctrl: true, shift: true })).toEqual({ type: 'paste' })
    expect(send('c', { ctrl: true, shift: true })).toEqual({ type: 'copy' })
  })
  test('bracketed paste wraps and strips escapes', () => {
    expect(encodePaste('a\nb\x1b', true)).toBe('\x1b[200~a\rb\x1b[201~')
    expect(encodePaste('a\r\nb', false)).toBe('a\rb')
  })
})
