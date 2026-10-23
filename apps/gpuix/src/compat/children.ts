/**
 * DOM children -> GPUIX children for one element, at creation time.
 *
 * GPUIX has no inline formatting context: sibling text runs stack like blocks
 * (measured). So a parent looks at the children it was handed and picks:
 *
 * - all text: one string, one text node;
 * - text plus unstyled inline leaves: merged into that one string;
 * - flex container: each contiguous text run is one flex item, as in CSS;
 * - block content: each text run is its own block;
 * - mixed inline content: the parent becomes a wrapping row and loose text
 *   splits into one `<text>` per word, so lines still break between words.
 *
 * Every slot of a children array keeps its index and its key (merged text
 * leaves `null` behind), so neither a conditional sibling in a static array
 * nor a keyed dynamic list changes how React matches children.
 */

import type { StyleDesc } from '@gpuix/react'
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { applyTextTransform, type AutoMargin, type Translation } from './translate'

/** What a parent may know about a child element the compat layer created. */
export interface ChildInfo {
  inline: boolean
  /** A text leaf with no box and no listeners: its text and style. */
  run?: { text: string; style: StyleDesc }
  /** The child asked for auto margins and was wrapped; the parent may re-style the wrapper. */
  autoMargin?: { margin: AutoMargin; inner: ReactElement }
}

export const childInfo = new WeakMap<object, ChildInfo>()

type Slot = ReactNode

const SPACE = /\s+/g

function isText(node: unknown): node is string | number {
  return typeof node === 'string' || typeof node === 'number'
}

function isEmpty(node: unknown): boolean {
  return node === null || node === undefined || typeof node === 'boolean'
}

function collapse(text: string): string {
  return text.replace(SPACE, ' ')
}

function infoOf(node: unknown): ChildInfo | undefined {
  return node !== null && typeof node === 'object' ? childInfo.get(node) : undefined
}

function hasKeys(style: StyleDesc): boolean {
  for (const _ in style) return true
  return false
}

