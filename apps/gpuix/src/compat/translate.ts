/**
 * DOM tag + className -> how the element paints in GPUIX. Pure and cached per
 * (tag, className): an element whose classes do not change gets the same
 * StyleDesc object every render, so GPUIX's commitUpdate skips setStyle on
 * identity. Tokens tw() cannot express (auto margins, text-transform, list
 * markers, `group`) are lifted out here and handled structurally.
 */

import type { StyleDesc } from '@gpuix/react'
import { resolveTwTheme } from '../style/theme'
import { completeFont, type InheritedFont } from './font'
import { liftFillMinus, liftPlacement, type Placement } from './placement'
import { viewportHeight, viewportWidth } from './viewport'
import { type CompiledStyle, createTw, type Tw } from '../style/tw'
import { MONO_FAMILY } from '../style/utilities'
import type { Condition } from '../style/variants'
import { SCOPES, type ScopeName } from './scope'
import { zIndexToken } from './stacking'

export type HostType = 'div' | 'text' | 'svg' | 'img' | 'input' | 'textarea'

/** Which side margins are `auto`. In GPUIX margins are numbers only. */
export interface AutoMargin {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

/** How the element's conditional rules are resolved. */
export type RuleMode =
  /** No conditional rules: `base` is the whole style. */
  | 'static'
  /** Rules read only this element's props (disabled, data-*, aria-*): resolved at creation. */
  | 'props'
  /** Rules read state GPUIX does not track for it (group-*, focus, focus-within, viewport). */
  | 'host'

export interface Translation {
  readonly tag: string
  readonly type: HostType
  readonly compiled: CompiledStyle
  /** Static style: tag defaults, compiled base, layout fixes. Stable identity. */
  readonly base: StyleDesc
  readonly ruleMode: RuleMode
  /** `group` or `group/<name>` on this element. */
  readonly group: string | null
  /** `peer` or `peer/<name>` on this element: later siblings' `peer-*` rules read its state. */
  readonly peer: boolean
  /** Inline-level (span, a, inline-flex, button...) as opposed to block-level. */
  readonly inline: boolean
  /** null when not a flex container. */
  readonly flexDirection: 'row' | 'column' | null
  readonly transform: 'uppercase' | 'lowercase' | 'capitalize' | null
  readonly autoMargin: AutoMargin | null
  readonly listMarker: 'disc' | 'decimal' | null
  readonly hidden: boolean
  readonly fixed: boolean
  /**
   * The `z-*` class's z-index, `null` for none or `z-auto`. In `base` as the
   * `zIndex` style unless the element is `fixed`, whose `<anchored>` layer
   * takes it as its priority instead (`stacking.ts`).
   */
  readonly zIndex: number | null
  /** The `rotate-*` class's degrees, or null. Painted only on icons (`svg.tsx`). */
  readonly rotate: number | null
  readonly nowrap: boolean
  /** Paints a box (fill, border, padding, size): cannot merge into a parent's text run. */
  readonly paints: boolean
  /** Has native hover/active styles. */
  readonly hoverable: boolean
  /** An index.css scope whose descendant rules apply below this element. */
  readonly scope: ScopeName | null
  readonly listInside: boolean
  /** `[&_svg]:x` / `[&>svg]:x` tokens, provided to icons below. */
  readonly svgClasses: string | null
  /** Centering or popup placement rebuilt in `placement.tsx`. */
  readonly placement: Placement | null
  /** px subtracted by a `w-[calc(100%-x)]` width, or null. */
  readonly fillMinus: number | null
  /**
   * A block container in CSS (no flex, grid or inline display class), even
   * when the translation lowers `space-y` to a flex column: inline-level
   * children sit in line boxes there.
   */
  readonly blockFlow: boolean
  /** The font the classes declare in full (size and line height): what descendants inherit. */
  readonly fontScope: InheritedFont | null
}

const PHRASING = new Set([
  'span', 'a', 'strong', 'b', 'em', 'i', 'small', 'code', 'kbd', 'samp', 'abbr', 'time', 'sup',
  'sub', 'mark', 'del', 's', 'u', 'ins', 'q', 'cite', 'var', 'label', 'button', 'img', 'svg',
  'input', 'textarea', 'select', 'br', 'wbr', 'output', 'data'
])

const MONO = { fontFamily: MONO_FAMILY } satisfies StyleDesc
const BOLD = { fontWeight: 700 } satisfies StyleDesc

/** What Tailwind's preflight leaves on each tag (everything else is reset). */
const TAG_DEFAULTS: Readonly<Record<string, StyleDesc>> = {
  strong: BOLD,
  b: BOLD,
  code: MONO,
  kbd: MONO,
  samp: MONO,
  pre: MONO,
  button: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
  svg: { flexShrink: 0 },
  img: { flexShrink: 0 },
  s: { textDecoration: 'line-through' },
  del: { textDecoration: 'line-through' },
  u: { textDecoration: 'underline' },
  ins: { textDecoration: 'underline' }
}

const HOST_TYPE: Readonly<Record<string, HostType>> = {
  svg: 'svg',
  img: 'img',
  input: 'input',
  textarea: 'textarea'
}

const AUTO_MARGIN: Readonly<Record<string, Partial<AutoMargin>>> = {
  'm-auto': { left: true, right: true, top: true, bottom: true },
  'mx-auto': { left: true, right: true },
  'my-auto': { top: true, bottom: true },
  'ml-auto': { left: true },
  'ms-auto': { left: true },
  'mr-auto': { right: true },
  'me-auto': { right: true },
  'mt-auto': { top: true },
  'mb-auto': { bottom: true }
}

const NAMED_GROUP_VARIANT = /(^|:)((?:group|peer)-[a-z-]*(?:\[[^\]]*\])?)\/[\w-]+(?=:)/g
const TRANSFORMS = new Set(['uppercase', 'lowercase', 'capitalize'])
const INLINE_DISPLAY = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid'])
const BLOCK_DISPLAY = new Set(['block', 'flex', 'grid', 'table', 'flow-root', 'list-item'])
const NON_BLOCK_CONTAINER = new Set(['flex', 'inline-flex', 'grid', 'inline-grid', 'table', 'contents'])
const PAINT_KEYS: readonly (keyof StyleDesc)[] = [
  'backgroundColor', 'background', 'borderWidth', 'borderTopWidth', 'borderRightWidth',
  'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'padding', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'margin', 'position', 'boxShadow',
  'opacity', 'display'
]

