/**
 * tw('flex h-8 items-center gap-2 rounded-md bg-sidebar px-3 text-sm')
 * -> a GPUIX StyleDesc, using Termul's theme tokens.
 *
 * Each class string is compiled once per theme and cached. hover:, active:
 * and focus-visible: become GPUIX's native nested state styles. Variants that
 * depend on state GPUIX does not track (disabled:, group-hover:,
 * data-[state=open]:, ...) become rules applied from the TwState argument.
 * Unknown and unsupported classes are recorded and logged once, never dropped
 * silently.
 */
import type { StyleDesc } from '@gpuix/react'
import { log } from '../log'
import { type CssShadow, formatColor, type Rgba } from './css-value'
import { gradientBackground } from './gradient'
import { INHERITED_LEADING, ROOT_FONT_SIZE } from './scale'
import { resolveTwTheme, type TwTheme } from './theme'
import { type BoxShadow, type Fragment, type Ring, resolveUtility, toBoxShadow } from './utilities'
import {
  type Condition,
  conditionHolds,
  conditionKey,
  type NativeState,
  parseVariant,
  type TwState
} from './variants'

export type { TwState } from './variants'

export type ClassSupport =
  | { kind: 'supported' }
  | { kind: 'approximate' | 'unsupported' | 'unknown'; reason: string }

export interface ClassIssue {
  token: string
  kind: 'approximate' | 'unsupported' | 'unknown'
  reason: string
}

interface Rule {
  when: Condition[]
  native?: NativeState
  style: StyleDesc
}

/** `divide-x` / `divide-y`: a line between child elements, Tailwind's `> :not(:last-child)` border. */
export interface Divide {
  axis: 'x' | 'y'
  width: number
  color: string
}

export interface CompiledStyle {
  /** Unconditional style with native hover / active / focusVisible nested. */
  base: StyleDesc
  /** Drawn by the compat runtime between the element's children. */
  divide?: Divide
  /** State-dependent styles, applied in order by tw(classes, state). */
  rules: Rule[]
  issues: ClassIssue[]
}

/** Fragments merged for one bucket of identical conditions. */
interface Acc {
  style: StyleDesc
  shadow?: CssShadow[]
  ring?: Ring
  fontSize?: Fragment['fontSize']
  leading?: Fragment['leading']
  space?: Fragment['space']
  gradient?: Fragment['gradient']
  divide?: Fragment['divide']
}

interface Ranked {
  frag: Fragment
  rank: number
  index: number
}

