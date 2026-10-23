/**
 * The DOM-shaped surface every GPUIX ui primitive shares: `className` through
 * tw(), `data-*` / `aria-*` attributes as tw() variant state, DOM-like event
 * objects, and bare strings wrapped in `<text>`. With these the web call sites
 * (`<Button className="h-8" onClick={(e) => …}>Save</Button>`) compile and run
 * against the GPUIX components unchanged.
 */
import type { EventPayload, KeyEvent, PublicInstance, StyleDesc } from '@gpuix/react'
import { createContext, forwardRef, type ReactElement, type ReactNode, type Ref, useContext } from 'react'
import { layoutChildren } from '../../compat/children'
import { ColorContext, SvgClassContext } from '../../compat/color'
import { buildElement, type DomProps, domAttrs, resolveStyle } from '../../compat/create'
import { nodeFor } from '../../compat/dom-node'
import { CompatEvent, domKey as compatDomKey } from '../../compat/events'
import { splitDescendantClasses as compatSplit, translation } from '../../compat/translate'
import type { TwState } from '../../style/tw'
import { WINDOW_WIDTH } from '../../window'
import { reducedMotion } from './motion'

type AttrValue = string | number | boolean | undefined
export type DataAttributes = { [key: `data-${string}`]: AttrValue }
export type AriaAttributes = { [key: `aria-${string}`]: AttrValue }

/** The DOM event a handler receives: the compat runtime's SyntheticEvent stand-in. */
export type UiMouseEvent = CompatEvent
export type UiKeyboardEvent = CompatEvent & { readonly key: string }
export type UiFocusEvent = CompatEvent

export function domKey(key: string | undefined): string {
  return compatDomKey(key) ?? ''
}

export function toMouseEvent(event: EventPayload): UiMouseEvent {
  return new CompatEvent(event.eventType, nodeFor(event.elementId), event)
}

export function toKeyboardEvent(event: KeyEvent): UiKeyboardEvent {
  return new CompatEvent(event.eventType, nodeFor(event.elementId), event) as UiKeyboardEvent
}

const toFocusEvent = (event: EventPayload): UiFocusEvent =>
  new CompatEvent(event.eventType, nodeFor(event.elementId), event)

/** DOM-shaped props a Termul ui primitive accepts on its host element. */
export interface HostProps extends DataAttributes, AriaAttributes {
  className?: string
  /** GPUIX style, merged over the className style (inline wins, like the DOM). */
  style?: StyleDesc
  children?: ReactNode
  id?: string
  role?: string
  title?: string
  tabIndex?: number
  autoFocus?: boolean
  onClick?: (event: UiMouseEvent) => void
  onAuxClick?: (event: UiMouseEvent) => void
  onContextMenu?: (event: UiMouseEvent) => void
  onDoubleClick?: (event: UiMouseEvent) => void
  onMouseDown?: (event: UiMouseEvent) => void
  onMouseUp?: (event: UiMouseEvent) => void
  onMouseEnter?: (event: UiMouseEvent) => void
  onMouseLeave?: (event: UiMouseEvent) => void
  onMouseMove?: (event: UiMouseEvent) => void
  onPointerDown?: (event: UiMouseEvent) => void
  onPointerEnter?: (event: UiMouseEvent) => void
  onPointerLeave?: (event: UiMouseEvent) => void
  onKeyDown?: (event: UiKeyboardEvent) => void
  onKeyUp?: (event: UiKeyboardEvent) => void
  onFocus?: (event: UiFocusEvent) => void
  onBlur?: (event: UiFocusEvent) => void
}

/** Native props of a GPUIX `div`, as the reconciler takes them. */
export interface NativeDivProps {
  style?: StyleDesc
  testId?: string
  role?: string
  'aria-label'?: string
  'aria-expanded'?: boolean
  'aria-selected'?: boolean
  'aria-description'?: string
  tabIndex?: number
  autoFocus?: boolean
  onClick?: (event: EventPayload) => void
  onAuxClick?: (event: EventPayload) => void
  onMouseDown?: (event: EventPayload) => void
  onMouseUp?: (event: EventPayload) => void
  onMouseEnter?: (event: EventPayload) => void
  onMouseLeave?: (event: EventPayload) => void
  onMouseMove?: (event: EventPayload) => void
  onMouseDownOutside?: (event: EventPayload) => void
  onKeyDown?: (event: KeyEvent) => void
  onKeyUp?: (event: KeyEvent) => void
  onFocus?: (event: EventPayload) => void
  onBlur?: (event: EventPayload) => void
}

type Handler<E> = ((event: E) => void) | undefined

function both<E>(a: Handler<E>, b: Handler<E>): Handler<E> {
  if (!a) return b
  if (!b) return a
  return (event) => {
    a(event)
    b(event)
  }
}

const mouse = (handler: Handler<UiMouseEvent>): Handler<EventPayload> =>
  handler && ((event) => handler(toMouseEvent(event)))

