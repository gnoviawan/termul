/**
 * Answers to colour queries, which xterm.js sends from its browser layer
 * (`CoreBrowserTerminal._handleColorEvent`, `_reportColorScheme`) and
 * `@xterm/headless` leaves unanswered: OSC 4/10/11/12 with `?`, and
 * `CSI ? 996 n`. Programs such as vim and neovim read these to choose a
 * light or dark scheme. Set requests stay with xterm's own handlers.
 */
import type { Terminal } from '@xterm/headless'
import type { TerminalPalette } from './colors'

const ESC = '\x1b'
const ST = `${ESC}\\`

/** `#rrggbb` as xterm's 16-bit `rgb:rrrr/gggg/bbbb`. */
export function toRgbReport(hex: string): string | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)
  if (!match) return null
  const [, r, g, b] = match as unknown as [string, string, string, string]
  return `rgb:${r}${r}/${g}${g}/${b}${b}`.toLowerCase()
}

const DYNAMIC: Array<keyof Pick<TerminalPalette, 'foreground' | 'background' | 'cursor'>> = [
  'foreground',
  'background',
  'cursor'
]

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

export function installColorReports(terminal: Terminal, palette: () => TerminalPalette): void {
  const reply = (ident: string, hex: string | undefined) => {
    const rgb = hex ? toRgbReport(hex) : null
    if (rgb) terminal.input(`${ESC}]${ident};${rgb}${ST}`, false)
  }
  // OSC 10;?;? asks for 10 then 11 (xterm's dynamic colour list).
  DYNAMIC.forEach((_, offset) => {
    terminal.parser.registerOscHandler(10 + offset, (data) => {
      const parts = data.split(';')
      if (!parts.every((part) => part === '?')) return false
      parts.forEach((_, i) => {
        const slot = DYNAMIC[offset + i]
        if (slot) reply(String(10 + offset + i), palette()[slot])
      })
      return true
    })
  })
  terminal.parser.registerOscHandler(4, (data) => {
    const parts = data.split(';')
    if (parts.length % 2 !== 0) return false
    const pairs: Array<[number, string]> = []
    for (let i = 0; i < parts.length; i += 2) pairs.push([Number(parts[i]), parts[i + 1]!])
    if (
      !pairs.every(
        ([index, spec]) => spec === '?' && Number.isInteger(index) && index >= 0 && index < 256
      )
    )
      return false
    for (const [index] of pairs) reply(`4;${index}`, palette().ansi[index])
    return true
  })
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
    if (params[0] !== 996) return false
    const { foreground, background } = palette()
    terminal.input(`${ESC}[?997;${luminance(background) < luminance(foreground) ? 1 : 2}n`, false)
    return true
  })
}