/** Conditions that need a component: the state lives outside this element's props. */
function needsHost(condition: Condition): boolean {
  if (condition.kind === 'viewport') return true
  if (condition.kind === 'attr') return condition.scope !== 'self'
  if (condition.kind === 'flag') return condition.flag !== 'disabled'
  return false
}

interface Lifted {
  classes: string
  group: string | null
  peer: boolean
  autoMargin: AutoMargin | null
  transform: Translation['transform']
  listMarker: Translation['listMarker']
  listInside: boolean
  display: 'inline' | 'block' | null
  /** A flex, grid, table or `contents` display class: not a block container. */
  formatsChildren: boolean
  scope: ScopeName | null
  svg: string[]
  placement: Placement | null
  fillMinus: number | null
  /** `left-1/4`-style offsets as percent strings, placed by `percentPlacement`. */
  insets: Record<string, string> | null
  zIndex: number | null
  rotate: number | null
}

const ROTATE_TOKEN = /^(-?)rotate-(?:(\d+)|\[(-?\d+(?:\.\d+)?)deg\])$/
const FRACTION_INSET = /^(top|right|bottom|left|inset|inset-x|inset-y)-(\d+)\/(\d+)$/
const INSET_SIDES: Readonly<Record<string, readonly string[]>> = {
  top: ['top'],
  right: ['right'],
  bottom: ['bottom'],
  left: ['left'],
  inset: ['top', 'right', 'bottom', 'left'],
  'inset-x': ['left', 'right'],
  'inset-y': ['top', 'bottom']
}

