/**
 * `jsx('div', { className, onClick, ref, … })` from shared code ->
 * a GPUIX element. Everything is decided here, at element creation, from the
 * translation cache: no per-element component, no context read. Only an
 * element whose classes depend on state GPUIX does not track (group-*,
 * focus:, focus-within:, viewport variants) or that declares a `group` is
 * handed to the stateful `CompatHost`.
 */

import type { StyleDesc } from '@gpuix/react'
import { cloneElement, type ReactElement, type ReactNode, type Ref } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { applyRules } from '../style/tw'
import type { TwState } from '../style/variants'
import { checkboxElement } from './checkbox'
import { childInfo, contentBasis, layoutChildren, wrapAutoMargin } from './children'
import { ColorContext, SvgClassContext } from './color'
import { ScopeContext, withScopedClasses } from './scope'
import { decorateInstance, type DomInfo, nodeFor, type TrackedInstance, trackInstance } from './dom-node'
import { convertDomStyle } from './dom-style'
import { adaptHandlers, addFormListeners, addOccluderListeners, type GpuixListeners } from './events'
import { compatWarn } from './log'
import { percentPlacement, placeStyle, wrapFillMinus } from './placement'
import { layoutListener } from './resize'
import { SVG_CHILD_TAGS, svgElement } from './svg'
import { translation, type Translation, unreverse } from './translate'

export type DomProps = Readonly<Record<string, unknown>> & {
  className?: string
  style?: Readonly<Record<string, string | number>>
  children?: ReactNode
  ref?: Ref<unknown>
}

const FOCUSABLE_TAGS = new Set(['button', 'input', 'textarea', 'select', 'summary'])
const DISABLEABLE = new Set(['button', 'input', 'textarea', 'select', 'fieldset'])
const SKIPPED = new Set(['script', 'style', 'template', 'noscript', 'head', 'meta', 'link'])
const UNSUPPORTED_TAGS = new Set(['iframe', 'canvas', 'video', 'audio', 'object', 'embed', 'webview'])
const ATTR_PROPS = new Set(['id', 'role', 'type', 'href', 'name', 'title', 'tabIndex', 'disabled', 'htmlFor', 'value', 'checked', 'placeholder', 'draggable'])
/** GPUIX ignores `display: none` (measured): a hidden element is an empty, zero-size, unpainted box. */
const HIDDEN: StyleDesc = { position: 'absolute', width: 0, height: 0, overflow: 'hidden', visibility: 'hidden' }
const BREAK: StyleDesc = { width: '100%', height: 0 }
const NO_ATTRS: Readonly<Record<string, unknown>> = Object.freeze({})

export function domAttrs(props: DomProps): Readonly<Record<string, unknown>> {
  let attrs: Record<string, unknown> | null = null
  for (const key in props) {
    if (ATTR_PROPS.has(key) || key.startsWith('data-') || key.startsWith('aria-')) {
      const value = props[key]
      if (value === undefined) continue
      attrs ??= {}
      attrs[key] = value
    }
  }
  return attrs ?? NO_ATTRS
}

/** CSS `:disabled` and data/aria variants read these. */
function twState(attrs: Readonly<Record<string, unknown>>, disabled: boolean): TwState {
  return { disabled, attrs: attrs as TwState['attrs'] }
}

const propStyles = new WeakMap<Translation, Map<string, StyleDesc>>()

/** Style for a 'props' translation; cached per distinct attribute set. */
function propsStyle(tr: Translation, attrs: Readonly<Record<string, unknown>>, disabled: boolean): StyleDesc {
  let byKey = propStyles.get(tr)
  if (!byKey) {
    byKey = new Map()
    propStyles.set(tr, byKey)
  }
  const key = disabled ? `!${JSON.stringify(attrs)}` : JSON.stringify(attrs)
  let style = byKey.get(key)
  if (!style) {
    style = applyRules({ ...tr.compiled, base: tr.base }, twState(attrs, disabled), compatDark())
    byKey.set(key, style)
  }
  return style
}