/** Translate DOM-shaped handlers to GPUIX ones. */
export function nativeHandlers(props: HostProps): NativeDivProps {
  const doubleClick = props.onDoubleClick
  const onClick = both(
    props.onClick,
    doubleClick &&
      ((event: UiMouseEvent) => {
        if (event.detail === 2) doubleClick(event)
      })
  )
  const aux = both(
    props.onAuxClick,
    props.onContextMenu &&
      ((event: UiMouseEvent) => {
        if (event.button === 2) props.onContextMenu?.(event)
      })
  )
  return {
    onClick: mouse(onClick),
    onAuxClick: mouse(aux),
    onMouseDown: mouse(both(props.onMouseDown, props.onPointerDown)),
    onMouseUp: mouse(props.onMouseUp),
    onMouseEnter: mouse(both(props.onMouseEnter, props.onPointerEnter)),
    onMouseLeave: mouse(both(props.onMouseLeave, props.onPointerLeave)),
    onMouseMove: mouse(props.onMouseMove),
    onKeyDown: props.onKeyDown && ((event) => props.onKeyDown?.(toKeyboardEvent(event))),
    onKeyUp: props.onKeyUp && ((event) => props.onKeyUp?.(toKeyboardEvent(event))),
    onFocus: props.onFocus && ((event) => props.onFocus?.(toFocusEvent(event))),
    onBlur: props.onBlur && ((event) => props.onBlur?.(toFocusEvent(event)))
  }
}

/** Text colour of the nearest ancestor that sets one: what `currentColor` is to an icon. */
export const CurrentColorContext = ColorContext

export { SvgClassContext }

/** Layout facts a tw() variant reads that GPUIX does not track per element. */
export interface UiEnvironment {
  viewportWidth: number
  reducedMotion: boolean
}

export const UiEnvironmentContext = createContext<UiEnvironment>({
  viewportWidth: WINDOW_WIDTH,
  reducedMotion: reducedMotion()
})

export const splitDescendantClasses = compatSplit

/** The element's style: the compat translation of its classes under the given variant state. */
export function useTw(className: string | undefined, state: TwState = {}, props: object = {}) {
  const env = useContext(UiEnvironmentContext)
  const tr = translation('div', className)
  const style = resolveStyle(tr, {
    viewportWidth: env.viewportWidth,
    reducedMotion: env.reducedMotion,
    ...state,
    attrs: { ...(domAttrs(props as DomProps) as TwState['attrs']), ...state.attrs }
  })
  return { style, svgClasses: tr.svgClasses ?? undefined }
}

const FLEX_TEXT = translation('div', 'flex')

/** Bare strings and numbers as text nodes; adjacent ones (`⌘{key}`) share one, as they share a line box. */
export function wrapText(children: ReactNode): ReactNode {
  return layoutChildren(FLEX_TEXT, FLEX_TEXT.base, children, false).children
}

/** Provide the resolved text colour and `[&_svg]` classes to the subtree. */
export function Inherit({
  color,
  svgClasses,
  children
}: {
  color?: string
  svgClasses?: string
  children: ReactNode
}): ReactNode {
  let out = children
  if (svgClasses !== undefined)
    out = <SvgClassContext.Provider value={svgClasses}>{out}</SvgClassContext.Provider>
  if (color !== undefined) out = <ColorContext.Provider value={color}>{out}</ColorContext.Provider>
  return out
}

export interface BoxProps extends HostProps {
  /** Variant state the caller knows: disabled, focus, data-state, … */
  state?: TwState
  /** Extra native props (focus handles, outside-press) set by a primitive. */
  native?: NativeDivProps
}

/**
 * A `div` styled by its className, built by the compat runtime: attributes
 * become tw() state, strings become text, handlers get DOM-shaped events that
 * bubble like the DOM's, and `data-testid` becomes the automation `testId`.
 * The forwarded ref is the GPUIX instance.
 */
export const Box = forwardRef<PublicInstance, BoxProps>(function Box(props, ref): ReactElement {
  const { className, style, state, native, ...rest } = props
  const env = useContext(UiEnvironmentContext)
  const tr = translation('div', className)
  const resolved = resolveStyle(tr, {
    viewportWidth: env.viewportWidth,
    reducedMotion: env.reducedMotion,
    ...state,
    attrs: { ...(domAttrs(rest as DomProps) as TwState['attrs']), ...state?.attrs }
  })
  const dom = { ...rest, className, ref } as unknown as DomProps
  return buildElement('div', tr, dom, undefined, false, {
    style: resolved,
    nativeStyle: style,
    native: native as Record<string, unknown> | undefined,
    instanceRef: true
  })
})

/** Merge refs, for primitives that keep their own ref and forward the caller's. */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): (value: T | null) => void {
  return (value) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(value)
      else if (ref) (ref as { current: T | null }).current = value
    }
  }
}
