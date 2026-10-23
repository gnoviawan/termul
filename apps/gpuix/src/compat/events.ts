/**
 * React DOM handler props -> GPUIX listeners.
 *
 * Every GPUIX listener the compat layer installs is one module-level function
 * per event kind. It finds the element's current DOM handlers through the
 * instance registry, so a re-render that passes a new inline handler never
 * changes a GPUIX prop. Mouse events bubble here, not natively: GPUIX stops a
 * click at the first element with an opaque background (measured), while the
 * DOM delivers it to every ancestor.
 */

import type { EventPayload, KeyEvent } from '@gpuix/react'
import { ancestorIds, inputValues, nodeFor, nodeOrNull, trackedInstance, compatRenderer } from './dom-node'
import { compatWarn } from './log'

type Handler = (event: CompatEvent) => void

/** The DOM handler props the compat layer understands, as the component passed them. */
export interface DomHandlers {
  onClick?: Handler
  onDoubleClick?: Handler
  onContextMenu?: Handler
  onMouseDown?: Handler
  onMouseUp?: Handler
  onMouseMove?: Handler
  onMouseEnter?: Handler
  onMouseLeave?: Handler
  onPointerDown?: Handler
  onPointerUp?: Handler
  onPointerMove?: Handler
  onPointerEnter?: Handler
  onPointerLeave?: Handler
  onKeyDown?: Handler
  onKeyUp?: Handler
  onFocus?: Handler
  onBlur?: Handler
  onChange?: Handler
  onInput?: Handler
  onScroll?: Handler
  onWheel?: Handler
  onSubmit?: Handler
}

export const HANDLER_NAMES: readonly (keyof DomHandlers)[] = [
  'onClick', 'onDoubleClick', 'onContextMenu', 'onMouseDown', 'onMouseUp', 'onMouseMove',
  'onMouseEnter', 'onMouseLeave', 'onPointerDown', 'onPointerUp', 'onPointerMove',
  'onPointerEnter', 'onPointerLeave', 'onKeyDown', 'onKeyUp', 'onFocus', 'onBlur', 'onChange',
  'onInput', 'onScroll', 'onWheel', 'onSubmit'
]

const KEY_NAMES: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: ' ',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert',
  shift: 'Shift', control: 'Control', alt: 'Alt', platform: 'Meta', capslock: 'CapsLock'
}

/** GPUI key name (and produced character) -> `KeyboardEvent.key`. */
export function domKey(key: string | undefined, keyChar?: string): string | undefined {
  if (key === undefined) return undefined
  const named = KEY_NAMES[key]
  if (named) return named
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase()
  return keyChar && keyChar.length === 1 ? keyChar : key
}

function domCode(key: string | undefined): string | undefined {
  if (!key) return undefined
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^\d$/.test(key)) return `Digit${key}`
  if (key === 'space') return 'Space'
  return KEY_NAMES[key] ?? key
}

/** The fields React handlers read off a SyntheticEvent. */
export class CompatEvent {
  defaultPrevented = false
  propagationStopped = false
  currentTarget: unknown
  readonly nativeEvent: unknown
  readonly timeStamp = Date.now()
  readonly bubbles = true
  readonly isTrusted = true

  constructor(
    readonly type: string,
    readonly target: unknown,
    private readonly payload: Partial<EventPayload & KeyEvent>,
    readonly relatedTarget: unknown = null
  ) {
    this.currentTarget = target
    this.nativeEvent = this
  }

  get clientX(): number {
    return this.payload.x ?? 0
  }
  get clientY(): number {
    return this.payload.y ?? 0
  }
  get pageX(): number {
    return this.clientX
  }
  get pageY(): number {
    return this.clientY
  }
  get screenX(): number {
    return this.clientX
  }
  get screenY(): number {
    return this.clientY
  }
  get button(): number {
    return this.payload.button ?? (this.payload.isRightClick ? 2 : 0)
  }
  get buttons(): number {
    return this.payload.pressedButton === undefined ? 0 : 1 << this.payload.pressedButton
  }
  get detail(): number {
    return this.payload.clickCount ?? 1
  }
  get key(): string | undefined {
    return domKey(this.payload.key, this.payload.keyChar)
  }
  get code(): string | undefined {
    return domCode(this.payload.key)
  }
  get repeat(): boolean {
    return this.payload.isHeld === true
  }
  get shiftKey(): boolean {
    return this.payload.modifiers?.shift === true
  }
  get ctrlKey(): boolean {
    return this.payload.modifiers?.ctrl === true
  }
  get altKey(): boolean {
    return this.payload.modifiers?.alt === true
  }
  get metaKey(): boolean {
    return this.payload.modifiers?.cmd === true
  }
  get deltaX(): number {
    return this.payload.deltaX ?? 0
  }
  get deltaY(): number {
    return this.payload.deltaY ?? 0
  }
  get deltaMode(): number {
    return this.payload.precise === false ? 1 : 0
  }
  readonly isComposing = false

