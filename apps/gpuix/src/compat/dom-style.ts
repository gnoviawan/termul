/**
 * React DOM `style={{…}}` -> StyleDesc. Lengths become px numbers, colours
 * resolve through the theme's custom properties, and what GPUIX cannot paint
 * is dropped and counted (`compatWarn`).
 */

import type { StyleDesc } from '@gpuix/react'
import { formatColor, parseColor, parseLength } from '../style/css-value'
import { parseGridTracks } from '../style/grid-tracks'
import { compatWarn } from './log'
import { compatTw } from './translate'

type CssValue = string | number | undefined | null

const COLOR_KEYS = new Set(['color', 'backgroundColor', 'borderColor', 'outlineColor'])
const UNSUPPORTED = new Set([
  'transform', 'transition', 'transitionDuration', 'transitionDelay', 'animation', 'zIndex',
  'willChange', 'backdropFilter', 'filter', 'mask', 'maskImage', 'clipPath', 'contain',
  'transformOrigin', 'scrollbarGutter', 'overscrollBehavior', 'touchAction'
])
const PASS_STRING = new Set([
  'display', 'position', 'flexDirection', 'flexWrap', 'alignItems', 'alignSelf', 'alignContent',
  'justifyContent', 'overflow', 'overflowX', 'overflowY', 'textAlign', 'whiteSpace', 'textOverflow',
  'cursor', 'pointerEvents', 'userSelect', 'visibility', 'textDecoration', 'fontFamily'
])
const BOX_SHADOW_DEFAULTS = { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 0 }

function length(value: CssValue): number | string | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === 'auto') return 'auto'
  if (trimmed.endsWith('%')) return trimmed
  try {
    return parseLength(trimmed, compatTw().theme.vars)
  } catch {
    return undefined
  }
}

function color(value: CssValue): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return formatColor(parseColor(value, compatTw().theme.vars))
  } catch {
    return undefined
  }
}

/** GPUIX rejects a partial shadow object; fill the fields CSS defaults. */
export function normalizeShadow(value: unknown): StyleDesc['boxShadow'] {
  const fill = (shadow: Record<string, unknown>) => ({ ...BOX_SHADOW_DEFAULTS, ...shadow })
  if (Array.isArray(value)) return value.map(fill) as StyleDesc['boxShadow']
  if (value && typeof value === 'object') return [fill(value as Record<string, unknown>)] as StyleDesc['boxShadow']
  return undefined
}

const cache = new WeakMap<object, StyleDesc>()

const EQUAL_COLUMNS = /^repeat\(\s*(\d+)\s*,\s*(?:minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)|1fr)\s*\)$/

export function convertDomStyle(style: Readonly<Record<string, CssValue>>): StyleDesc {
  const hit = cache.get(style)
  if (hit) return hit
  const out: Record<string, unknown> = {}
  for (const key in style) {
    const value = style[key]
    if (value === undefined || value === null || value === '') continue
    if (key.startsWith('--')) continue
    if (UNSUPPORTED.has(key)) {
      compatWarn('style-unsupported', key)
      continue
    }
    if (COLOR_KEYS.has(key)) {
      const c = color(value)
      if (c) out[key] = c
      else compatWarn('style-color', `${key}: ${String(value).slice(0, 40)}`)
    } else if (key === 'boxShadow') {
      if (typeof value === 'object') out.boxShadow = normalizeShadow(value)
      else compatWarn('style-unsupported', 'boxShadow string')
    } else if (key === 'opacity' || key === 'flexGrow' || key === 'flexShrink' || key === 'fontWeight' || key === 'aspectRatio') {
      const n = typeof value === 'number' ? value : Number.parseFloat(value)
      if (Number.isFinite(n)) out[key] = n
    } else if (key === 'flex') {
      const n = typeof value === 'number' ? value : Number.parseFloat(value)
      if (Number.isFinite(n)) Object.assign(out, { flexGrow: n, flexShrink: 1, flexBasis: 0 })
    } else if (key === 'gridTemplateColumns') {
      // GPUIX takes a column count: `repeat(N, minmax(0, 1fr))` or `repeat(N, 1fr)`.
      // Any other track list is laid out by compat/grid.ts.
      const n = typeof value === 'number' ? value : Number(EQUAL_COLUMNS.exec(String(value))?.[1])
      const tracks = Number.isInteger(n) ? undefined : parseGridTracks(String(value), compatTw().theme.vars)
      if (Number.isInteger(n) && n > 0) out[key] = n
      else if (tracks) Object.assign(out, { gridTemplateColumns: tracks.length, gridTracks: tracks })
      else compatWarn('style-value', `${key}: ${String(value).slice(0, 40)}`)
    } else if (PASS_STRING.has(key)) {
      out[key] = value
    } else {
      const l = length(value)
      if (l !== undefined) out[key] = l
      else compatWarn('style-value', `${key}: ${String(value).slice(0, 40)}`)
    }
  }
  const result = out as StyleDesc
  cache.set(style, result)
  return result
}
