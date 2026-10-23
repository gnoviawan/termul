/**
 * One Tailwind utility (variants already stripped) -> a GPUIX style fragment.
 * Roots are looked up the way Tailwind does it: the longest dash-separated
 * prefix that has a handler, with the rest as the value.
 */
import type { StyleDesc } from '@gpuix/react'
import {
  type CssShadow,
  formatColor,
  parseColor,
  parseLength,
  parseShadowList,
  type Rgba,
  withAlpha
} from './css-value'
import {
  CONTAINERS,
  FONT_SIZES,
  FONT_WEIGHTS,
  LEADING_RATIOS,
  radiusScale,
  SHADOWS,
  SPACING_UNIT
} from './scale'
import type { TwTheme } from './theme'

export const SANS_FAMILY = 'Inter Variable'
export const MONO_FAMILY = 'Paper Mono'
/** Inter with `tnum` frozen in (tools/style/build-fonts.py). */
export const TABULAR_FAMILY = 'Inter Variable Tabular'

/** Line height as Tailwind leaves it: a ratio of the font size, or px. */
export type Leading = { ratio: number } | { px: number }

export interface Ring {
  width?: number
  color?: Rgba
  inset?: boolean
  offsetWidth?: number
  offsetColor?: Rgba
}

/**
 * What one utility contributes. Plain StyleDesc keys merge last-wins; the
 * other fields mirror Tailwind's composed custom properties (--tw-shadow,
 * --tw-ring-*, --tw-leading) and are folded into StyleDesc once per state.
 */
export interface Fragment {
  style?: StyleDesc
  shadow?: CssShadow[]
  ring?: Ring
  fontSize?: { size: number; leading?: number }
  leading?: Leading
  /** space-y / space-x: lowered to a flex gap on the element itself. */
  space?: { axis: 'x' | 'y'; px: number }
}

/** CSS blur radius B is a Gaussian of sigma B/2; GPUI takes sigma directly. */
export function toBoxShadow(s: CssShadow): BoxShadow {
  return {
    offsetX: s.offsetX,
    offsetY: s.offsetY,
    blurRadius: s.blurRadius / 2,
    spreadRadius: s.spreadRadius,
    color: formatColor(s.color),
    ...(s.inset ? { inset: true } : {})
  }
}

export type BoxShadow = Extract<NonNullable<StyleDesc['boxShadow']>, { offsetX: number }>

export type UtilityResult =
  | { kind: 'style'; frag: Fragment; rank: number; approx?: string }
  | { kind: 'unsupported'; reason: string }

interface Value {
  /** Text after the root, '' for a bare root. */
  value: string
  /** `/50` or `/[0.03]` opacity modifier, or the denominator of a fraction. */
  modifier?: string
  negative: boolean
  theme: TwTheme
}

type Handler = (v: Value) => UtilityResult | undefined

const ok = (style: StyleDesc, rank = 0): UtilityResult => ({ kind: 'style', frag: { style }, rank })
const frag = (fragment: Fragment, rank = 0): UtilityResult => ({
  kind: 'style',
  frag: fragment,
  rank
})
const unsupported = (reason: string): UtilityResult => ({ kind: 'unsupported', reason })
const approx = (style: StyleDesc, reason: string): UtilityResult => ({
  kind: 'style',
  frag: { style },
  rank: 0,
  approx: reason
})

function arbitrary(value: string): string | undefined {
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined
  return value.slice(1, -1).replace(/_/g, ' ')
}

function spacing(v: Value): number | undefined {
  const raw = arbitrary(v.value)
  let px: number | undefined
  if (raw !== undefined) px = parseLength(raw, v.theme.vars)
  else if (v.value === 'px') px = 1
  else if (v.value === '0') px = 0
  else if (/^\d+(\.\d+)?$/.test(v.value) && Number(v.value) % 0.25 === 0)
    px = Number(v.value) * SPACING_UNIT
  if (px === undefined) return undefined
  return v.negative ? -px : px
}

