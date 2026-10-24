/**
 * `<input type="checkbox">` as Chromium paints it with `appearance: auto`:
 * a 13 px box (or the size its classes give it) with a 1 px border and a
 * check stroked in the accent colour's contrast. Native appearance ignores
 * border, background and radius classes, so only box sizing is taken from
 * the translation. Toggling lives in `events.ts` (`activateCheckable`).
 *
 * Colours are sampled from Chromium 1.63's own render of each state
 * (`color-scheme: dark` and `light`, at 12 and 16 px).
 */

import type { StyleDesc } from '@gpuix/react'
import type { ReactElement } from 'react'
import { jsx } from 'react/jsx-runtime'
import { compatDark } from './create'
import { compatTw } from './translate'

interface Look {
  fill: string
  border: string
  hoverBorder: string
  /** Hover moves the accent's HSL lightness by 0.11, up when it is above this. */
  lightenAbove: number
  disabledFill: string
  disabledBorder: string
  accent: string
  check: string
}

const DARK: Look = {
  fill: '#3b3b3b',
  border: '#858585',
  hoverBorder: '#acacac',
  lightenAbove: 0.55,
  disabledFill: '#3b3b3b',
  disabledBorder: '#626262',
  accent: '#99c8ff',
  check: '#3b3b3b'
}
const LIGHT: Look = {
  fill: '#ffffff',
  border: '#767676',
  hoverBorder: '#4f4f4f',
  lightenAbove: 0.75,
  disabledFill: '#f8f8f8',
  disabledBorder: '#d1d1d1',
  accent: '#0075ff',
  check: '#ffffff'
}

/** Chromium's check: (0.2, 0.5) to (0.4, 0.7) to (0.8, 0.2) of the box, stroked at 0.16 of its height. */
const CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M20 50 L40 70 L80 20" fill="none" stroke="#000" stroke-width="16"/></svg>'

const DEFAULT_SIZE = 13
const SIZING: readonly (keyof StyleDesc)[] = [
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'flexShrink', 'flexGrow',
  'marginLeft', 'marginRight', 'marginTop', 'marginBottom', 'alignSelf', 'position', 'left', 'right', 'top', 'bottom'
]

const ACCENT = /(?:^|\s)accent-([\w-]+(?:\/\d+)?)(?=\s|$)/

/** The colour an `accent-<token>` class names, through the same theme as `text-<token>`. */
function accentColor(className: string): string | undefined {
  const token = ACCENT.exec(className)?.[1]
  if (!token) return undefined
  const color = compatTw()(`text-${token}`).color
  return typeof color === 'string' ? color : undefined
}

const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i

function hue(p: number, q: number, t: number): number {
  const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t
  if (u < 1 / 6) return p + (q - p) * 6 * u
  if (u < 1 / 2) return q
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6
  return p
}

/** Chromium's hovered accent: HSL lightness 0.11 further from the middle, fitted to its renders of eight accents. */
function hovered(color: string, lightenAbove: number): string {
  const m = HEX.exec(color)
  if (!m) return color
  const n = Number.parseInt(m[1] as string, 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6
  const L = Math.min(1, Math.max(0, l > lightenAbove ? l + 0.11 : l - 0.11))
  const q = L < 0.5 ? L * (1 + s) : L + s - L * s
  const p = 2 * L - q
  const out = s === 0 ? [L, L, L] : [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)]
  return `#${out.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}${m[2] ?? ''}`
}

export function checkboxElement(
  className: string,
  style: StyleDesc,
  checked: boolean,
  disabled: boolean,
  native: Record<string, unknown>,
  key: string | undefined
): ReactElement {
  const look = compatDark() ? DARK : LIGHT
  const box: StyleDesc = {}
  for (const name of SIZING) if (style[name] !== undefined) (box as Record<string, unknown>)[name] = style[name]
  const width = typeof box.width === 'number' ? box.width : DEFAULT_SIZE
  const height = typeof box.height === 'number' ? box.height : DEFAULT_SIZE
  const accent = accentColor(className) ?? look.accent
  const fill = checked ? accent : disabled ? look.disabledFill : look.fill
  native.style = {
    ...box,
    width,
    height,
    flexShrink: box.flexShrink ?? 0,
    borderWidth: 1,
    borderColor: checked ? accent : disabled ? look.disabledBorder : look.border,
    borderRadius: Math.round((4 * Math.min(width, height)) / DEFAULT_SIZE) / 2,
    backgroundColor: fill,
    opacity: checked && disabled ? 0.5 : undefined,
    hover: disabled
      ? undefined
      : checked
        ? { backgroundColor: hovered(accent, look.lightenAbove), borderColor: hovered(accent, look.lightenAbove) }
        : { borderColor: look.hoverBorder }
  }
  native.children = checked
    ? jsx('svg', { source: CHECK, style: { width: width - 2, height: height - 2, color: look.check } })
    : undefined
  return jsx('div', native, key)
}
