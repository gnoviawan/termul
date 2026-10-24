/**
 * The slice of CSS value syntax Termul's tokens and arbitrary Tailwind values
 * use: var() substitution, colours (hex, rgb(), oklch(), oklab(), color-mix()),
 * lengths (px, rem, em, %, calc()) and box-shadow lists. Colours resolve to
 * sRGB the way Chromium paints them: convert, clip each channel, round to 8 bits.
 */

/** sRGB channels 0..1 and alpha 0..1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export type CssVars = Readonly<Record<string, string>>

const ROOT_FONT_SIZE = 16

/** Replace var(--x, fallback) with its value until none are left. */
export function substituteVars(value: string, vars: CssVars, depth = 0): string {
  if (depth > 8 || !value.includes('var(')) return value
  let out = ''
  let i = 0
  while (i < value.length) {
    const at = value.indexOf('var(', i)
    if (at < 0) {
      out += value.slice(i)
      break
    }
    out += value.slice(i, at)
    const close = matchingParen(value, at + 3)
    const inner = value.slice(at + 4, close)
    const comma = topLevelIndex(inner, ',')
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma < 0 ? undefined : inner.slice(comma + 1).trim()
    const resolved = vars[name] ?? fallback
    if (resolved === undefined) throw new Error(`unknown CSS variable ${name}`)
    out += resolved
    i = close + 1
  }
  return substituteVars(out, vars, depth + 1)
}

function matchingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  throw new Error(`unbalanced parentheses in ${text}`)
}

function topLevelIndex(text: string, char: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') depth--
    else if (depth === 0 && text[i] === char) return i
  }
  return -1
}

/** Split at a top-level separator: ',' or whitespace (' '). */
export function splitTopLevel(text: string, separator: ',' | ' '): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth++
    if (char === ')') depth--
    const splits = depth === 0 && (separator === ',' ? char === ',' : /\s/.test(char))
    if (splits) {
      if (current.trim()) parts.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

type Lab = [number, number, number]

function oklabToRgb([l, a, b]: Lab): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    linearToSrgb(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    linearToSrgb(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    linearToSrgb(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)
  ]
}

function rgbToOklab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

function clip01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Parse "0.5", "50%", "none". */
function number(part: string, percentScale = 1): number {
  if (part === 'none') return 0
  if (part.endsWith('%')) return (Number.parseFloat(part) / 100) * percentScale
  const value = Number.parseFloat(part)
  if (Number.isNaN(value)) throw new Error(`not a number: ${part}`)
  return value
}

/** "L C H / a" style argument lists, slash optional. */
function channelsAndAlpha(args: string): { channels: string[]; alpha: number } {
  const slash = topLevelIndex(args, '/')
  const head = slash < 0 ? args : args.slice(0, slash)
  const channels = splitTopLevel(head.replace(/,/g, ' '), ' ')
  const alpha =
    slash < 0
      ? channels[3] === undefined
        ? 1
        : number(channels[3])
      : number(args.slice(slash + 1).trim())
  return { channels: channels.slice(0, 3), alpha }
}

function fromOklch(l: number, c: number, h: number, alpha: number): Rgba {
  const rad = (h * Math.PI) / 180
  return fromOklab([l, c * Math.cos(rad), c * Math.sin(rad)], alpha)
}

function fromOklab(lab: Lab, alpha: number): Rgba {
  const [r, g, b] = oklabToRgb(lab).map(clip01)
  return { r, g, b, a: clip01(alpha) }
}

function parseHex(hex: string): Rgba {
  const digits = hex.slice(1)
  const full =
    digits.length <= 4
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) throw new Error(`bad hex colour ${hex}`)
  const byte = (i: number) => Number.parseInt(full.slice(i, i + 2), 16) / 255
  return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) : 1 }
}

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 1, g: 1, b: 1, a: 1 }
}

/** Mix two colours like CSS color-mix(): premultiplied, in oklab or srgb. */
export function mixColors(a: Rgba, b: Rgba, weightB: number, space: 'oklab' | 'srgb'): Rgba {
  const alpha = a.a * (1 - weightB) + b.a * weightB
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const toSpace = (c: Rgba): Lab =>
    space === 'oklab' ? rgbToOklab(c.r, c.g, c.b) : [c.r, c.g, c.b]
  const pa = toSpace(a).map((v) => v * a.a)
  const pb = toSpace(b).map((v) => v * b.a)
  const mixed = pa.map((v, i) => (v * (1 - weightB) + pb[i] * weightB) / alpha) as Lab
  if (space === 'oklab') return fromOklab(mixed, alpha)
  const [r, g, bl] = mixed.map(clip01)
  return { r, g, b: bl, a: alpha }
}

function parseMix(args: string, vars: CssVars): Rgba {
  const [method, first, second] = splitTopLevel(args, ',')
  const space = method.replace(/^in\s+/, '').trim()
  const side = (part: string) => {
    const pieces = splitTopLevel(part, ' ')
    const pct = pieces.find((p) => /^[\d.]+%$/.test(p))
    const color = pieces.filter((p) => p !== pct).join(' ')
    return { color: parseColor(color, vars), pct: pct === undefined ? undefined : number(pct) }
  }
  const a = side(first)
  const b = side(second)
  const weightB = b.pct ?? (a.pct === undefined ? 0.5 : 1 - a.pct)
  const weightA = a.pct ?? 1 - weightB
  const total = weightA + weightB
  // oklch mixes are treated as oklab: the same for the near-neutral and
  // same-hue pairs Termul mixes, without hue-arc bookkeeping.
  const mixed = mixColors(a.color, b.color, weightB / total, space === 'srgb' ? 'srgb' : 'oklab')
  return total < 1 ? { ...mixed, a: mixed.a * total } : mixed
}