let dark = true
export function setCompatAppearance(isDark: boolean): void {
  dark = isDark
}
export function compatDark(): boolean {
  return dark
}

const passive = new WeakMap<StyleDesc, StyleDesc>()

/**
 * GPUIX ends a mouse hit at the first element with an opaque fill. CSS does
 * not: a click on a plain coloured box reaches the button around it. A
 * passive in-flow box therefore lets the pointer through. Absolutely placed
 * boxes keep blocking, as overlays and backdrops must.
 */
function passThrough(style: StyleDesc): StyleDesc {
  if (style.pointerEvents !== undefined || style.backgroundColor === undefined) return style
  if (style.position === 'absolute' || style.position === 'fixed') return style
  let hit = passive.get(style)
  if (!hit) {
    hit = { ...style, pointerEvents: 'none' }
    passive.set(style, hit)
  }
  return hit
}

/** GPUIX's `should_occlude`: the boxes that end a mouse hit test. */
function occludes(style: StyleDesc): boolean {
  if (style.pointerEvents === 'none') return false
  if (style.pointerEvents === 'auto' || style.position === 'absolute' || style.position === 'fixed') return true
  const fill = style.backgroundColor
  return (fill !== undefined && fill !== 'transparent') || (style as { background?: unknown }).background !== undefined
}

type AdaptedRef = (instance: TrackedInstance | null) => (() => void) | undefined
const composedRefs = new WeakMap<object, AdaptedRef>()
const instanceRefs = new WeakMap<object, AdaptedRef>()

/**
 * Track the instance and hand the user's ref a CompatElement, or with
 * `raw` the GPUIX instance itself (GPUIX-native primitives). Cached per ref
 * so identity is stable across renders.
 */
function adaptRef(ref: Ref<unknown>, raw = false): AdaptedRef {
  const cache = raw ? instanceRefs : composedRefs
  const cached = cache.get(ref as object)
  if (cached) return cached
  const adapted = (instance: TrackedInstance | null) => {
    if (!instance) return undefined
    const untrack = trackInstance(instance)
    const node = raw ? decorateInstance(instance) : nodeFor(instance.id)
    let cleanup: unknown
    if (typeof ref === 'function') cleanup = ref(node)
    else if (ref) (ref as { current: unknown }).current = node
    return () => {
      untrack?.()
      if (typeof cleanup === 'function') cleanup()
      else if (typeof ref === 'function') ref(null)
      else if (ref) (ref as { current: unknown }).current = null
    }
  }
  cache.set(ref as object, adapted)
  return adapted
}

/** A translation's style under explicit variant state (focus, group hover, viewport…). */
export function resolveStyle(tr: Translation, state: TwState): StyleDesc {
  if (tr.compiled.rules.length === 0) return tr.base
  return applyRules({ ...tr.compiled, base: tr.base }, state, compatDark())
}

export interface BuildOverrides {
  /** Resolved style from a stateful host, instead of the translation's own. */
  style?: StyleDesc
  /** Handlers a host adds in front of the component's. */
  handlers?: Record<string, unknown>
  /** A GPUIX StyleDesc merged last (a GPUIX primitive's `style` prop). */
  nativeStyle?: StyleDesc
  /** Extra GPUIX props (focus handles, outside press); listeners run after the compat ones. */
  native?: Record<string, unknown>
  /** Hand `props.ref` the GPUIX instance rather than a CompatElement. */
  instanceRef?: boolean
}

function both(a: unknown, b: unknown): unknown {
  if (typeof a !== 'function') return b
  if (typeof b !== 'function') return a
  return (event: unknown) => {
    ;(a as (e: unknown) => void)(event)
    ;(b as (e: unknown) => void)(event)
  }
}