/** Width/height values: spacing, fractions, full, auto, arbitrary. */
function size(v: Value, containers = false): number | string | undefined {
  if (v.modifier !== undefined && /^\d+$/.test(v.value) && /^\d+$/.test(v.modifier)) {
    return `${(100 * Number(v.value)) / Number(v.modifier)}%`
  }
  if (v.value === 'full') return '100%'
  if (v.value === 'auto') return 'auto'
  const raw = arbitrary(v.value)
  if (raw?.endsWith('%')) return raw
  if (containers && v.value in CONTAINERS) return CONTAINERS[v.value]
  return spacing(v)
}

function opacity(modifier: string | undefined): number {
  if (modifier === undefined) return 1
  const raw = arbitrary(modifier)
  if (raw !== undefined) return raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number(raw)
  return Number(modifier) / 100
}

/** A theme colour, `transparent`/`black`/`white`, or `[<css colour>]`, with /opacity. */
function color(v: Value): Rgba | undefined {
  const raw = arbitrary(v.value)
  let base: Rgba | undefined
  if (raw !== undefined) {
    const text = raw.replace(/^color:/, '')
    try {
      base = parseColor(text, v.theme.vars)
    } catch {
      return undefined
    }
  } else if (v.value in v.theme.colors) base = v.theme.colors[v.value]
  else if (v.value === 'transparent') base = { r: 0, g: 0, b: 0, a: 0 }
  else if (v.value === 'black') base = { r: 0, g: 0, b: 0, a: 1 }
  else if (v.value === 'white') base = { r: 1, g: 1, b: 1, a: 1 }
  if (!base) return undefined
  return withAlpha(base, opacity(v.modifier))
}

function sides(
  prefix: string,
  sideKeys: Record<string, string[]>,
  read: (v: Value) => unknown,
  rankOf = sideRank
) {
  const handlers: Record<string, Handler> = {}
  for (const [suffix, keys] of Object.entries(sideKeys)) {
    handlers[`${prefix}${suffix}`] = (v) => {
      const value = read(v)
      if (value === undefined) return undefined
      return ok(Object.fromEntries(keys.map((key) => [key, value])) as StyleDesc, rankOf(suffix))
    }
  }
  return handlers
}

/** Shorthands first, then axes, then single sides, like Tailwind's sort. */
function sideRank(suffix: string): number {
  if (suffix === '') return 0
  return suffix === 'x' || suffix === 'y' ? 1 : 2
}

const PADDING = {
  '': ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  x: ['paddingLeft', 'paddingRight'],
  y: ['paddingTop', 'paddingBottom'],
  t: ['paddingTop'],
  r: ['paddingRight'],
  b: ['paddingBottom'],
  l: ['paddingLeft'],
  s: ['paddingLeft'],
  e: ['paddingRight']
}
const MARGIN = Object.fromEntries(
  Object.entries(PADDING).map(([k, keys]) => [
    k,
    keys.map((key) => key.replace('padding', 'margin'))
  ])
)
const INSET = {
  inset: ['top', 'right', 'bottom', 'left'],
  'inset-x': ['left', 'right'],
  'inset-y': ['top', 'bottom'],
  top: ['top'],
  right: ['right'],
  bottom: ['bottom'],
  left: ['left'],
  start: ['left'],
  end: ['right']
}
const BORDER_SIDES: Record<string, (keyof StyleDesc)[]> = {
  border: ['borderWidth'],
  'border-x': ['borderLeftWidth', 'borderRightWidth'],
  'border-y': ['borderTopWidth', 'borderBottomWidth'],
  'border-t': ['borderTopWidth'],
  'border-r': ['borderRightWidth'],
  'border-b': ['borderBottomWidth'],
  'border-l': ['borderLeftWidth'],
  'border-s': ['borderLeftWidth'],
  'border-e': ['borderRightWidth']
}
const RADIUS_CORNERS: Record<string, (keyof StyleDesc)[]> = {
  rounded: ['borderRadius'],
  'rounded-t': ['borderTopLeftRadius', 'borderTopRightRadius'],
  'rounded-r': ['borderTopRightRadius', 'borderBottomRightRadius'],
  'rounded-b': ['borderBottomLeftRadius', 'borderBottomRightRadius'],
  'rounded-l': ['borderTopLeftRadius', 'borderBottomLeftRadius'],
  'rounded-s': ['borderTopLeftRadius', 'borderBottomLeftRadius'],
  'rounded-e': ['borderTopRightRadius', 'borderBottomRightRadius'],
  'rounded-tl': ['borderTopLeftRadius'],
  'rounded-tr': ['borderTopRightRadius'],
  'rounded-br': ['borderBottomRightRadius'],
  'rounded-bl': ['borderBottomLeftRadius']
}

