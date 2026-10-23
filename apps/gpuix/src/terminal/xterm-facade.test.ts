import { describe, expect, test } from 'bun:test'
import { cacheTerminal, takeCachedTerminal } from '@/components/terminal/terminal-cache'
import { applyThemeToTerminal } from '@/lib/themes/apply-theme-to-terminal'
import {
  extractScrollback,
  getTerminalModes,
  registerTerminal,
  unregisterTerminal
} from '@/utils/terminal-registry'
import { TerminalScreen } from './screen'
import { terminalThemeFor } from './theme'
import { asXterm, screenOf } from './xterm-facade'

const write = (screen: TerminalScreen, data: string) =>
  new Promise<void>((done) => screen.write(data, done))

describe('xterm facade in the shared terminal modules', () => {
  test('registry: scrollback extraction and DEC mode tracking read the native screen', async () => {
    const screen = new TerminalScreen({ cols: 20, rows: 3, theme: terminalThemeFor('termul') })
    registerTerminal('pty-1', asXterm(screen))
    await write(screen, 'one\r\ntwo\r\nthree\r\nfour\x1b[?2004h')
    expect(extractScrollback('pty-1')).toEqual([
      `one${' '.repeat(17)}`,
      `two${' '.repeat(17)}`,
      `three${' '.repeat(15)}`,
      `four${' '.repeat(16)}`
    ])
    expect(getTerminalModes('pty-1')?.bracketedPaste).toBe(true)
    unregisterTerminal('pty-1')
  })

  test('cache: a cached facade comes back as the same screen, buffer intact', async () => {
    const screen = new TerminalScreen({ cols: 20, rows: 3, theme: terminalThemeFor('termul') })
    await write(screen, 'kept')
    cacheTerminal('pty-2', asXterm(screen))
    const back = screenOf(takeCachedTerminal('pty-2'))
    expect(back).toBe(screen)
    expect(back?.visibleText()[0]).toBe('kept')
    expect(takeCachedTerminal('pty-2')).toBeUndefined()
  })

  test('theme: applyThemeToTerminal repaints the screen with the new palette', () => {
    const screen = new TerminalScreen({ cols: 4, rows: 1, theme: terminalThemeFor('termul') })
    applyThemeToTerminal(asXterm(screen), { ...terminalThemeFor('termul'), background: '#123456' })
    expect(screen.palette.background).toBe('#123456')
  })

  test('find selects the next match and wraps', async () => {
    const screen = new TerminalScreen({ cols: 20, rows: 3, theme: terminalThemeFor('termul') })
    await write(screen, 'ab x ab\r\nzz ab')
    expect(screen.find('ab')).toBe(true)
    expect(screen.getSelection()).toEqual({ anchor: { row: 0, col: 0 }, head: { row: 0, col: 2 } })
    screen.find('ab')
    expect(screen.getSelection()?.anchor).toEqual({ row: 0, col: 5 })
    screen.find('ab')
    expect(screen.getSelection()?.anchor).toEqual({ row: 1, col: 3 })
    screen.find('ab')
    expect(screen.getSelection()?.anchor).toEqual({ row: 0, col: 0 })
    expect(screen.find('ab', true)).toBe(true)
    expect(screen.getSelection()?.anchor).toEqual({ row: 1, col: 3 })
    expect(screen.find('nope')).toBe(false)
  })
})