/** Build the GPUIX element for one DOM element. Shared by the runtime and `CompatHost`. */
export function buildElement(
  tag: string,
  tr: Translation,
  props: DomProps,
  key: string | undefined,
  isStatic: boolean,
  overrides?: BuildOverrides
): ReactElement {
  const attrs = domAttrs(props)
  const disabled = DISABLEABLE.has(tag) && Boolean(props.disabled)
  let style =
    overrides?.style ?? (tr.ruleMode === 'props' ? propsStyle(tr, attrs, disabled) : tr.base)
  if (props.hidden === true || style.display === 'none') {
    const ref = props.ref != null ? adaptRef(props.ref, overrides?.instanceRef) : undefined
    return jsx('div', { style: HIDDEN, ref }, key)
  }
  if (props.style) style = { ...style, ...convertDomStyle(props.style) }
  if (overrides?.nativeStyle) style = { ...style, ...overrides.nativeStyle }
  const placed = tr.placement ? placeStyle(style, tr.placement) : null
  if (placed) style = placed.inner
  const percent = placed ? null : percentPlacement(style)
  if (percent) style = percent.inner
  const pointerEvents = style.pointerEvents

  const listeners: GpuixListeners = {}
  const source = overrides?.handlers ? { ...props, ...overrides.handlers } : props
  const checkbox = tag === 'input' && props.type === 'checkbox'
  const text = !checkbox && (tag === 'input' || tag === 'textarea')
  const focusable =
    !disabled &&
    (FOCUSABLE_TAGS.has(tag) || (tag === 'a' && props.href !== undefined) || props.tabIndex !== undefined)
  const draggable = source.draggable === true || source.draggable === 'true'
  const handlers = disabled ? null : adaptHandlers(source, text, focusable, listeners, draggable)
  if (!disabled) addFormListeners(tag, props.type, listeners)
  const interactive = handlers !== null || focusable || tr.hoverable || style.overflow === 'scroll' || listeners.onClick !== undefined
  if (!interactive) style = passThrough(style)
  const occluder = occludes(style)
  if (occluder) addOccluderListeners(listeners, disabled)

  const userRef = props.ref
  const tracked =
    userRef != null || handlers !== null || focusable || attrs !== NO_ATTRS || pointerEvents !== undefined || listeners.onClick !== undefined || occluder
  const dom: DomInfo = {
    tag,
    className: props.className ?? '',
    attrs,
    handlers,
    value: typeof props.value === 'string' ? props.value : undefined,
    pointerEvents
  }
  const native: Record<string, unknown> = { style, __dom: dom, ...listeners }
  if (overrides?.native) {
    for (const [name, value] of Object.entries(overrides.native)) native[name] = both(native[name], value)
  }
  if (tracked) native.ref = userRef != null ? adaptRef(userRef, overrides?.instanceRef) : trackInstance
  if (userRef != null) native.onLayout = layoutListener
  const testId = props['data-testid']
  if (typeof testId === 'string') native.testId = testId
  if (typeof props.role === 'string') native.role = props.role
  if (typeof props['aria-label'] === 'string') native['aria-label'] = props['aria-label']
  if (typeof props.tabIndex === 'number') native.tabIndex = props.tabIndex
  else if (focusable && native.tabIndex === undefined) native.tabIndex = 0
  if (props.autoFocus === true) native.autoFocus = true

  let element: ReactElement
  if (tr.type === 'svg') {
    element = svgElement(props, style, native, key)
  } else if (tr.type === 'img') {
    native.src = props.src
    element = jsx('img', native, key)
  } else if (checkbox) {
    element = checkboxElement(props.className ?? '', style, Boolean(props.checked ?? props.defaultChecked), disabled, native, key)
  } else if (text) {
    const type = props.type
    if (type === 'radio' || type === 'file' || type === 'hidden' || type === 'range') {
      compatWarn('element-unsupported', `input[type=${String(type)}]`)
      return jsx('div', { style: HIDDEN }, key)
    }
    if (props.value !== undefined) native.value = String(props.value ?? '')
    else if (props.defaultValue !== undefined) native.value = String(props.defaultValue)
    if (typeof props.placeholder === 'string') native.placeholder = props.placeholder
    if (tag === 'textarea' && typeof props.rows === 'number') native.minRows = props.rows
    element = jsx(tag, native, key)
  } else {
    if (props.dangerouslySetInnerHTML) compatWarn('prop-unsupported', 'dangerouslySetInnerHTML')
    const flipped = unreverse(style)
    if (flipped) native.style = style = flipped
    const contentSized = tr.flexDirection === 'column' && style.height === undefined && style.maxHeight !== undefined
    const children = contentSized ? contentBasis(props.children) : props.children
    const laid = layoutChildren(tr, style, children, isStatic, flipped !== null)
    if (laid.runStyle) native.style = { ...style, ...laid.runStyle }
    const nested = laid.children !== undefined && typeof laid.children !== 'string'
    let kids: ReactNode = laid.children
    let wrapped = false
    if (nested && style.color !== undefined) {
      kids = (laid.isStatic ? jsxs : jsx)(ColorContext.Provider, { value: style.color, children: kids })
      wrapped = true
    }
    if (nested && tr.svgClasses) {
      kids = (laid.isStatic && !wrapped ? jsxs : jsx)(SvgClassContext.Provider, { value: tr.svgClasses, children: kids })
      wrapped = true
    }
    if (nested && tr.scope) {
      kids = (laid.isStatic && !wrapped ? jsxs : jsx)(ScopeContext.Provider, { value: tr.scope, children: kids })
      wrapped = true
    }
    native.children = kids
    const leaf = typeof laid.children === 'string' && tr.inline
    element = (laid.isStatic && native.children === laid.children ? jsxs : jsx)(leaf ? 'text' : 'div', native, key)
    if (leaf && !tracked && !tr.paints) {
      childInfo.set(element, { inline: true, run: { text: laid.children as string, style } })
    }
  }
  if (!childInfo.has(element)) childInfo.set(element, { inline: tr.inline })
  if (placed) return placed.wrap(element, key)
  if (percent) return percent.wrap(element, key)
  if (tr.fillMinus !== null) {
    const m = tr.autoMargin
    const side = m?.left && m.right ? 'both' : m?.left ? 'left' : 'right'
    const grown = cloneElement(element as ReactElement<{ style?: StyleDesc }>, {
      style: { ...(element.props as { style?: StyleDesc }).style, flexGrow: 1, minWidth: 0 }
    })
    return wrapFillMinus(grown, tr.fillMinus, side, key)
  }
  if (tr.fixed) {
    return jsx('anchored' as never, { fill: 'window', style: { backgroundColor: 'transparent' }, children: element }, key)
  }
  if (tr.autoMargin) return wrapAutoMargin(element, tr.autoMargin, key)
  return element
}