/** Any colour Termul writes, with var() already allowed inside. */
export function parseColor(value: string, vars: CssVars = {}): Rgba {
  const text = substituteVars(value.trim(), vars).trim().toLowerCase()
  if (text.startsWith('#')) return parseHex(text)
  if (text in NAMED) return NAMED[text]
  const open = text.indexOf('(')
  if (open < 0) throw new Error(`unsupported colour ${value}`)
  const fn = text.slice(0, open)
  const args = text.slice(open + 1, matchingParen(text, open))
  if (fn === 'color-mix') return parseMix(args, vars)
  const { channels, alpha } = channelsAndAlpha(args)
  if (fn === 'oklch')
    return fromOklch(number(channels[0]), number(channels[1], 0.4), number(channels[2]), alpha)
  if (fn === 'oklab')
    return fromOklab(
      [number(channels[0]), number(channels[1], 0.4), number(channels[2], 0.4)],
      alpha
    )
  if (fn === 'rgb' || fn === 'rgba') {
    const [r, g, b] = channels.map((c) => clip01(number(c, 255) / 255))
    return { r, g, b, a: clip01(alpha) }
  }
  throw new Error(`unsupported colour function ${fn}()`)
}

/** `#rrggbb`, or `#rrggbbaa` when translucent. 8-bit rounded like the browser. */
export function formatColor(color: Rgba): string {
  const byte = (v: number) =>
    Math.round(clip01(v) * 255)
      .toString(16)
      .padStart(2, '0')
  const rgb = `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`
  return color.a >= 1 ? rgb : `${rgb}${byte(color.a)}`
}

export function withAlpha(color: Rgba, alpha: number): Rgba {
  return { ...color, a: color.a * alpha }
}

/** A length in px: px, rem, em (against `fontSize`), unitless 0, calc(), min(), max(), env(). */
export function parseLength(value: string, vars: CssVars = {}, fontSize = ROOT_FONT_SIZE): number {
  const text = substituteVars(value.trim(), vars).trim()
  for (const [, unit] of text.matchAll(/[\d.]([a-z%]+)/g)) {
    if (unit !== 'px' && unit !== 'rem' && unit !== 'em')
      throw new Error(`unsupported length unit ${unit} in ${value}`)
  }
  if (text.startsWith('calc('))
    return evalCalc(text.slice(5, matchingParen(text, 4)), vars, fontSize)
  const fn = text.match(/^(min|max|env)\(/)
  if (fn) {
    const args = splitTopLevel(text.slice(fn[0].length, matchingParen(text, fn[0].length - 1)), ',')
    // A desktop window has no safe-area insets: env() is its fallback, else 0.
    if (fn[1] === 'env') return args[1] ? parseLength(args[1], vars, fontSize) : 0
    const lengths = args.map((arg) => parseLength(arg, vars, fontSize))
    return fn[1] === 'min' ? Math.min(...lengths) : Math.max(...lengths)
  }
  const match = text.match(/^(-?[\d.]+)(px|rem|em)?$/)
  if (!match) throw new Error(`unsupported length ${value}`)
  const n = Number.parseFloat(match[1])
  if (match[2] === 'rem') return n * ROOT_FONT_SIZE
  if (match[2] === 'em') return n * fontSize
  if (match[2] === undefined && n !== 0) throw new Error(`unitless length ${value}`)
  return n
}

/** calc() over px/rem lengths and plain numbers with + - * /. */
function evalCalc(expr: string, vars: CssVars, fontSize: number): number {
  // A minus is an operator token, so Tailwind's spaceless `calc(800px-2rem)`
  // subtracts; a leading or post-operator minus negates in `factor`.
  const tokens = expr.match(/[\d.]+(?:px|rem|em)?|[-+*/()]/g) ?? []
  let pos = 0
  const term = (): number => {
    let value = factor()
    while (tokens[pos] === '*' || tokens[pos] === '/') {
      const op = tokens[pos++]
      const rhs = factor()
      value = op === '*' ? value * rhs : value / rhs
    }
    return value
  }
  const factor = (): number => {
    const token = tokens[pos++]
    if (token === '-') return -factor()
    if (token === '(') {
      const value = sum()
      pos++
      return value
    }
    return /[a-z]$/.test(token) ? parseLength(token, vars, fontSize) : Number.parseFloat(token)
  }
  const sum = (): number => {
    let value = term()
    while (tokens[pos] === '+' || tokens[pos] === '-') {
      const op = tokens[pos++]
      const rhs = term()
      value = op === '+' ? value + rhs : value - rhs
    }
    return value
  }
  return sum()
}

export interface CssShadow {
  offsetX: number
  offsetY: number
  blurRadius: number
  spreadRadius: number
  color: Rgba
  inset: boolean
}

/** A CSS box-shadow list such as `0 1px 2px #0003, inset 0 1px 0 oklch(1 0 0/0.3)`. */
export function parseShadowList(value: string, vars: CssVars = {}): CssShadow[] {
  const text = substituteVars(value, vars)
  if (text.trim() === 'none') return []
  return splitTopLevel(text, ',').map((one) => {
    const parts = splitTopLevel(one, ' ')
    const inset = parts.includes('inset')
    const lengths: number[] = []
    let color: Rgba = { r: 0, g: 0, b: 0, a: 1 }
    for (const part of parts) {
      if (part === 'inset') continue
      if (/^-?[\d.]+(px|rem|em)?$/.test(part)) lengths.push(parseLength(part, vars))
      else color = parseColor(part, vars)
    }
    const [offsetX = 0, offsetY = 0, blurRadius = 0, spreadRadius = 0] = lengths
    return { offsetX, offsetY, blurRadius, spreadRadius, color, inset }
  })
}