/** Pull out the tokens tw() has no StyleDesc for. Variant-prefixed ones stay with tw(). */
function lift(className: string): Lifted {
  const kept: string[] = []
  const lifted: Lifted = {
    classes: '',
    group: null,
    peer: false,
    autoMargin: null,
    transform: null,
    listMarker: null,
    listInside: false,
    display: null,
    formatsChildren: false,
    scope: null,
    svg: [],
    placement: null,
    fillMinus: null,
    insets: null,
    zIndex: null,
    rotate: null
  }
  const placed = liftPlacement(className.split(/\s+/))
  lifted.placement = placed.placement
  const fill = liftFillMinus(placed.rest)
  lifted.fillMinus = fill.minus
  for (const raw of fill.rest) {
    if (!raw) continue
    const inset = raw.match(FRACTION_INSET)
    if (inset) {
      const value = `${(Number(inset[2]) / Number(inset[3])) * 100}%`
      const insets = lifted.insets ?? {}
      for (const side of INSET_SIDES[inset[1]]) insets[side] = value
      lifted.insets = insets
      continue
    }
    // `group-hover/name:` binds to the nearest group, whatever its name; `peer-*/name:` likewise.
    const token = raw.includes('/') ? raw.replace(NAMED_GROUP_VARIANT, '$1$2') : raw
    const svg = svgToken(token)
    if (svg !== null) {
      lifted.svg.push(svg)
      continue
    }
    const z = zIndexToken(token)
    if (z !== undefined) {
      lifted.zIndex = z
      continue
    }
    const turn = token.match(ROTATE_TOKEN)
    if (turn) {
      lifted.rotate = (turn[1] === '-' ? -1 : 1) * Number(turn[2] ?? turn[3])
      continue
    }
    if (token === 'group' || token.startsWith('group/')) {
      lifted.group = token
      continue
    }
    if (token === 'peer' || token.startsWith('peer/')) {
      lifted.peer = true
      continue
    }
    const margin = AUTO_MARGIN[token]
    if (margin) {
      lifted.autoMargin = {
        ...(lifted.autoMargin ?? { left: false, right: false, top: false, bottom: false }),
        ...margin
      }
      continue
    }
    if (TRANSFORMS.has(token)) {
      lifted.transform = token as Translation['transform']
      continue
    }
    if (token === 'normal-case') {
      lifted.transform = null
      continue
    }
    if (token === 'list-disc' || token === 'list-decimal') {
      lifted.listMarker = token === 'list-disc' ? 'disc' : 'decimal'
      continue
    }
    if (token === 'list-inside' || token === 'list-outside') {
      lifted.listInside = token === 'list-inside'
      continue
    }
    if (token === 'list-none') continue
    if (SCOPES.has(token)) lifted.scope = token as ScopeName
    if (NON_BLOCK_CONTAINER.has(token)) lifted.formatsChildren = true
    if (INLINE_DISPLAY.has(token)) lifted.display = 'inline'
    else if (BLOCK_DISPLAY.has(token) || token === 'hidden') lifted.display = 'block'
    kept.push(token)
  }
  lifted.classes = kept.join(' ')
  return lifted
}

function svgToken(token: string): string | null {
  if (token.startsWith('[&_svg]:')) return token.slice('[&_svg]:'.length)
  if (token.startsWith('[&>svg]:')) return token.slice('[&>svg]:'.length)
  return null
}

/** Split `[&_svg]:x` tokens from a class string; tw() cannot select descendants. */
export function splitDescendantClasses(classes: string): { own: string; svg?: string } {
  const own: string[] = []
  const svg: string[] = []
  for (const token of classes.split(/\s+/)) {
    if (!token) continue
    const lifted = svgToken(token)
    if (lifted !== null) svg.push(lifted)
    else own.push(token)
  }
  return { own: own.join(' '), svg: svg.length > 0 ? svg.join(' ') : undefined }
}

function hasAny(style: StyleDesc, keys: readonly (keyof StyleDesc)[]): boolean {
  for (const key of keys) if (style[key] !== undefined) return true
  return false
}

const FLIP: Readonly<Record<string, string>> = {
  start: 'flex-end',
  'flex-start': 'flex-end',
  end: 'flex-start',
  'flex-end': 'flex-start'
}

const unreversed = new WeakMap<StyleDesc, StyleDesc>()