  getModifierState(key: string): boolean {
    if (key === 'Shift') return this.shiftKey
    if (key === 'Control') return this.ctrlKey
    if (key === 'Alt') return this.altKey
    if (key === 'Meta') return this.metaKey
    return false
  }

  preventDefault(): void {
    this.defaultPrevented = true
    this.payload.preventDefault?.()
  }

  stopPropagation(): void {
    this.propagationStopped = true
    this.payload.stopPropagation?.()
  }

  isDefaultPrevented(): boolean {
    return this.defaultPrevented
  }

  isPropagationStopped(): boolean {
    return this.propagationStopped
  }

  persist(): void {}
}

function handlersOf(id: number): DomHandlers | null {
  return trackedInstance(id)?.props.__dom?.handlers ?? null
}

function call(handler: Handler | undefined, event: CompatEvent, id: number): void {
  if (!handler) return
  event.currentTarget = nodeFor(id)
  handler(event)
}

/**
 * One native gesture reaches JS once per element GPUIX delivers it to. The
 * first delivery (the deepest element) bubbles it through the ancestors;
 * later deliveries of the same gesture to those ancestors are dropped.
 */
interface Gesture {
  key: string
  at: number
  handled: Set<number>
  stopped: boolean
}

let gesture: Gesture | null = null

function gestureFor(payload: EventPayload): Gesture {
  const key = `${payload.eventType}:${payload.x}:${payload.y}:${payload.clickCount ?? 0}:${payload.button ?? 0}`
  const now = performance.now()
  if (gesture && gesture.key === key && now - gesture.at < 100) return gesture
  gesture = { key, at: now, handled: new Set(), stopped: false }
  return gesture
}

type Pick = (handlers: DomHandlers, payload: EventPayload) => [string, Handler | undefined][]

function bubbling(pick: Pick) {
  return (payload: EventPayload) => {
    const g = gestureFor(payload)
    const id = payload.elementId
    if (g.stopped || g.handled.has(id)) return
    const target = nodeFor(id)
    const chain = [id, ...ancestorIds(id)]
    const events = new Map<string, CompatEvent>()
    for (const at of chain) {
      if (g.stopped) break
      g.handled.add(at)
      const handlers = handlersOf(at)
      if (!handlers) continue
      for (const [type, handler] of pick(handlers, payload)) {
        if (!handler) continue
        let event = events.get(type)
        if (!event) {
          event = new CompatEvent(type, target, payload)
          events.set(type, event)
        }
        call(handler, event, at)
        if (event.propagationStopped) g.stopped = true
      }
    }
  }
}

const onClick = bubbling((h, p) => [
  ['click', h.onClick],
  ['dblclick', p.clickCount === 2 ? h.onDoubleClick : undefined]
])
const onAuxClick = bubbling((h, p) => [['contextmenu', p.isRightClick ? h.onContextMenu : undefined]])
const onMouseDown = bubbling((h) => [
  ['pointerdown', h.onPointerDown],
  ['mousedown', h.onMouseDown]
])
const onMouseUp = bubbling((h) => [
  ['pointerup', h.onPointerUp],
  ['mouseup', h.onMouseUp]
])

function direct(pick: (h: DomHandlers) => [string, Handler | undefined][]) {
  return (payload: EventPayload) => {
    const handlers = handlersOf(payload.elementId)
    if (!handlers) return
    const target = nodeFor(payload.elementId)
    for (const [type, handler] of pick(handlers)) {
      call(handler, new CompatEvent(type, target, payload), payload.elementId)
    }
  }
}

const onMouseMove = direct((h) => [
  ['pointermove', h.onPointerMove],
  ['mousemove', h.onMouseMove]
])
const onMouseEnter = direct((h) => [
  ['pointerenter', h.onPointerEnter],
  ['mouseenter', h.onMouseEnter]
])
const onMouseLeave = direct((h) => [
  ['pointerleave', h.onPointerLeave],
  ['mouseleave', h.onMouseLeave]
])
const onScroll = direct((h) => [['wheel', h.onWheel]])
const onScrollChange = direct((h) => [['scroll', h.onScroll]])

/** Key events bubble natively through ancestors that declare a listener. */
function keyListener(type: 'keydown' | 'keyup') {
  return (payload: KeyEvent) => {
    const handlers = handlersOf(payload.elementId)
    const handler = type === 'keydown' ? handlers?.onKeyDown : handlers?.onKeyUp
    if (!handler) return
    const focused = compatRenderer()?.getFocusedElementId()
    const target = nodeOrNull(focused) ?? nodeFor(payload.elementId)
    call(handler, new CompatEvent(type, target, payload), payload.elementId)
  }
}

const onKeyDown = keyListener('keydown')
const onKeyUp = keyListener('keyup')

function inputChange(payload: EventPayload): void {
  const id = payload.elementId
  const value = payload.value ?? ''
  inputValues.set(id, value)
  const handlers = handlersOf(id)
  if (!handlers) return
  const event = new CompatEvent('change', nodeFor(id), payload)
  call(handlers.onInput, event, id)
  call(handlers.onChange, event, id)
}