const ROW_PUSH: Readonly<Record<string, StyleDesc>> = {
  left: { flexGrow: 1, display: 'flex', justifyContent: 'flex-end' },
  right: { flexGrow: 1, display: 'flex', justifyContent: 'flex-start' },
  x: { display: 'flex', justifyContent: 'center' }
}
const COLUMN_PUSH: Readonly<Record<string, StyleDesc>> = {
  left: { display: 'flex', justifyContent: 'flex-end' },
  right: { display: 'flex', justifyContent: 'flex-start' },
  x: { display: 'flex', justifyContent: 'center' },
  top: { flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' },
  bottom: { flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' },
  y: { flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }
}

function horizontal(m: AutoMargin): 'left' | 'right' | 'x' | null {
  if (m.left && m.right) return 'x'
  if (m.left) return 'left'
  if (m.right) return 'right'
  return null
}

function vertical(m: AutoMargin): 'top' | 'bottom' | 'y' | null {
  if (m.top && m.bottom) return 'y'
  if (m.top) return 'top'
  if (m.bottom) return 'bottom'
  return null
}

/**
 * The wrapper that stands in for `margin: auto`. Made by the child, which
 * does not know its parent: it assumes a flex row, the common case for
 * `ml-auto`. A parent that sees it re-styles it with {@link placeAutoMargin}.
 */
export function wrapAutoMargin(inner: ReactElement, margin: AutoMargin, key: unknown): ReactElement {
  const h = horizontal(margin)
  const style = h ? ROW_PUSH[h] : COLUMN_PUSH[vertical(margin) ?? 'y']
  const wrapper = jsx('div', { style, children: inner }, key as string | undefined)
  childInfo.set(wrapper, { inline: false, autoMargin: { margin, inner } })
  return wrapper
}

function placeAutoMargin(node: ReactElement, info: NonNullable<ChildInfo['autoMargin']>, row: boolean): ReactElement {
  if (row) return node
  const h = horizontal(info.margin)
  const v = vertical(info.margin)
  const style = h ? COLUMN_PUSH[h] : v ? COLUMN_PUSH[v] : undefined
  return style ? cloneElement(node as ReactElement<{ style?: StyleDesc }>, { style }) : node
}

function words(text: string, key: number, leading: boolean, trailing: boolean): ReactElement[] {
  const body = collapse(text)
  const parts = body.trim().split(' ')
  return parts.map((word, i) => {
    let run = word
    if (i === 0 && leading && body.startsWith(' ')) run = ` ${run}`
    if (i < parts.length - 1 || (trailing && body.endsWith(' '))) run = `${run} `
    return jsx('text', { children: run }, `w${key}.${i}`)
  })
}

export interface Laid {
  children: ReactNode
  /** Style the parent must add to lay its inline content out as wrapping lines. */
  runStyle?: StyleDesc
  isStatic: boolean
}

const RUN_WRAP: StyleDesc = { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' }
const RUN_NOWRAP: StyleDesc = { display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'flex-start' }

function runStyleFor(tr: Translation, style: StyleDesc): StyleDesc {
  const base = tr.nowrap || style.whiteSpace === 'nowrap' ? RUN_NOWRAP : RUN_WRAP
  const align = style.textAlign
  if (align === 'center') return { ...base, justifyContent: 'center' }
  if (align === 'right') return { ...base, justifyContent: 'flex-end' }
  return base
}

const MARKER_ROW: StyleDesc = { position: 'relative' }
const INSIDE_ROW: StyleDesc = { display: 'flex', flexDirection: 'row', alignItems: 'baseline' }
const INSIDE_BODY: StyleDesc = { flexGrow: 1, flexShrink: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }
const INSIDE_DISC: StyleDesc = { width: 16, flexShrink: 0 }
const DISC: StyleDesc = { position: 'absolute', left: -14, top: 0 }
const DECIMAL: StyleDesc = { position: 'absolute', left: -26, top: 0, width: 20, textAlign: 'right' }

/** CSS list markers: `list-outside` hangs the marker in the list's padding, `list-inside` puts it in the line. */
function withMarkers(slots: Slot[], marker: 'disc' | 'decimal', inside: boolean): Slot[] {
  let n = 0
  return slots.map((slot, i) => {
    if (isEmpty(slot) || (isText(slot) && String(slot).trim() === '')) return null
    n++
    const label = marker === 'disc' ? '•' : `${n}.`
    const key = isValidElement(slot) && slot.key !== null ? slot.key : `m${i}`
    if (inside) {
      const glyph = jsx('text', { style: INSIDE_DISC, children: label })
      return jsxs('div', { style: INSIDE_ROW, children: [glyph, jsx('div', { style: INSIDE_BODY, children: slot })] }, key)
    }
    const glyph = jsx('text', { style: marker === 'disc' ? DISC : DECIMAL, children: label })
    return jsxs('div', { style: MARKER_ROW, children: [glyph, slot] }, key)
  })
}

/**
 * Lay out `children` for an element translated as `tr` whose final style is
 * `style`. `isStatic` is whether the caller used `jsxs` (a fixed children
 * array, positions are identity) or `jsx` (one child, or a dynamic array the
 * caller keyed).
 */
export function layoutChildren(tr: Translation, style: StyleDesc, children: ReactNode, isStatic: boolean): Laid {
  if (isEmpty(children)) return { children: undefined, isStatic: false }
  if (tr.reverse && Array.isArray(children)) children = [...children].reverse()
  if (isText(children)) {
    const text = applyTextTransform(tr.inline ? collapse(String(children)) : collapse(String(children)).trim(), tr.transform)
    return { children: text === '' ? undefined : text, isStatic: false }
  }
  if (!Array.isArray(children)) {
    const info = infoOf(children)
    if (info?.autoMargin && isValidElement(children)) {
      return { children: placeAutoMargin(children, info.autoMargin, tr.flexDirection === 'row'), isStatic: false }
    }
    if (tr.listMarker) return { children: withMarkers([children], tr.listMarker, tr.listInside), isStatic: true }
    // A span's content is inline by definition, whatever the component renders.
    if (tr.inline && style.display === undefined && isValidElement(children) && !info) {
      return { children, runStyle: runStyleFor(tr, style), isStatic: false }
    }
    return { children, isStatic: false }
  }

  const slots = children as Slot[]
  let texts = 0
  let blocks = 0
  let styledInline = 0
  for (const slot of slots) {
    if (isEmpty(slot)) continue
    if (isText(slot)) {
      texts++
      continue
    }
    if (Array.isArray(slot)) {
      blocks++
      continue
    }
    const info = infoOf(slot)
    if (!info) {
      styledInline++
      continue
    }
    if (!info.inline) blocks++
    else if (!info.run || hasKeys(info.run.style)) styledInline++
  }

  const out: Slot[] = slots.slice()
  const flex = style.display === 'flex' || style.display === 'grid'

  if (tr.listMarker) return { children: withMarkers(out, tr.listMarker, tr.listInside), isStatic }

  if (texts === 0 && blocks === 0 && styledInline > 0 && tr.inline && !flex) {
    return { children: out, runStyle: runStyleFor(tr, style), isStatic }
  }

  if (flex || blocks > 0 || texts === 0) {
    // Flex items, or block flow: contiguous text is one anonymous box.
    const row = style.display === 'flex' && style.flexDirection !== 'column' && style.flexDirection !== 'column-reverse'
    let first = -1
    for (let i = 0; i <= out.length; i++) {
      const slot = out[i]
      if (i < out.length && isText(slot)) {
        if (first < 0) first = i
        continue
      }
      if (first >= 0) {
        const joined = collapse(slots.slice(first, i).join(''))
        const text = joined.trim() === '' ? null : applyTextTransform(flex ? joined.trim() : joined.trim(), tr.transform)
        out[first] = text
        for (let j = first + 1; j < i; j++) out[j] = null
        first = -1
      }
      const info = i < out.length ? infoOf(slot) : undefined
      if (info?.autoMargin && isValidElement(slot)) out[i] = placeAutoMargin(slot, info.autoMargin, row)
    }
    return { children: out, isStatic }
  }

  if (styledInline === 0) {
    // Text and unstyled inline leaves: one string.
    let joined = ''
    for (const slot of slots) {
      if (isText(slot)) joined += String(slot)
      else if (!isEmpty(slot)) joined += infoOf(slot)?.run?.text ?? ''
    }
    const text = applyTextTransform(collapse(joined).trim(), tr.transform)
    return { children: text === '' ? undefined : text, isStatic: false }
  }

  // Mixed inline content: a wrapping row of word runs and inline boxes.
  const nowrap = tr.nowrap || style.whiteSpace === 'nowrap'
  const lastFilled = out.reduce<number>((last, slot, i) => (isEmpty(slot) ? last : i), -1)
  let seen = false
  for (let i = 0; i < out.length; i++) {
    const slot = out[i]
    if (isEmpty(slot)) continue
    if (isText(slot)) {
      const text = applyTextTransform(String(slot), tr.transform)
      if (collapse(text).trim() === '') {
        out[i] = seen && i < lastFilled ? jsx('text', { children: ' ' }, `s${i}`) : null
      } else if (nowrap) {
        out[i] = jsx('text', { children: collapse(text) }, `r${i}`)
      } else {
        out[i] = words(text, i, seen, i < lastFilled)
      }
    }
    seen = true
  }
  return { children: out, runStyle: runStyleFor(tr, style), isStatic }
}

function isBlock(node: unknown): boolean {
  const info = infoOf(node)
  return info !== undefined && !info.inline
}

/**
 * A fragment's whitespace between block children (react-markdown puts "\n"
 * between `<p>` and `<ul>`). The DOM collapses it; a GPUIX text node would
 * paint an empty line. Slots keep their index.
 */
export function dropBlockWhitespace(children: unknown): unknown {
  if (!Array.isArray(children)) return children
  let out: unknown[] | null = null
  for (let i = 0; i < children.length; i++) {
    const slot = children[i]
    if (typeof slot !== 'string' || slot.trim() !== '') continue
    // A newline-only string between two elements is markup whitespace (hast
    // keeps it between blocks); inline spaces come as ' ' or inside text.
    if (slot.includes('\n') || isBlock(children[i - 1]) || isBlock(children[i + 1])) {
      out ??= children.slice()
      out[i] = null
    }
  }
  return out ?? children
}
