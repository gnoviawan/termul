import { describe, expect, test } from 'bun:test'
import { TerminalScreen } from './screen'
import { terminalThemeFor } from './theme'

async function repliesTo(query: string): Promise<string> {
  const screen = new TerminalScreen({ cols: 20, rows: 2, theme: terminalThemeFor('termul') })
  let out = ''
  screen.terminal.onData((data) => {
    out += data
  })
  await new Promise<void>((done) => screen.write(query, done))
  return out
}

describe('colour query replies', () => {
  // The same bytes xterm.js sent from the web client for vim's queries (termul theme).
  test('OSC 10 and 11 report foreground and background', async () => {
    expect(await repliesTo('\x1b]10;?\x07\x1b]11;?\x1b\\')).toBe(
      '\x1b]10;rgb:e5e5/e5e5/e6e6\x1b\\\x1b]11;rgb:0808/0909/0a0a\x1b\\'
    )
  })

  test('OSC 10;?;? walks the dynamic colour list', async () => {
    expect(await repliesTo('\x1b]10;?;?\x07')).toBe(
      '\x1b]10;rgb:e5e5/e5e5/e6e6\x1b\\\x1b]11;rgb:0808/0909/0a0a\x1b\\'
    )
  })

  test('OSC 4 reports palette entries', async () => {
    expect(await repliesTo('\x1b]4;196;?;21;?\x07')).toBe(
      '\x1b]4;196;rgb:ffff/0000/0000\x1b\\\x1b]4;21;rgb:0000/0000/ffff\x1b\\'
    )
  })

  test('CSI ? 996 n reports a dark scheme', async () => {
    expect(await repliesTo('\x1b[?996n')).toBe('\x1b[?997;1n')
  })

  test('a set request is not answered', async () => {
    expect(await repliesTo('\x1b]11;#ffffff\x07')).toBe('')
  })
})
