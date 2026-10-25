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
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { INHERITED_LEADING, ROOT_FONT_SIZE } from '../style/scale'
import type { Divide } from '../style/tw'
import { liftPlacement, placeStyle } from './placement'
import { applyTextTransform, type AutoMargin, type Translation, translation } from './translate'

/** What a parent may know about a child element the compat layer created. */
export interface ChildInfo {
  inline: boolean
  /** A text leaf with no box and no listeners: its text and style. */
  run?: { text: string; style: StyleDesc }
  /** The child asked for auto margins and was wrapped; the parent may re-style the wrapper. */
  autoMargin?: { margin: AutoMargin; inner: ReactElement }
  /** Absolutely positioned: painted after its in-flow siblings. */
  positioned?: boolean
  /** An inline-block whose baseline is its bottom margin edge: a textarea, which scrolls. */
  baselineAtBottom?: boolean
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

/** An in-flow flex item with a positive `flex-grow` that is not an auto-margin wrapper. */
function growsInFlow(slot: Slot): boolean {
  if (!isValidElement<{ style?: StyleDesc }>(slot)) return false
  const info = childInfo.get(slot)
  if (info?.autoMargin || info?.positioned) return false
  return (slot.props.style?.flexGrow ?? 0) > 0
}

/**
 * In a row the wrapper grows to stand in for the auto margin. CSS gives auto
 * margins only the space left after `flex-grow`, so when a sibling grows the
 * wrapper must not: sharing the free space squeezed a `flex-1` tab strip to
 * half the bar beside its `ml-auto` actions.
 */
function placeAutoMargin(
  node: ReactElement,
  info: NonNullable<ChildInfo['autoMargin']>,
  row: boolean,
  siblingGrows = false
): ReactElement {
  if (row) {
    if (!siblingGrows) return node
    const style = (node as ReactElement<{ style?: StyleDesc }>).props.style
    const held = cloneElement(node as ReactElement<{ style?: StyleDesc }>, { style: { ...style, flexGrow: 0 } })
    childInfo.set(held, { inline: false, autoMargin: info })
    return held
  }
  const h = horizontal(info.margin)
  const v = vertical(info.margin)
  const style = h ? COLUMN_PUSH[h] : v ? COLUMN_PUSH[v] : undefined
  if (!style) return node
  // In block flow a block box with `mx-auto` is as wide as the line allows (up
  // to its max-width) and the auto margins split what is left; in the flex
  // wrapper that is a growing item.
  const inner = info.inner as ReactElement<{ style?: StyleDesc }>
  const innerStyle = inner.props.style
  const fills = h !== null && childInfo.get(inner)?.inline !== true && innerStyle?.width === undefined
  if (!fills) return cloneElement(node as ReactElement<{ style?: StyleDesc }>, { style })
  const grown = cloneElement(inner, { style: { ...innerStyle, flexGrow: 1, flexShrink: 1, minWidth: 0 } })
  childInfo.set(grown, childInfo.get(inner) ?? { inline: false })
  return cloneElement(node as ReactElement<{ style?: StyleDesc }>, { style }, grown)
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
const INSIDE_ROW: StyleDesc = { display: 'flex', flexDirection: 'row', alignItems: 'flex-start' }
const INSIDE_BODY: StyleDesc = { flexGrow: 1, flexShrink: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }
const MARKER_BASE: Record<'inside' | 'disc' | 'decimal', StyleDesc> = {
  inside: { width: 16, flexShrink: 0 },
  disc: { position: 'absolute', left: -14 },
  decimal: { position: 'absolute', left: -26, width: 20, textAlign: 'right' }
}
const markerStyles = new Map<string, StyleDesc>()

/**
 * The marker sits on the item's first line. It is a sibling of the item, not
 * a child, so it takes the item's top padding as its own offset.
 */
function markerStyle(kind: 'inside' | 'disc' | 'decimal', item: Slot): StyleDesc {
  const pad = isValidElement(item) ? (item.props as { style?: StyleDesc }).style?.paddingTop : undefined
  const top = typeof pad === 'number' ? pad : 0
  const key = `${kind}:${top}`
  let style = markerStyles.get(key)
  if (!style) {
    style = kind === 'inside' ? { ...MARKER_BASE.inside, paddingTop: top } : { ...MARKER_BASE[kind], top }
    markerStyles.set(key, style)
  }
  return style
}

/** CSS list markers: `list-outside` hangs the marker in the list's padding, `list-inside` puts it in the line. */
function withMarkers(slots: Slot[], marker: 'disc' | 'decimal', inside: boolean): Slot[] {
  let n = 0
  return slots.map((slot, i) => {
    if (isEmpty(slot) || (isText(slot) && String(slot).trim() === '')) return null
    n++
    const label = marker === 'disc' ? '•' : `${n}.`
    const key = isValidElement(slot) && slot.key !== null ? slot.key : `m${i}`
    const glyph = jsx('text', { style: markerStyle(inside ? 'inside' : marker, slot), children: label })
    if (inside) {
      return jsxs('div', { style: INSIDE_ROW, children: [glyph, jsx('div', { style: INSIDE_BODY, children: slot })] }, key)
    }
    return jsxs('div', { style: MARKER_ROW, children: [glyph, slot] }, key)
  })
}

/**
 * Lay out `children` for an element translated as `tr` whose final style is
 * `style`. `isStatic` is whether the caller used `jsxs` (a fixed children
 * array, positions are identity) or `jsx` (one child, or a dynamic array the
 * caller keyed).
 */
/**
 * A column whose height is its content's (no height, at most a max height) is
 * indefinite, and CSS resolves a child's `flex-1` basis of 0% against it as
 * the child's content size. GPUIX takes basis 0 literally, so a scrolling body
 * (`flex-1 overflow-y-auto`) collapses to nothing. Drop the basis on such
 * children: they size to their content and still shrink under the max height.
 */
export function contentBasis(children: ReactNode): ReactNode {
  if (Array.isArray(children)) return children.map(contentBasis)
  if (!isValidElement<{ style?: StyleDesc }>(children)) return children
  const style = children.props.style
  if (style?.flexBasis !== 0 || !style.flexGrow) return children
  const { flexBasis: _, ...rest } = style
  const clone = cloneElement(children, { style: rest })
  const info = childInfo.get(children)
  if (info) childInfo.set(clone, info)
  return clone
}

function holdsText(slots: Slot[]): boolean {
  return slots.some((slot) => isText(slot) || (Array.isArray(slot) && holdsText(slot)))
}

/**
 * Each contiguous text run of a flex or block box becomes one trimmed
 * anonymous box, in place. A nested array (a component's
 * `{icon}{children}{after}`) is the same box's content in CSS, so its runs
 * are trimmed too; only its text changes, never its order or its elements.
 */
function trimTextRuns(out: Slot[], tr: Translation): void {
  let first = -1
  for (let i = 0; i <= out.length; i++) {
    const slot = out[i]
    if (i < out.length && isText(slot)) {
      if (first < 0) first = i
      continue
    }
    if (first >= 0) {
      const joined = collapse(out.slice(first, i).join('')).trim()
      out[first] = joined === '' ? null : applyTextTransform(joined, tr.transform)
      for (let j = first + 1; j < i; j++) out[j] = null
      first = -1
    }
    if (Array.isArray(slot) && holdsText(slot)) {
      const nested = slot.slice()
      trimTextRuns(nested, tr)
      out[i] = nested
    }
  }
}

/** Inter's ascent and descent per px of font size, as Chromium reads them. */
const INTER_ASCENT = 0.96875
const INTER_DESCENT = 0.2421875

/**
 * How far a block container's strut reaches below the baseline: the rounded
 * font descent plus half the leading. Taken from the container's own font, or
 * the root's when it sets none.
 */
function strutDescent(style: StyleDesc): number {
  const size = typeof style.fontSize === 'number' ? style.fontSize : ROOT_FONT_SIZE
  const lineHeight = typeof style.lineHeight === 'number' ? style.lineHeight : size * INHERITED_LEADING
  const ascent = Math.round(size * INTER_ASCENT)
  const descent = Math.round(size * INTER_DESCENT)
  return Math.max(0, descent + (lineHeight - ascent - descent) / 2)
}

/**
 * A textarea is inline-block: in a block container it sits on a line whose
 * baseline is its bottom margin edge, so the line box reaches the strut's
 * descent below it. GPUIX lays it out as a block; a padded wrapper stands in
 * for the line box.
 */
function belowStrut(node: ReactElement, strut: number): ReactElement {
  const line = jsx('div', { style: { paddingBottom: strut }, children: node }, node.key ?? undefined)
  childInfo.set(line, { inline: false })
  return line
}

export function layoutChildren(
  tr: Translation,
  style: StyleDesc,
  children: ReactNode,
  isStatic: boolean,
  reverse = false
): Laid {
  if (isEmpty(children)) return { children: undefined, isStatic: false }
  if (reverse && Array.isArray(children)) children = [...children].reverse()
  if (isText(children)) {
    const text = applyTextTransform(tr.inline ? collapse(String(children)) : collapse(String(children)).trim(), tr.transform)
    return { children: text === '' ? undefined : text, isStatic: false }
  }
  if (!Array.isArray(children)) {
    children = placeComponent(children)
    const info = infoOf(children)
    if (info?.autoMargin && isValidElement(children)) {
      return { children: placeAutoMargin(children, info.autoMargin, tr.flexDirection === 'row'), isStatic: false }
    }
    if (tr.blockFlow && info?.baselineAtBottom && isValidElement(children)) {
      return { children: belowStrut(children, strutDescent(style)), isStatic: false }
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
    return { children: paintPositionedLast(out), runStyle: runStyleFor(tr, style), isStatic }
  }

  if (flex || blocks > 0 || texts === 0) {
    // Flex items, or block flow: contiguous text is one anonymous box.
    const row = style.display === 'flex' && style.flexDirection !== 'column' && style.flexDirection !== 'column-reverse'
    const grows = row && slots.some(growsInFlow)
    trimTextRuns(out, tr)
    const strut = tr.blockFlow ? strutDescent(style) : 0
    for (let i = 0; i < out.length; i++) {
      const slot = out[i]
      const info = infoOf(slot)
      if (info?.autoMargin && isValidElement(slot)) out[i] = placeAutoMargin(slot, info.autoMargin, row, grows)
      else if (strut > 0 && info?.baselineAtBottom && isValidElement(slot)) out[i] = belowStrut(slot, strut)
    }
    return { children: paintPositionedLast(out), isStatic }
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
  return { children: paintPositionedLast(out), runStyle: runStyleFor(tr, style), isStatic }
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

const OFFSET_TOKEN = /^-?(top|right|bottom|left|inset|inset-x|inset-y|start|end)-/

/**
 * A component (an icon, a shared button) whose className uses the centring
 * idiom: compat never sees its host element, so the idiom is applied around
 * it. The component keeps its other classes; the absolute box and its px
 * offsets move to the centring wrapper.
 */
function placeComponent(slot: Slot): Slot {
  if (!isValidElement(slot) || typeof slot.type === 'string') return slot
  const className = (slot.props as { className?: unknown }).className
  if (typeof className !== 'string' || !className.includes('1/2')) return slot
  const tokens = className.split(/\s+/).filter(Boolean)
  const { placement, rest } = liftPlacement(tokens)
  if (!placement || placement.popup || !rest.includes('absolute')) return slot
  const box = translation('div', rest.join(' ')).base
  const placed = placeStyle(box, placement)
  if (!placed) return slot
  const inner = rest.filter((t) => t !== 'absolute' && !OFFSET_TOKEN.test(t)).join(' ')
  const wrapper = placed.wrap(cloneElement(slot as ReactElement<{ className?: string }>, { className: inner }), slot.key ?? undefined)
  childInfo.set(wrapper, { inline: false, positioned: true })
  return wrapper
}

function isPositioned(slot: Slot): boolean {
  if (!isValidElement(slot)) return false
  if (infoOf(slot)?.positioned) return true
  const style = (slot.props as { style?: StyleDesc }).style
  return slot.type === 'div' && style?.position === 'absolute'
}

/**
 * CSS paints positioned boxes after the in-flow content of their stacking
 * context; GPUIX paints in tree order. Absolutely positioned children are out
 * of flow, so moving them to the end changes paint order and hit order only.
 * Their slots stay as nulls and the moved elements carry keys, so React
 * matches every child as before.
 */
function paintPositionedLast(out: Slot[]): Slot[] {
  const slots = out.map(placeComponent)
  if (!slots.some(isPositioned)) return slots
  const moved: Slot[] = []
  const kept = slots.map((slot, i) => {
    if (!isPositioned(slot)) return slot
    const element = slot as ReactElement
    moved.push(element.key === null ? cloneElement(element, { key: `$positioned${i}` }) : element)
    return null
  })
  return [...kept, ...moved]
}

function countElements(slots: Slot[]): number {
  let n = 0
  for (const slot of slots) n += Array.isArray(slot) ? countElements(slot) : isValidElement(slot) ? 1 : 0
  return n
}

/**
 * `divide-y` / `divide-x`: CSS borders the far side of every child element
 * but the last. The child may be a component, whose element this parent
 * cannot restyle, so a line of that width follows it instead: the same pixels
 * in a flex container, where the line spans the cross axis as the child does.
 * With a gap the line pulls back over it, so the order stays child, line, gap.
 * Every element gets the same Fragment slot, line or not, so a sibling that
 * appears or goes away never remounts it.
 */
export function divideChildren(children: ReactNode, divide: Divide, style: StyleDesc): ReactNode {
  if (!Array.isArray(children)) return children
  const total = countElements(children)
  if (total < 2) return children
  const y = divide.axis === 'y'
  const gap = (y ? style.rowGap : style.columnGap) ?? style.gap
  const pull = typeof gap === 'number' && gap > 0 ? -gap : undefined
  const line: StyleDesc = y
    ? { height: divide.width, alignSelf: 'stretch', flexShrink: 0, backgroundColor: divide.color, marginTop: pull }
    : { width: divide.width, alignSelf: 'stretch', flexShrink: 0, backgroundColor: divide.color, marginLeft: pull }
  let seen = 0
  const walk = (slots: Slot[]): Slot[] =>
    slots.map((slot, i) => {
      if (Array.isArray(slot)) return walk(slot)
      if (!isValidElement(slot)) return slot
      seen++
      const drawn = seen < total && !childInfo.get(slot)?.positioned
      return jsxs(Fragment, { children: [slot, drawn ? jsx('div', { style: line }) : null] }, slot.key ?? `divide-${i}`)
    })
  return walk(children as Slot[])
}