/**
 * GPUIX ignores row-reverse / column-reverse (measured in its renderer): the
 * caller lays the children out in reverse, and the main axis flips here.
 * Decided on the final style, since a variant (`sm:flex-row`) can undo it.
 */
export function unreverse(style: StyleDesc): StyleDesc | null {
  if (style.flexDirection !== 'row-reverse' && style.flexDirection !== 'column-reverse') return null
  let hit = unreversed.get(style)
  if (!hit) {
    const justify = (style.justifyContent as string | undefined) ?? 'flex-start'
    hit = {
      ...style,
      flexDirection: style.flexDirection === 'row-reverse' ? 'row' : 'column',
      justifyContent: (FLIP[justify] ?? justify) as StyleDesc['justifyContent']
    }
    unreversed.set(style, hit)
  }
  return hit
}

/** Grid tokens that need real grid tracks or cell alignment; without them a grid is one column. */
const GRID_LAYOUT = /(^|\s|:)(grid-cols-|grid-rows-|grid-flow-|col-|row-span-|place-|justify-items-|justify-self-)/

function layoutFixes(style: StyleDesc, classes: string): StyleDesc {
  const out: StyleDesc = { ...style }
  // A grid with no column template is one column as wide as the grid. Taffy
  // sizes that implicit track to the widest item's max-content, so a long
  // paragraph widens the column past its container instead of wrapping
  // (dialogs.bug-report). One explicit track (`minmax(0, 1fr)`) fits it.
  if (out.display === 'grid' && out.gridTemplateColumns === undefined && !GRID_LAYOUT.test(classes)) {
    out.gridTemplateColumns = 1
  }
  // CSS resolves `min-width: auto` to 0 for scroll containers and lets a
  // `flex: 1 1 0%` item shrink to its min-content. Taffy measures text at
  // max-content, so without this a flex-1 or overflow-hidden item never shrinks.
  const clips = out.overflow === 'hidden' || out.overflow === 'scroll' || out.overflowX !== undefined
  if (out.minWidth === undefined && (out.flexGrow === 1 || out.flexBasis === 0)) {
    out.minWidth = 0
  }
  if (out.minHeight === undefined && clips && out.flexGrow === 1) out.minHeight = 0
  // Taffy sizes a content-sized flex row wrongly when an item has
  // `flex-shrink: 0` and a negative margin: each px of `-mr-1` takes about
  // 23 px off the row, so a pane tab with a `w-6 shrink-0 -mr-1` close slot
  // came out 26 px wide (C15). A shrinkable item whose min size is its fixed
  // size lays out the same and sizes the row right.
  if (out.flexShrink === 0 && hasNegativeMargin(out)) {
    const sized = { width: typeof out.width === 'number', height: typeof out.height === 'number' }
    if (sized.width || sized.height) {
      out.flexShrink = 1
      if (sized.width && out.minWidth === undefined) out.minWidth = out.width
      if (sized.height && out.minHeight === undefined) out.minHeight = out.height
    }
  }
  return out
}

function hasNegativeMargin(style: StyleDesc): boolean {
  for (const side of [style.marginLeft, style.marginRight, style.marginTop, style.marginBottom]) {
    if (typeof side === 'number' && side < 0) return true
  }
  return false
}

