/**
 * Cell colour resolution with xterm.js semantics (xterm/src/browser/
 * ColorManager + renderer/shared/CellColorResolver): the 16 theme colours,
 * the 6x6x6 cube and the grey ramp for 16..255, 24-bit RGB, bold-to-bright,
 * inverse, dim as 50% alpha and invisible as the background.
 */

/** The xterm `ITheme` fields the view reads (the app's `paletteToXtermTheme` fills every one). */
export interface TerminalTheme {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

export interface TerminalPalette {
  foreground: string
  background: string
  cursor: string
  cursorAccent: string
  selection: string
  /** Colours 0..255 as `#rrggbb`. */
  ansi: string[]
}

const CUBE_LEVELS = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

export const rgbToHex = (r: number, g: number, b: number): string =>
  `#${hex2(r)}${hex2(g)}${hex2(b)}`

export function buildPalette(theme: TerminalTheme): TerminalPalette {
  const named = [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite
  ]
  const ansi: string[] = named.map((color, i) => {
    if (!color) throw new Error(`terminal theme lacks ansi colour ${i}`)
    return color.toLowerCase()
  })
  for (let i = 0; i < 216; i++) {
    const r = CUBE_LEVELS[Math.floor(i / 36)]!
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6]!
    const b = CUBE_LEVELS[i % 6]!
    ansi.push(rgbToHex(r, g, b))
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    ansi.push(rgbToHex(v, v, v))
  }
  const need = (value: string | undefined, name: string): string => {
    if (!value) throw new Error(`terminal theme lacks ${name}`)
    return value.toLowerCase()
  }
  return {
    foreground: need(theme.foreground, 'foreground'),
    background: need(theme.background, 'background'),
    cursor: need(theme.cursor, 'cursor'),
    cursorAccent: need(theme.cursorAccent, 'cursorAccent'),
    selection: need(theme.selectionBackground, 'selectionBackground'),
    ansi
  }
}

/** The subset of `IBufferCell` the resolver reads. */
export interface CellAttributes {
  isFgDefault(): boolean
  isFgPalette(): boolean
  isFgRGB(): boolean
  getFgColor(): number
  isBgDefault(): boolean
  isBgPalette(): boolean
  isBgRGB(): boolean
  getBgColor(): number
  isBold(): number
  isInverse(): number
  isDim(): number
  isInvisible(): number
}

export interface ResolvedColors {
  /** `#rrggbb` or `#rrggbbaa` when dim. */
  fg: string
  /** `null` when the cell uses the terminal background. */
  bg: string | null
}

const rgb24ToHex = (value: number): string => `#${(value & 0xffffff).toString(16).padStart(6, '0')}`

export function resolveCellColors(cell: CellAttributes, palette: TerminalPalette): ResolvedColors {
  let fg: string
  if (cell.isFgRGB()) fg = rgb24ToHex(cell.getFgColor())
  else if (cell.isFgPalette()) {
    let index = cell.getFgColor()
    if (cell.isBold() && index < 8) index += 8
    fg = palette.ansi[index]!
  } else fg = palette.foreground
  let bg: string | null
  if (cell.isBgRGB()) bg = rgb24ToHex(cell.getBgColor())
  else if (cell.isBgPalette()) bg = palette.ansi[cell.getBgColor()]!
  else bg = null
  if (cell.isInverse()) {
    const swapped = bg ?? palette.background
    bg = fg
    fg = swapped
  }
  if (cell.isInvisible()) fg = bg ?? palette.background
  else if (cell.isDim()) fg = `${fg}80`
  return { fg, bg }
}