const MOTION = 'motion: GPUIX has no CSS transitions or keyframes (motion.div only)'
const TRANSFORM = 'transform: GPUIX has no transforms (gpuix#102)'

const HANDLERS: Record<string, Handler> = {
  ...sides('p', PADDING, (v) => (v.negative ? undefined : spacing(v))),
  ...sides('m', MARGIN, spacing),
  ...Object.fromEntries(
    Object.entries(INSET).map(([root, keys]) => [
      root,
      ((v) => {
        if (v.modifier !== undefined || v.value === 'full' || arbitrary(v.value)?.endsWith('%')) {
          return unsupported('position offsets are px only in GPUIX, no %')
        }
        const px = spacing(v)
        if (px === undefined) return undefined
        return ok(
          Object.fromEntries(keys.map((k) => [k, px])),
          root === 'inset' ? 0 : root.includes('-') ? 1 : 2
        )
      }) as Handler
    ])
  ),
  gap: (v) => withPx(spacing(v), (px) => ({ gap: px })),
  'gap-x': (v) => withPx(spacing(v), (px) => ({ columnGap: px }), 1),
  'gap-y': (v) => withPx(spacing(v), (px) => ({ rowGap: px }), 1),
  'space-y': (v) => withSpace(v, 'y'),
  'space-x': (v) => withSpace(v, 'x'),
  w: (v) => withSize(size(v, false), (s) => ({ width: s })),
  h: (v) => withSize(size(v, false), (s) => ({ height: s })),
  size: (v) => withSize(size(v, false), (s) => ({ width: s, height: s })),
  'min-w': (v) => withSize(size(v, true), (s) => ({ minWidth: s })),
  'min-h': (v) => withSize(size(v, false), (s) => ({ minHeight: s })),
  'max-w': (v) => (v.value === 'none' ? ok({}) : withSize(size(v, true), (s) => ({ maxWidth: s }))),
  'max-h': (v) =>
    v.value === 'none' ? ok({}) : withSize(size(v, false), (s) => ({ maxHeight: s })),
  basis: (v) => {
    const s = size(v)
    return typeof s === 'number' ? ok({ flexBasis: s }) : undefined
  },
  text: (v) => {
    const named = FONT_SIZES[v.value]
    if (named) {
      const leading = v.modifier === undefined ? undefined : leadingOf({ ...v, value: v.modifier })
      return frag({ fontSize: named, ...(leading ? { leading } : {}) })
    }
    const raw = arbitrary(v.value)
    if (raw !== undefined && /^[\d.]+(px|rem|em)$/.test(raw.replace(/^length:/, ''))) {
      return frag({ fontSize: { size: parseLength(raw.replace(/^length:/, ''), v.theme.vars) } })
    }
    const c = color(v)
    return c ? ok({ color: formatColor(c) }) : undefined
  },
  font: (v) => {
    if (v.value === 'sans') return ok({ fontFamily: SANS_FAMILY })
    if (v.value === 'mono') return ok({ fontFamily: MONO_FAMILY })
    if (v.value in FONT_WEIGHTS) return ok({ fontWeight: FONT_WEIGHTS[v.value] })
    const raw = arbitrary(v.value)
    if (raw !== undefined && /^\d+$/.test(raw)) return ok({ fontWeight: Number(raw) })
    return undefined
  },
  leading: (v) => {
    const leading = leadingOf(v)
    return leading ? frag({ leading }) : undefined
  },
  tracking: () => unsupported('letter-spacing: GPUIX has no letterSpacing (gpuix#60)'),
  bg: (v) => {
    if (v.value === 'none') return ok({})
    if (v.value.startsWith('gradient') || v.value.startsWith('linear')) {
      return unsupported('gradients need the structured two-stop background')
    }
    const c = color(v)
    return c ? ok({ backgroundColor: formatColor(c) }) : undefined
  },
  ...Object.fromEntries(
    Object.entries(BORDER_SIDES).map(([root, keys]) => [
      root,
      ((v) => {
        if (v.value === '' || /^\d+$/.test(v.value) || /^\[\d+px\]$/.test(v.value)) {
          const px =
            v.value === ''
              ? 1
              : arbitrary(v.value)
                ? parseLength(arbitrary(v.value) ?? '')
                : Number(v.value)
          return ok(Object.fromEntries(keys.map((k) => [k, px])), sideRank(root.slice(7)))
        }
        if (root === 'border' && (v.value === 'solid' || v.value === 'dashed'))
          return ok({ borderStyle: v.value })
        if (root === 'border' && v.value === 'none') return ok({ borderWidth: 0 })
        const c = color(v)
        if (!c) return undefined
        if (root === 'border') return ok({ borderColor: formatColor(c) })
        return {
          kind: 'style',
          frag: { style: { borderColor: formatColor(c) } },
          rank: 2,
          approx: 'one border colour per element'
        }
      }) as Handler
    ])
  ),
  ...Object.fromEntries(
    Object.entries(RADIUS_CORNERS).map(([root, keys]) => [
      root,
      ((v) => {
        const scale = radiusScale(v.theme.radius)
        const raw = arbitrary(v.value)
        const px = raw !== undefined ? parseLength(raw, v.theme.vars) : scale[v.value]
        if (px === undefined) return undefined
        return ok(
          Object.fromEntries(keys.map((k) => [k, px])),
          root === 'rounded' ? 0 : root.length === 9 ? 1 : 2
        )
      }) as Handler
    ])
  ),
  shadow: (v) => {
    const raw = arbitrary(v.value)
    const css = raw ?? SHADOWS[v.value]
    if (css === undefined) return color(v) ? unsupported('shadow colour override') : undefined
    return frag({ shadow: parseShadowList(css, v.theme.vars) })
  },
  ring: (v) => {
    if (v.value === 'inset') return frag({ ring: { inset: true } })
    if (v.value === '' || /^\d+$/.test(v.value))
      return frag({ ring: { width: v.value === '' ? 1 : Number(v.value) } })
    const c = color(v)
    return c ? frag({ ring: { color: c } }) : undefined
  },
  'ring-offset': (v) => {
    if (/^\d+$/.test(v.value)) return frag({ ring: { offsetWidth: Number(v.value) } })
    const c = color(v)
    return c ? frag({ ring: { offsetColor: c } }) : undefined
  },
  outline: (v) => {
    if (/^\d+$/.test(v.value)) return ok({ outlineWidth: Number(v.value) })
    if (v.value === 'none' || v.value === 'hidden') return ok({ outlineWidth: 0 })
    const c = color(v)
    return c ? ok({ outlineColor: formatColor(c) }) : undefined
  },
  'outline-offset': (v) =>
    /^\d+$/.test(v.value) ? ok({ outlineOffset: Number(v.value) }) : undefined,
  opacity: (v) => (/^\d+$/.test(v.value) ? ok({ opacity: Number(v.value) / 100 }) : undefined),
  'line-clamp': (v) =>
    /^\d+$/.test(v.value) ? ok({ lineClamp: Number(v.value), overflow: 'hidden' }) : undefined,
  'grid-cols': (v) =>
    /^\d+$/.test(v.value)
      ? ok({ gridTemplateColumns: Number(v.value) })
      : unsupported('grid track lists (gpuix#103)'),
  'grid-rows': (v) =>
    /^\d+$/.test(v.value)
      ? ok({ gridTemplateRows: Number(v.value) })
      : unsupported('grid track lists (gpuix#103)'),
  cursor: (v) => ok({ cursor: v.value as StyleDesc['cursor'] }),
  aspect: (v) => {
    if (v.value === 'square') return ok({ aspectRatio: 1 })
    if (v.value === 'video') return ok({ aspectRatio: 16 / 9 })
    const raw = arbitrary(v.value)?.split('/').map(Number)
    return raw?.length === 2 ? ok({ aspectRatio: raw[0] / raw[1] }) : undefined
  },
  z: () => unsupported('z-index: paint order is tree order; use <anchored>'),
  transition: () => unsupported(MOTION),
  duration: () => unsupported(MOTION),
  ease: () => unsupported(MOTION),
  delay: () => unsupported(MOTION),
  animate: () => unsupported(MOTION),
  'will-change': () => unsupported(MOTION),
  'fade-in': () => unsupported(MOTION),
  'fade-out': () => unsupported(MOTION),
  'zoom-in': () => unsupported(MOTION),
  'zoom-out': () => unsupported(MOTION),
  'slide-in-from': () => unsupported(MOTION),
  'slide-out-to': () => unsupported(MOTION),
  'spin-in': () => unsupported(MOTION),
  'spin-out': () => unsupported(MOTION),
  placeholder: () => unsupported('placeholder colour is an <input> prop'),
  from: () => unsupported('gradients need the structured two-stop background'),
  via: () => unsupported('gradients need the structured two-stop background'),
  to: () => unsupported('gradients need the structured two-stop background'),
  'row-start': () => unsupported('grid placement (gpuix#103)'),
  'col-start': () => unsupported('grid placement (gpuix#103)'),
  translate: () => unsupported(TRANSFORM),
  'translate-x': () => unsupported(TRANSFORM),
  'translate-y': () => unsupported(TRANSFORM),
  scale: () => unsupported(TRANSFORM),
  rotate: () => unsupported(TRANSFORM),
  origin: () => unsupported(TRANSFORM),
  backdrop: () => unsupported('backdrop filters: GPUIX has no per-element blur'),
  blur: () => unsupported('filters: GPUIX has no CSS filters'),
  'drop-shadow': () => unsupported('filters: GPUIX has no CSS filters'),
  overscroll: () => unsupported('overscroll behaviour is GPUI-defined'),
  touch: () => unsupported('touch-action has no GPUIX equivalent'),
  divide: () => unsupported('child selectors: put the border on each child'),
  order: () => unsupported('flex order: reorder the children'),
  'col-span': () => unsupported('grid spans (gpuix#103)'),
  'row-span': () => unsupported('grid spans (gpuix#103)'),
  decoration: () => unsupported('text-decoration styling beyond underline/line-through'),
  'underline-offset': () => unsupported('text-decoration styling beyond underline/line-through'),
  fill: () => unsupported('SVG paint: tint <svg> with style.color'),
  stroke: () => unsupported('SVG paint: tint <svg> with style.color'),
  content: () => unsupported('generated content (::before/::after)'),
  scroll: () => unsupported('scroll-margin / scroll-padding / snapping'),
  snap: () => unsupported('scroll snapping'),
  object: () => unsupported('object-fit: size <img> explicitly'),
  columns: () => unsupported('multi-column layout'),
  indent: () => unsupported('text-indent'),
  list: () => unsupported('list markers'),
  resize: () => unsupported('resize handles'),
  caret: () => unsupported('caret colour is an <input> prop'),
  accent: () => unsupported('accent-color')
}

