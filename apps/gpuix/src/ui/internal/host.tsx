/**
 * The DOM-shaped surface every GPUIX ui primitive shares: `className` through
 * tw(), `data-*` / `aria-*` attributes as tw() variant state, DOM-like event
 * objects, and bare strings wrapped in `<text>`. With these the web call sites
 * (`<Button className="h-8" onClick={(e) => …}>Save</Button>`) compile and run
 * against the GPUIX components unchanged.
 */
import type { EventPayload, KeyEvent, PublicInstance, StyleDesc } from '@gpuix/react'
import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  type ReactNode,
  type Ref,
  useContext
} from 'react'
import { type TwState, tw } from '../../style/tw'
import { WINDOW_WIDTH } from '../../window'
import { reducedMotion } from './motion'

type AttrValue = string | number | boolean | undefined
export type DataAttributes = { [key: `data-${string}`]: AttrValue }
export type AriaAttributes = { [key: `aria-${string}`]: AttrValue }

/** The parts of a DOM MouseEvent that Termul handlers read. */
export interface UiMouseEvent {
  type: string
  clientX: number
  clientY: number
  button: number
  /** Click count, like `MouseEvent.detail`. */
  detail: number
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  defaultPrevented: boolean
  preventDefault(): void
  stopPropagation(): void
  nativeEvent: EventPayload
}

/** The parts of a DOM KeyboardEvent that Termul handlers read, with DOM key names. */
export interface UiKeyboardEvent {
  type: string
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  repeat: boolean
  readonly defaultPrevented: boolean
  preventDefault(): void
  stopPropagation(): void
  nativeEvent: KeyEvent
}

export interface UiFocusEvent {
  type: string
  nativeEvent: EventPayload
}

/** GPUI key names that differ from `KeyboardEvent.key`. */
const DOM_KEYS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  space: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}

export function domKey(key: string | undefined): string {
  if (!key) return ''
  return DOM_KEYS[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key)
}

export function toMouseEvent(event: EventPayload): UiMouseEvent {
  let prevented = false
  const mods = event.modifiers
  return {
    type: event.eventType,
    clientX: event.x ?? 0,
    clientY: event.y ?? 0,
    button: event.button ?? (event.isRightClick ? 2 : 0),
    detail: event.clickCount ?? 1,
    shiftKey: mods?.shift ?? false,
    ctrlKey: mods?.ctrl ?? false,
    altKey: mods?.alt ?? false,
    metaKey: mods?.cmd ?? false,
    get defaultPrevented() {
      return prevented
    },
    preventDefault: () => {
      prevented = true
    },
    // GPUI clicks do not bubble, so there is nothing to stop.
    stopPropagation: () => {},
    nativeEvent: event
  }
}

export function toKeyboardEvent(event: KeyEvent): UiKeyboardEvent {
  const mods = event.modifiers
  return {
    type: event.eventType,
    key:
      event.keyChar && event.keyChar.length === 1 && !DOM_KEYS[event.key ?? '']
        ? event.keyChar
        : domKey(event.key),
    shiftKey: mods?.shift ?? false,
    ctrlKey: mods?.ctrl ?? false,
    altKey: mods?.alt ?? false,
    metaKey: mods?.cmd ?? false,
    repeat: event.isHeld ?? false,
    get defaultPrevented() {
      return event.defaultPrevented
    },
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    nativeEvent: event
  }
}

const toFocusEvent = (event: EventPayload): UiFocusEvent => ({
  type: event.eventType,
  nativeEvent: event
})

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

/** `data-*` and `aria-*` props, the attribute half of tw()'s variant state. */
export function attributesOf(props: object): Record<string, string | boolean | undefined> {
  const attrs: Record<string, string | boolean | undefined> = {}
  for (const [key, value] of Object.entries(props)) {
    if (!key.startsWith('data-') && !key.startsWith('aria-')) continue
    attrs[key] = typeof value === 'number' ? String(value) : (value as string | boolean | undefined)
  }
  return attrs
}

const HOST_KEYS = new Set<string>([
  'className',
  'style',
  'children',
  'id',
  'role',
  'title',
  'tabIndex',
  'autoFocus',
  'onClick',
  'onAuxClick',
  'onContextMenu',
  'onDoubleClick',
  'onMouseDown',
  'onMouseUp',
  'onMouseEnter',
  'onMouseLeave',
  'onMouseMove',
  'onPointerDown',
  'onPointerEnter',
  'onPointerLeave',
  'onKeyDown',
  'onKeyUp',
  'onFocus',
  'onBlur'
])

/** Split HostProps from a component's own props (variant, size, asChild, …). */
export function splitHostProps<P extends HostProps>(props: P): HostProps {
  const host: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if (HOST_KEYS.has(key) || key.startsWith('data-') || key.startsWith('aria-')) host[key] = value
  }
  return host as HostProps
}

/** Text colour of the nearest ancestor that sets one: what `currentColor` is to an icon. */
export const CurrentColorContext = createContext<string | undefined>(undefined)

/** `[&_svg]:…` classes of an ancestor: they size every icon below it, as the descendant selector does. */
export const SvgClassContext = createContext<string | undefined>(undefined)

/** Layout facts a tw() variant reads that GPUIX does not track per element. */
export interface UiEnvironment {
  viewportWidth: number
  reducedMotion: boolean
}