function translate(tw: Tw, tag: string, className: string): Translation {
  const lifted = lift(className)
  const compiled = tw.compile(lifted.classes)
  const defaults = TAG_DEFAULTS[tag]
  // A button centres its content only as an inline-block; `flex` / `grid` on it
  // lay the content out from the start, like any flex container.
  const ownLayout = tag === 'button' && compiled.base.display !== undefined && compiled.base.display !== 'none'
  const merged: StyleDesc = defaults && !ownLayout ? { ...defaults, ...compiled.base } : compiled.base
  const fixed = layoutFixes(merged, lifted.classes)
  const placedBase = lifted.insets ? { ...fixed, ...lifted.insets } : fixed
  const isFixed = placedBase.position === 'fixed'
  const base = lifted.zIndex !== null && !isFixed ? { ...placedBase, zIndex: lifted.zIndex } : placedBase
  let ruleMode: RuleMode = 'static'
  for (const rule of compiled.rules) {
    if (rule.when.some(needsHost)) {
      ruleMode = 'host'
      break
    }
    ruleMode = 'props'
  }
  const display = base.display
  const flexDirection =
    display === 'flex'
      ? base.flexDirection === 'column' || base.flexDirection === 'column-reverse'
        ? 'column'
        : 'row'
      : null
  const inline = lifted.display ? lifted.display === 'inline' : PHRASING.has(tag)
  return {
    tag,
    type: HOST_TYPE[tag] ?? 'div',
    compiled,
    base,
    ruleMode,
    group: lifted.group,
    peer: lifted.peer,
    inline,
    flexDirection,
    transform: lifted.transform,
    autoMargin: lifted.autoMargin,
    listMarker: lifted.listMarker,
    hidden: display === 'none',
    fixed: isFixed,
    zIndex: lifted.zIndex,
    rotate: lifted.rotate,
    nowrap: base.whiteSpace === 'nowrap',
    paints: hasAny(compiled.base, PAINT_KEYS) || (defaults !== undefined && 'display' in defaults),
    hoverable: base.hover !== undefined || base.active !== undefined,
    scope: lifted.scope,
    listInside: lifted.listInside,
    svgClasses: lifted.svg.length > 0 ? lifted.svg.join(' ') : null,
    placement: lifted.placement,
    fillMinus: lifted.fillMinus,
    blockFlow: !inline && !lifted.formatsChildren && defaults?.display === undefined,
    fontScope: completeFont(compiled.font)
  }
}

let active: Tw = createTw(resolveTwTheme('termul'))
/** tag -> class string -> translation. Two levels, so a lookup hashes the class string without building a key. */
let cache = new Map<string, Map<string, Translation>>()

const VIEWPORT_LENGTH = /(-?\d*\.?\d+)(d|s|l)?(vh|vw)\b/g

/**
 * Arbitrary viewport lengths (`h-[85vh]`, `w-[90vw]`) as px of the window
 * size when the element renders. tw() resolves lengths once per class string,
 * so the px form is the cache key; an element shows a new window size when it
 * next renders.
 */
export function resolveViewportUnits(classes: string, width: number, height: number): string {
  if (!/\d[dsl]?v[hw]\b/.test(classes)) return classes
  return classes.replace(/\[[^\]]*\]/g, (bracket) =>
    bracket.replace(VIEWPORT_LENGTH, (_m, n: string, _kind: string | undefined, unit: string) => {
      const px = (Number.parseFloat(n) / 100) * (unit === 'vh' ? height : width)
      return `${Math.round(px * 100) / 100}px`
    })
  )
}

/** The cached translation of one DOM tag and class string. */
export function translation(tag: string, className: string | undefined): Translation {
  let byClass = cache.get(tag)
  if (!byClass) {
    byClass = new Map()
    cache.set(tag, byClass)
  }
  const classes = resolveViewportUnits(className ?? '', viewportWidth(), viewportHeight())
  let hit = byClass.get(classes)
  if (!hit) {
    hit = translate(active, tag, classes)
    byClass.set(classes, hit)
  }
  return hit
}

export function compatTw(): Tw {
  return active
}

const themeListeners = new Set<() => void>()

/** Switch the theme every translation resolves against. Subscribers re-render the tree. */
export function setCompatTheme(themeId: string): void {
  if (active.theme.id === themeId) return
  active = createTw(resolveTwTheme(themeId))
  cache = new Map()
  for (const listener of themeListeners) listener()
}

export function compatThemeId(): string {
  return active.theme.id
}

export function subscribeCompatTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  return () => themeListeners.delete(listener)
}

/** Cache size, for the bench report. */
export function translationCount(): number {
  let n = 0
  for (const byClass of cache.values()) n += byClass.size
  return n
}

export function applyTextTransform(text: string, transform: Translation['transform']): string {
  if (transform === 'uppercase') return text.toUpperCase()
  if (transform === 'lowercase') return text.toLowerCase()
  if (transform === 'capitalize') return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
  return text
}