/** Split `dark:hover:bg-x/50` at top-level colons. Brackets and parens are opaque. */
function parseToken(token: string): { variants: string[]; utility: string } {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of token) {
    if (ch === '[' || ch === '(') depth++
    if (ch === ']' || ch === ')') depth--
    if (ch === ':' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  return { variants: parts, utility: current.replace(/^!|!$/g, '') }
}

function accOf(frags: Ranked[]): Acc {
  const acc: Acc = { style: {} }
  for (const { frag } of [...frags].sort((a, b) => a.rank - b.rank || a.index - b.index)) {
    if (frag.style) Object.assign(acc.style, frag.style)
    if (frag.shadow) acc.shadow = frag.shadow
    if (frag.ring) acc.ring = { ...acc.ring, ...frag.ring }
    if (frag.fontSize) acc.fontSize = frag.fontSize
    if (frag.leading) acc.leading = frag.leading
    if (frag.space) acc.space = frag.space
    if (frag.gradient) acc.gradient = { ...acc.gradient, ...frag.gradient }
    if (frag.divide) acc.divide = { ...acc.divide, ...frag.divide }
  }
  return acc
}

/** GPUIX ignores an empty shadow list, so a state that clears shadows paints a clear one. */
const NO_SHADOW: BoxShadow = {
  offsetX: 0,
  offsetY: 0,
  blurRadius: 0,
  spreadRadius: 0,
  color: '#00000000'
}

function spread(px: number, color: Rgba, inset: boolean): CssShadow {
  return { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: px, color, inset }
}

function hexToRgba(hex: string): Rgba {
  const byte = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255
  return { r: byte(1), g: byte(3), b: byte(5), a: hex.length === 9 ? byte(7) : 1 }
}

/**
 * Fold Tailwind's composed properties into StyleDesc. `fallback` is the base
 * bucket: a state bucket that sets only ring-ring still uses the base ring width.
 */
function finalize(acc: Acc, theme: TwTheme, flat: boolean, fallback?: Acc): StyleDesc {
  const style: StyleDesc = { ...acc.style }
  if (acc.fontSize || acc.leading) {
    const size = acc.fontSize ?? fallback?.fontSize
    const leading = acc.leading ?? fallback?.leading
    const px = size?.size ?? ROOT_FONT_SIZE
    if (size) style.fontSize = size.size
    const lineHeight = leading
      ? 'px' in leading
        ? leading.px
        : leading.ratio * px
      : (size?.leading ?? INHERITED_LEADING) * px
    style.lineHeight = Math.round(lineHeight * 100) / 100
  }
  if (acc.gradient) {
    const background = gradientBackground({ ...fallback?.gradient, ...acc.gradient })
    if (background) style.background = background
  }
  if (acc.space) {
    const { axis, px } = acc.space
    style.display ??= 'flex'
    style.flexDirection ??= axis === 'y' ? 'column' : 'row'
    if (axis === 'y') style.rowGap = px
    else style.columnGap = px
  }
  if (acc.shadow || acc.ring) {
    const shadow = flat ? [] : (acc.shadow ?? fallback?.shadow ?? [])
    const ring: Ring = { ...fallback?.ring, ...acc.ring }
    // CSS lists the topmost shadow first; GPUIX paints in list order (last on top).
    const css: CssShadow[] = [...shadow].reverse()
    const width = ring.width ?? 0
    const current = style.color ?? fallback?.style.color ?? formatColor(theme.colors.foreground)
    const ringColor = ring.color ?? hexToRgba(current)
    // CSS draws an inset shadow inside the padding box; GPUI from the border
    // box edge, under the border. Growing it by the border width puts the ring
    // inside the border, as on the web.
    const border = Number(style.borderWidth ?? fallback?.style.borderWidth ?? 0)
    if (width > 0 && ring.inset) css.push(spread(width + border, ringColor, true))
    // GPUI paints a shadow under the whole box, so a spread ring on a transparent
    // button fills it; an outer ring is the outline that follows the corners.
    if (!ring.inset && (width > 0 || (fallback && acc.ring?.width !== undefined))) {
      style.outlineWidth = width
      style.outlineColor = formatColor(ringColor)
      const offset = ring.offsetWidth ?? 0
      if (offset > 0) style.outlineOffset = offset
    }
    if (css.length > 0) style.boxShadow = css.map(toBoxShadow)
    else if (fallback && (acc.shadow || fallback.shadow || fallback.ring?.inset)) style.boxShadow = NO_SHADOW
  }
  return style
}

const BORDER_WIDTH_KEYS = [
  'borderWidth',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth'
] as const

interface Bucket {
  when: Condition[]
  native?: NativeState
  frags: Ranked[]
}

export interface CompileOptions {
  /**
   * Termul light (flatElevation) drops shadow-* except on real buttons and
   * `data-keep-shadow` elements (index.css). Pass true for those.
   */
  keepShadow?: boolean
}

export function compile(
  classes: string,
  theme: TwTheme,
  options: CompileOptions = {}
): CompiledStyle {
  const flat = theme.flatElevation && options.keepShadow !== true
  const issues: ClassIssue[] = []
  const buckets = new Map<string, Bucket>()
  const tokens = classes.split(/\s+/).filter(Boolean)
  tokens.forEach((token, index) => {
    const { variants, utility } = parseToken(token)
    const when: Condition[] = []
    let native: NativeState | undefined
    // Variant utilities sort after plain ones in Tailwind's output, so they win.
    let variantRank = 0
    for (const variant of variants) {
      const parsed = parseVariant(variant)
      if (parsed.kind === 'unsupported') {
        issues.push({ token, kind: 'unsupported', reason: parsed.reason })
        return
      }
      if (parsed.kind === 'native') {
        if (native && native !== parsed.state) {
          issues.push({
            token,
            kind: 'unsupported',
            reason: 'GPUIX nests one state style per element'
          })
          return
        }
        native = parsed.state
      } else if (parsed.condition.kind === 'appearance') {
        if (parsed.condition.dark !== (theme.appearance === 'dark')) return
        variantRank = 100
      } else {
        when.push(parsed.condition)
      }
    }
    let result: ReturnType<typeof resolveUtility>
    try {
      result = resolveUtility(utility, theme)
    } catch (error) {
      issues.push({ token, kind: 'unknown', reason: (error as Error).message })
      return
    }
    if (!result) {
      issues.push({ token, kind: 'unknown', reason: `no utility ${utility}` })
      return
    }
    if (result.kind === 'unsupported') {
      issues.push({ token, kind: 'unsupported', reason: result.reason })
      return
    }
    if (result.approx) issues.push({ token, kind: 'approximate', reason: result.approx })
    if (result.frag.divide && (native || when.length > 0)) {
      issues.push({ token, kind: 'unsupported', reason: 'divide-* under a state variant' })
      return
    }
    const key = `${native ?? ''}|${when.map(conditionKey).join('&')}`
    const bucket = buckets.get(key) ?? { when, native, frags: [] }
    bucket.frags.push({ frag: result.frag, rank: result.rank + variantRank, index })
    buckets.set(key, bucket)
  })

  const baseAcc = accOf(buckets.get('|')?.frags ?? [])
  const base = finalize(baseAcc, theme, flat)
  // index.css: `* { @apply border-border }`.
  if (BORDER_WIDTH_KEYS.some((key) => key in base) && base.borderColor === undefined) {
    base.borderColor = formatColor(theme.colors.border)
  }
  const rules: Rule[] = []
  for (const [key, bucket] of buckets) {
    if (key === '|') continue
    const style = finalize(accOf(bucket.frags), theme, flat, baseAcc)
    if (bucket.when.length === 0 && bucket.native) {
      base[bucket.native] = { ...base[bucket.native], ...style }
    } else {
      rules.push({ when: bucket.when, native: bucket.native, style })
    }
  }
  const { axis, width = 1, color } = baseAcc.divide ?? {}
  if (axis === undefined) return { base, rules, issues }
  return { base, rules, issues, divide: { axis, width, color: formatColor(color ?? theme.colors.border) } }
}

/** CSS never matches :hover or :active on a pointer-events: none element. */
function dropPointerStates(style: StyleDesc): StyleDesc {
  if (style.pointerEvents !== 'none') return style
  const { hover: _hover, active: _active, ...rest } = style
  return rest
}

const NATIVE_STATES: readonly NativeState[] = ['hover', 'active', 'focusVisible']

/**
 * The native states a matching rule beats in Tailwind's variant order:
 * disabled:, data-*, aria-*, breakpoints and media variants sort after
 * hover/focus-visible/active; focus: sorts after hover only; group-* before all.
 */
function outranked(condition: Condition): readonly NativeState[] {
  if (condition.kind !== 'flag') return NATIVE_STATES
  switch (condition.flag) {
    case 'focus':
    case 'focusWithin':
      return ['hover']
    case 'groupHover':
    case 'groupFocus':
    case 'groupFocusVisible':
      return []
    default:
      return NATIVE_STATES
  }
}

function withoutKeys(style: StyleDesc | undefined, keys: string[]): StyleDesc | undefined {
  if (!style || !keys.some((key) => key in style)) return style
  const copy: Record<string, unknown> = { ...style }
  for (const key of keys) delete copy[key]
  return copy as StyleDesc
}

export function applyRules(compiled: CompiledStyle, state: TwState, dark: boolean): StyleDesc {
  if (compiled.rules.length === 0) return dropPointerStates(compiled.base)
  const out: StyleDesc = { ...compiled.base }
  for (const rule of compiled.rules) {
    if (!rule.when.every((c) => conditionHolds(c, state, dark))) continue
    if (rule.native) {
      out[rule.native] = { ...out[rule.native], ...rule.style }
      continue
    }
    Object.assign(out, rule.style)
    const keys = Object.keys(rule.style)
    for (const native of new Set(rule.when.flatMap(outranked))) {
      const kept = withoutKeys(out[native], keys)
      if (kept) out[native] = kept
    }
  }
  return dropPointerStates(out)
}

export interface Tw {
  (classes: string, state?: TwState): StyleDesc
  theme: TwTheme
  compile(classes: string): CompiledStyle
}

const loggedIssues = new Set<string>()

function logIssues(issues: ClassIssue[]): void {
  for (const issue of issues) {
    if (issue.kind === 'approximate' || loggedIssues.has(issue.token)) continue
    loggedIssues.add(issue.token)
    log.warn('style', `tw ${issue.kind} class "${issue.token}": ${issue.reason}`)
  }
}

export function createTw(theme: TwTheme): Tw {
  const cache = new Map<string, CompiledStyle>()
  const compileCached = (classes: string, keepShadow = false): CompiledStyle => {
    const key = keepShadow ? `${classes}\u0000keep` : classes
    let compiled = cache.get(key)
    if (!compiled) {
      compiled = compile(classes, theme, { keepShadow })
      cache.set(key, compiled)
      logIssues(compiled.issues)
    }
    return compiled
  }
  const tw = ((classes: string, state: TwState = {}) =>
    applyRules(compileCached(classes, state.keepShadow), state, theme.appearance === 'dark')) as Tw
  tw.theme = theme
  tw.compile = compileCached
  return tw
}

let active: Tw = createTw(resolveTwTheme('termul'))

/** Point the shared tw() at a bundled theme. Components re-render to pick it up. */
export function setTwTheme(themeId: string): void {
  if (active.theme.id !== themeId) active = createTw(resolveTwTheme(themeId))
}

export function tw(classes: string, state?: TwState): StyleDesc {
  return active(classes, state)
}

/** How tw() handles one class token, for the coverage scan. */
export function classifyClass(token: string, theme: TwTheme = active.theme): ClassSupport {
  const issue = compile(token, theme).issues[0]
  return issue ? { kind: issue.kind, reason: issue.reason } : { kind: 'supported' }
}