export const UiEnvironmentContext = createContext<UiEnvironment>({
  viewportWidth: WINDOW_WIDTH,
  reducedMotion: reducedMotion()
})

interface SplitClasses {
  own: string
  svg?: string
}

const splitCache = new Map<string, SplitClasses>()

/** Pull `[&_svg]:x` tokens out of a class string; tw() cannot select descendants. */
export function splitDescendantClasses(classes: string): SplitClasses {
  const cached = splitCache.get(classes)
  if (cached) return cached
  const own: string[] = []
  const svg: string[] = []
  for (const token of classes.split(/\s+/)) {
    if (!token) continue
    if (token.startsWith('[&_svg]:')) svg.push(token.slice('[&_svg]:'.length))
    else if (token.startsWith('[&>svg]:')) svg.push(token.slice('[&>svg]:'.length))
    else own.push(token)
  }
  const split = { own: own.join(' '), svg: svg.length > 0 ? svg.join(' ') : undefined }
  splitCache.set(classes, split)
  return split
}

/**
 * `ml-auto` and friends: GPUIX margins are px only. In a flex row an auto
 * margin hands the free space to that side, so the element grows and places
 * its content at the far end, which paints the same.
 */
const AUTO_MARGIN: Record<string, StyleDesc> = {
  'ml-auto': { flexGrow: 1, display: 'flex', justifyContent: 'end' },
  'ms-auto': { flexGrow: 1, display: 'flex', justifyContent: 'end' },
  'mr-auto': { flexGrow: 1, display: 'flex', justifyContent: 'start' },
  'me-auto': { flexGrow: 1, display: 'flex', justifyContent: 'start' },
  'mx-auto': { flexGrow: 1, display: 'flex', justifyContent: 'center' }
}

function autoMargins(own: string): { rest: string; style?: StyleDesc } {
  if (!own.includes('-auto')) return { rest: own }
  let style: StyleDesc | undefined
  const rest = own
    .split(' ')
    .filter((token) => {
      const auto = AUTO_MARGIN[token]
      if (auto) style = { ...style, ...auto }
      return !auto
    })
    .join(' ')
  return { rest, style }
}

/** tw() with the element's attributes, the viewport and the reduced-motion flag. */
export function useTw(className: string | undefined, state: TwState = {}, props: object = {}) {
  const env = useContext(UiEnvironmentContext)
  const split = splitDescendantClasses(className ?? '')
  const { rest: own, style: auto } = autoMargins(split.own)
  const svg = split.svg
  const computed = tw(own, {
    viewportWidth: env.viewportWidth,
    reducedMotion: env.reducedMotion,
    ...state,
    attrs: { ...attributesOf(props), ...state.attrs }
  })
  return { style: auto ? { ...auto, ...computed } : computed, svgClasses: svg }
}

/**
 * Wrap bare strings and numbers in `<text>`, the only GPUIX element that paints
 * text. Adjacent ones (`⌘{key}`) share one `<text>`, as they share a line box.
 */
export function wrapText(children: ReactNode): ReactNode {
  const out: ReactNode[] = []
  let run: string | null = null
  let hasText = false
  const flush = () => {
    if (run !== null) out.push(<text key={`t${out.length}`}>{run}</text>)
    run = null
  }
  Children.forEach(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      hasText = true
      run = (run ?? '') + String(child)
    } else if (child !== null && child !== undefined && typeof child !== 'boolean') {
      flush()
      out.push(child)
    }
  })
  if (!hasText) return children
  flush()
  return out
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
  if (color !== undefined)
    out = <CurrentColorContext.Provider value={color}>{out}</CurrentColorContext.Provider>
  return out
}

export interface BoxProps extends HostProps {
  /** Variant state the caller knows: disabled, focus, data-state, … */
  state?: TwState
  /** Extra native props (focus handles, outside-press) set by a primitive. */
  native?: NativeDivProps
}

/**
 * A `div` styled by its className. The workhorse of every primitive here:
 * attributes become tw() state, strings become `<text>`, handlers get
 * DOM-shaped events, and `data-testid` becomes the automation `testId`.
 */
export const Box = forwardRef<PublicInstance, BoxProps>(function Box(props, ref) {
  const { className, style, children, state, native, role, tabIndex, autoFocus } = props
  const { style: twStyle, svgClasses } = useTw(className, state, props)
  const merged: StyleDesc = style ? { ...twStyle, ...style } : twStyle
  const handlers = nativeHandlers(props)
  const nativeProps: NativeDivProps = { ...handlers }
  if (native) {
    for (const [key, value] of Object.entries(native) as [keyof NativeDivProps, unknown][]) {
      const own = nativeProps[key] as Handler<unknown>
      ;(nativeProps as Record<string, unknown>)[key] =
        typeof value === 'function' && typeof own === 'function'
          ? both(own, value as Handler<unknown>)
          : value
    }
  }
  return (
    <div
      ref={ref as Ref<PublicInstance>}
      {...nativeProps}
      style={merged}
      testId={props['data-testid'] as string | undefined}
      role={role}
      aria-label={props['aria-label'] as string | undefined}
      tabIndex={nativeProps.tabIndex ?? tabIndex}
      autoFocus={autoFocus}
    >
      <Inherit color={merged.color as string | undefined} svgClasses={svgClasses}>
        {wrapText(children)}
      </Inherit>
    </div>
  )
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

/** True for a React element child (the `asChild` target). */
export const isElement = isValidElement