/** The runtime entry for string types. `CompatHost` handles 'host' translations. */
export function createDomElement(
  tag: string,
  props: DomProps,
  key: string | undefined,
  isStatic: boolean,
  host: (tag: string, tr: Translation, props: DomProps, key: string | undefined, isStatic: boolean) => ReactElement
): ReactElement {
  if (SKIPPED.has(tag)) return jsx('div', { style: HIDDEN }, key)
  if (tag === 'br' || tag === 'wbr') return jsx('div', { style: tag === 'br' ? BREAK : HIDDEN }, key)
  if (UNSUPPORTED_TAGS.has(tag)) compatWarn('element-unsupported', tag)
  if (SVG_CHILD_TAGS.has(tag)) return jsx(tag as never, props, key)
  const className = withScopedClasses(tag, props['data-streamdown'], props.className)
  const tr = translation(tag, className)
  const element =
    tr.ruleMode === 'host' || tr.group !== null
      ? host(tag, tr, props, key, isStatic)
      : buildElement(tag, tr, props, key, isStatic)
  domSource.set(element, { tag, props, key })
  if (tag === 'textarea') childInfo.set(element, { inline: true, ...childInfo.get(element), baselineAtBottom: true })
  return element
}

/** The DOM element a compat element was made from, so `cloneElement` can re-translate it. */
export interface DomSource {
  tag: string
  props: DomProps
  key: string | undefined
}

export const domSource = new WeakMap<object, DomSource>()

/** The DOM props a compat element was created with, or undefined for any other element. */
export function domPropsOf(element: unknown): DomProps | undefined {
  return element !== null && typeof element === 'object' ? domSource.get(element)?.props : undefined
}