function withPx(px: number | undefined, build: (px: number) => StyleDesc, rank = 0) {
  return px === undefined ? undefined : ok(build(px), rank)
}

function withSize(s: number | string | undefined, build: (s: number | string) => StyleDesc) {
  return s === undefined ? undefined : ok(build(s))
}

function withSpace(v: Value, axis: 'x' | 'y'): UtilityResult | undefined {
  const px = spacing(v)
  return px === undefined ? undefined : frag({ space: { axis, px } })
}

function leadingOf(v: Value): Leading | undefined {
  if (v.value in LEADING_RATIOS) return { ratio: LEADING_RATIOS[v.value] }
  const raw = arbitrary(v.value)
  if (raw !== undefined)
    return /^[\d.]+$/.test(raw) ? { ratio: Number(raw) } : { px: parseLength(raw, v.theme.vars) }
  const px = spacing(v)
  return px === undefined ? undefined : { px }
}

const KEYWORDS: Record<string, UtilityResult> = {
  flex: ok({ display: 'flex' }),
  'inline-flex': approx({ display: 'flex' }, 'inline-flex lays out as flex'),
  grid: ok({ display: 'grid' }),
  'inline-grid': approx({ display: 'grid' }, 'inline-grid lays out as grid'),
  block: ok({ display: 'block' }),
  'inline-block': approx({ display: 'block' }, 'no inline formatting context'),
  inline: approx({ display: 'block' }, 'no inline formatting context'),
  hidden: ok({ display: 'none' }),
  contents: unsupported('display: contents'),
  table: unsupported('tables'),
  'sr-only': approx({ display: 'none' }, 'screen-reader-only text is not painted'),
  'not-sr-only': ok({}),
  'flex-row': ok({ flexDirection: 'row' }),
  'flex-col': ok({ flexDirection: 'column' }),
  'flex-row-reverse': ok({ flexDirection: 'row-reverse' }),
  'flex-col-reverse': ok({ flexDirection: 'column-reverse' }),
  'flex-wrap': ok({ flexWrap: 'wrap' }),
  'flex-nowrap': ok({ flexWrap: 'nowrap' }),
  'flex-1': ok({ flexGrow: 1, flexShrink: 1, flexBasis: 0 }),
  'flex-auto': ok({ flexGrow: 1, flexShrink: 1 }),
  'flex-initial': ok({ flexGrow: 0, flexShrink: 1 }),
  'flex-none': ok({ flexGrow: 0, flexShrink: 0 }),
  grow: ok({ flexGrow: 1 }),
  'grow-0': ok({ flexGrow: 0 }),
  'flex-grow': ok({ flexGrow: 1 }),
  'flex-grow-0': ok({ flexGrow: 0 }),
  shrink: ok({ flexShrink: 1 }),
  'shrink-0': ok({ flexShrink: 0 }),
  'flex-shrink': ok({ flexShrink: 1 }),
  'flex-shrink-0': ok({ flexShrink: 0 }),
  'items-start': ok({ alignItems: 'start' }),
  'items-end': ok({ alignItems: 'end' }),
  'items-center': ok({ alignItems: 'center' }),
  'items-baseline': ok({ alignItems: 'baseline' }),
  'items-stretch': ok({ alignItems: 'stretch' }),
  'self-start': ok({ alignSelf: 'start' }),
  'self-end': ok({ alignSelf: 'end' }),
  'self-center': ok({ alignSelf: 'center' }),
  'self-stretch': ok({ alignSelf: 'stretch' }),
  'self-baseline': ok({ alignSelf: 'baseline' }),
  'self-auto': ok({}),
  'justify-start': ok({ justifyContent: 'start' }),
  'justify-end': ok({ justifyContent: 'end' }),
  'justify-center': ok({ justifyContent: 'center' }),
  'justify-between': ok({ justifyContent: 'space-between' }),
  'justify-around': ok({ justifyContent: 'space-around' }),
  'justify-evenly': ok({ justifyContent: 'space-evenly' }),
  'content-start': ok({ alignContent: 'start' }),
  'content-center': ok({ alignContent: 'center' }),
  'content-end': ok({ alignContent: 'end' }),
  'content-between': ok({ alignContent: 'space-between' }),
  relative: ok({ position: 'relative' }),
  absolute: ok({ position: 'absolute' }),
  fixed: ok({ position: 'fixed' }),
  static: ok({}),
  sticky: unsupported('position: sticky'),
  ...Object.fromEntries(
    ['m', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me'].map((root) => [
      `${root}-auto`,
      unsupported('margin: auto; GPUIX margins are px only')
    ])
  ),
  'overflow-hidden': ok({ overflow: 'hidden' }),
  'overflow-clip': ok({ overflow: 'hidden' }),
  'overflow-visible': ok({ overflow: 'visible' }),
  'overflow-auto': ok({ overflow: 'scroll' }),
  'overflow-scroll': ok({ overflow: 'scroll' }),
  'overflow-x-hidden': ok({ overflowX: 'hidden' }),
  'overflow-y-hidden': ok({ overflowY: 'hidden' }),
  'overflow-x-auto': ok({ overflowX: 'scroll' }),
  'overflow-y-auto': ok({ overflowY: 'scroll' }),
  'overflow-x-scroll': ok({ overflowX: 'scroll' }),
  'overflow-y-scroll': ok({ overflowY: 'scroll' }),
  'overflow-x-visible': ok({ overflowX: 'visible' }),
  'overflow-y-visible': ok({ overflowY: 'visible' }),
  truncate: ok({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  'text-ellipsis': ok({ textOverflow: 'ellipsis' }),
  'text-clip': ok({}),
  'whitespace-nowrap': ok({ whiteSpace: 'nowrap' }),
  'whitespace-normal': ok({ whiteSpace: 'normal' }),
  'whitespace-pre': unsupported('white-space: pre; split lines into <text> rows'),
  'whitespace-pre-wrap': approx({ whiteSpace: 'normal' }, 'newlines and runs of spaces collapse'),
  'whitespace-pre-line': approx({ whiteSpace: 'normal' }, 'newlines collapse'),
  'whitespace-break-spaces': approx({ whiteSpace: 'normal' }, 'runs of spaces collapse'),
  'break-words': approx({}, 'GPUI wraps at word boundaries; overlong words are not broken'),
  'break-all': approx({}, 'GPUI wraps at word boundaries; overlong words are not broken'),
  'break-normal': ok({}),
  'wrap-break-word': approx({}, 'GPUI wraps at word boundaries; overlong words are not broken'),
  'text-wrap': ok({ whiteSpace: 'normal' }),
  'text-nowrap': ok({ whiteSpace: 'nowrap' }),
  'text-balance': approx({}, 'no balanced wrapping'),
  'text-pretty': approx({}, 'no pretty wrapping'),
  'text-left': ok({ textAlign: 'left' }),
  'text-center': ok({ textAlign: 'center' }),
  'text-right': ok({ textAlign: 'right' }),
  'text-start': ok({ textAlign: 'left' }),
  'text-end': ok({ textAlign: 'right' }),
  underline: ok({ textDecoration: 'underline' }),
  'line-through': ok({ textDecoration: 'line-through' }),
  'no-underline': ok({ textDecoration: 'none' }),
  italic: unsupported('font-style: GPUIX has no italic; register an italic family'),
  'not-italic': ok({}),
  uppercase: unsupported('text-transform: transform the string'),
  lowercase: unsupported('text-transform: transform the string'),
  capitalize: unsupported('text-transform: transform the string'),
  'normal-case': ok({}),
  // Rank -1: font-mono / font-sans in the same string still win.
  'tabular-nums': {
    kind: 'style',
    frag: { style: { fontFamily: TABULAR_FAMILY } },
    rank: -1,
    approx: 'frozen-tnum Inter family; replaces an inherited mono family'
  },
  'proportional-nums': ok({}),
  'slashed-zero': ok({}),
  antialiased: ok({}),
  'subpixel-antialiased': ok({}),
  'pointer-events-none': ok({ pointerEvents: 'none' }),
  'pointer-events-auto': ok({ pointerEvents: 'auto' }),
  'select-none': ok({ userSelect: 'none' }),
  'select-text': ok({ userSelect: 'text' }),
  'select-all': approx({ userSelect: 'text' }, 'no select-all on click'),
  'select-auto': ok({ userSelect: 'auto' }),
  visible: ok({ visibility: 'visible' }),
  invisible: ok({ visibility: 'hidden' }),
  'outline-none': ok({ outlineWidth: 0 }),
  'outline-hidden': ok({ outlineWidth: 0 }),
  isolate: ok({}),
  group: ok({}),
  peer: ok({}),
  'appearance-none': ok({}),
  'box-border': ok({}),
  'bg-clip-padding': ok({}),
  transform: unsupported(TRANSFORM),
  'transform-gpu': unsupported(TRANSFORM),
  container: unsupported('container queries and the container utility'),
  '@container': unsupported('container queries'),
  'label-panel': frag({
    style: { fontWeight: 500 },
    fontSize: { size: 12 },
    leading: { ratio: 1.4 }
  }),
  'label-section': frag({
    style: { fontWeight: 500 },
    fontSize: { size: 12 },
    leading: { ratio: 1.4 }
  }),
  'label-group': frag({
    style: { fontWeight: 500 },
    fontSize: { size: 12 },
    leading: { ratio: 1.4 }
  }),
  'scrollbar-hide': ok({}),
  'text-inherit': ok({}),
  'wrap-anywhere': approx({}, 'GPUI wraps at word boundaries; overlong words are not broken'),
  'w-fit': approx({ width: 'auto' }, 'fit-content sizes as auto'),
  'w-max': approx({ width: 'auto' }, 'max-content sizes as auto'),
  'w-min': approx({ width: 'auto' }, 'min-content sizes as auto'),
  'h-fit': approx({ height: 'auto' }, 'fit-content sizes as auto'),
  'w-screen': approx({ width: '100%' }, 'viewport units resolve against the parent'),
  'h-screen': approx({ height: '100%' }, 'viewport units resolve against the parent'),
  'align-baseline': unsupported('vertical-align: no inline formatting context'),
  'align-middle': unsupported('vertical-align: no inline formatting context'),
  'align-top': unsupported('vertical-align: no inline formatting context'),
  keycap: frag({}),
  'scroller-thin': approx({ scrollbarWidth: 6 }, 'thumb is painted, not draggable')
}

/** Component classes whose colours come from the theme (index.css @layer components). */
function componentClass(name: string, theme: TwTheme): UtilityResult | undefined {
  if (name === 'label-panel') {
    const base = KEYWORDS['label-panel'] as { frag: Fragment }
    return frag({
      ...base.frag,
      style: { ...base.frag.style, color: formatColor(theme.colors['muted-foreground']) }
    })
  }
  if (name === 'keycap') {
    // A component-layer box-shadow, not a shadow-* utility: flat elevation keeps it,
    // and a ring utility replaces it, as the cascade does.
    const shadows = parseShadowList(
      'inset 0 1px 0 oklch(var(--ring) / 0.08), 0 1px 2px #00000040',
      theme.vars
    )
    return ok({
      backgroundColor: formatColor(theme.colors.muted),
      boxShadow: shadows.reverse().map(toBoxShadow)
    })
  }
  return undefined
}

/** `negative` is the leading '-'; `utility` has variants and '!' removed. */
export function resolveUtility(utility: string, theme: TwTheme): UtilityResult | undefined {
  const negative = utility.startsWith('-')
  const name = negative ? utility.slice(1) : utility
  const component = componentClass(name, theme)
  if (component) return component
  if (!negative && name in KEYWORDS) return KEYWORDS[name]
  const { body, modifier } = splitModifier(name)
  const exact = HANDLERS[body]
  if (exact) {
    const result = exact({ value: '', modifier, negative, theme })
    if (result) return result
  }
  for (let dash = body.lastIndexOf('-'); dash > 0; dash = body.lastIndexOf('-', dash - 1)) {
    const root = body.slice(0, dash)
    const handler = HANDLERS[root]
    if (!handler || body.slice(0, dash).includes('[')) continue
    const result = handler({ value: body.slice(dash + 1), modifier, negative, theme })
    if (result) return result
  }
  return undefined
}

/** `bg-primary/50` -> body `bg-primary`, modifier `50`. Brackets are opaque. */
function splitModifier(name: string): { body: string; modifier?: string } {
  let depth = 0
  for (let i = name.length - 1; i >= 0; i--) {
    const ch = name[i]
    if (ch === ']' || ch === ')') depth++
    else if (ch === '[' || ch === '(') depth--
    else if (ch === '/' && depth === 0)
      return { body: name.slice(0, i), modifier: name.slice(i + 1) }
  }
  return { body: name }
}