/** Focus moved: the element's own handler, ancestors' React onFocus (it bubbles), then document focusin. */
export type FocusSink = (type: 'focusin' | 'focusout', target: unknown, related: unknown) => void

let focusSink: FocusSink | null = null

export function setFocusSink(sink: FocusSink | null): void {
  focusSink = sink
}

let lastFocused: number | null = null

function focusListener(type: 'focus' | 'blur') {
  return (payload: EventPayload) => {
    const id = payload.elementId
    const target = nodeFor(id)
    const related = type === 'focus' ? nodeOrNull(lastFocused) : null
    if (type === 'focus') lastFocused = id
    else if (lastFocused === id) lastFocused = null
    const event = new CompatEvent(type, target, payload, related)
    for (const at of [id, ...ancestorIds(id)]) {
      const handlers = handlersOf(at)
      call(type === 'focus' ? handlers?.onFocus : handlers?.onBlur, event, at)
      if (event.propagationStopped) break
    }
    focusSink?.(type === 'focus' ? 'focusin' : 'focusout', target, related)
  }
}

const onFocus = focusListener('focus')
const onBlur = focusListener('blur')

export interface GpuixListeners {
  onClick?: typeof onClick
  onAuxClick?: typeof onAuxClick
  onMouseDown?: typeof onMouseDown
  onMouseUp?: typeof onMouseUp
  onMouseMove?: typeof onMouseMove
  onMouseEnter?: typeof onMouseEnter
  onMouseLeave?: typeof onMouseLeave
  onKeyDown?: typeof onKeyDown
  onKeyUp?: typeof onKeyUp
  onFocus?: typeof onFocus
  onBlur?: typeof onBlur
  onChange?: typeof inputChange
  onScroll?: typeof onScroll
  onScrollChange?: typeof onScrollChange
}

/**
 * Collect the DOM handlers of `props` and the GPUIX listeners they need.
 * `focusable` elements always get focus listeners, so `document` sees
 * focusin/focusout and `activeElement` stays current.
 */
export function adaptHandlers(
  props: Readonly<Record<string, unknown>>,
  text: boolean,
  focusable: boolean,
  out: GpuixListeners
): DomHandlers | null {
  let handlers: DomHandlers | null = null
  for (const name of HANDLER_NAMES) {
    const value = props[name]
    if (typeof value !== 'function') continue
    handlers ??= {}
    handlers[name] = value as Handler
  }
  if (focusable) {
    out.onFocus = onFocus
    out.onBlur = onBlur
  }
  if (!handlers) return null
  if (handlers.onClick || handlers.onDoubleClick) out.onClick = onClick
  if (handlers.onContextMenu) out.onAuxClick = onAuxClick
  if (handlers.onMouseDown || handlers.onPointerDown) out.onMouseDown = onMouseDown
  if (handlers.onMouseUp || handlers.onPointerUp) out.onMouseUp = onMouseUp
  if (handlers.onMouseMove || handlers.onPointerMove) out.onMouseMove = onMouseMove
  if (handlers.onMouseEnter || handlers.onPointerEnter) out.onMouseEnter = onMouseEnter
  if (handlers.onMouseLeave || handlers.onPointerLeave) out.onMouseLeave = onMouseLeave
  if (handlers.onKeyDown) out.onKeyDown = onKeyDown
  if (handlers.onKeyUp) out.onKeyUp = onKeyUp
  if (handlers.onWheel) out.onScroll = onScroll
  if (handlers.onScroll) out.onScrollChange = onScrollChange
  if (text && (handlers.onChange || handlers.onInput)) out.onChange = inputChange
  if (handlers.onSubmit) compatWarn('event-partial', 'onSubmit (form submit is not emulated)')
  return handlers
}

/** A real `Event` carrying `extra` as own properties, for `window`/`document` listeners. */
export function domEvent(type: string, extra: Record<string, unknown>, onPreventDefault?: () => void): Event {
  const event = new Event(type, { cancelable: true, bubbles: true })
  for (const [name, value] of Object.entries(extra)) {
    Object.defineProperty(event, name, { value, configurable: true })
  }
  if (onPreventDefault) {
    const prevent = event.preventDefault.bind(event)
    Object.defineProperty(event, 'preventDefault', {
      value: () => {
        prevent()
        onPreventDefault()
      },
      configurable: true
    })
  }
  return event
}

/** The window-level key event of a GPUIX keystroke, as a DOM KeyboardEvent. */
export function windowKeyEvent(type: 'keydown' | 'keyup', payload: KeyEvent): Event {
  const view = new CompatEvent(type, null, payload)
  const focused = compatRenderer()?.getFocusedElementId()
  return domEvent(
    type,
    {
      key: view.key,
      code: view.code,
      repeat: view.repeat,
      shiftKey: view.shiftKey,
      ctrlKey: view.ctrlKey,
      altKey: view.altKey,
      metaKey: view.metaKey,
      isComposing: false,
      target: nodeOrNull(focused) ?? (globalThis as { document?: unknown }).document,
      getModifierState: (key: string) => view.getModifierState(key)
    },
    () => payload.preventDefault()
  )
}
