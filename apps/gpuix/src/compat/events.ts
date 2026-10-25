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
import {
  ancestorIds,
  checkedValues,
  compatRenderer,
  descendantIds,
  type DomInfo,
  inputValues,
  nodeFor,
  nodeOrNull,
  onFocusCall,
  trackedInstance,
  treeIndex
} from './dom-node'
import {
  dragSuppressesClick,
  fileDrop,
  moveSource,
  pressSource,
  releaseSource,
  withheldClickTarget
} from './dnd'
import { compatWarn } from './log'
import { hover, occluderHover } from './hover'
import { tracePointer } from './trace'

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
  onDragStart?: Handler
  onDrag?: Handler
  onDragEnd?: Handler
  onDragEnter?: Handler
  onDragOver?: Handler
  onDragLeave?: Handler
  onDrop?: Handler
}

export const HANDLER_NAMES: readonly (keyof DomHandlers)[] = [
  'onClick', 'onDoubleClick', 'onContextMenu', 'onMouseDown', 'onMouseUp', 'onMouseMove',
  'onMouseEnter', 'onMouseLeave', 'onPointerDown', 'onPointerUp', 'onPointerMove',
  'onPointerEnter', 'onPointerLeave', 'onKeyDown', 'onKeyUp', 'onFocus', 'onBlur', 'onChange',
  'onInput', 'onScroll', 'onWheel', 'onSubmit', 'onDragStart', 'onDrag', 'onDragEnd', 'onDragEnter',
  'onDragOver', 'onDragLeave', 'onDrop'
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

export function handlersOf(id: number): DomHandlers | null {
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
  return (payload: EventPayload): Map<string, CompatEvent> | null => {
    const g = gestureFor(payload)
    const id = payload.elementId
    if (g.stopped || g.handled.has(id)) return null
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
    return events
  }
}

const clickBubbling = bubbling((h, p) => [
  ['click', h.onClick],
  ['dblclick', p.clickCount === 2 ? h.onDoubleClick : undefined]
])
/** Click what a plain press on a capturing `source` clicks in the DOM (`withheldClickTarget`). */
export function clickWithheldByCapture(source: number, point: { x: number; y: number }): void {
  const target = withheldClickTarget(source, point)
  if (target === null) return
  clickBubbling({ eventType: 'click', elementId: target, x: point.x, y: point.y, clickCount: 1, button: 0 } as EventPayload)
}

function onClick(payload: EventPayload): void {
  if (dragSuppressesClick(payload)) return
  const events = clickBubbling(payload)
  if (!events || events.get('click')?.defaultPrevented) return
  submitFromButton(payload)
  activateCheckable(payload)
}

const isCheckbox = (dom: DomInfo | undefined): boolean => dom?.tag === 'input' && dom.attrs.type === 'checkbox'

/** The control a label activates: the one its `htmlFor` names, else the first one inside it. */
function labelControl(label: number): number | undefined {
  const target = domOf(label)?.attrs.htmlFor
  if (typeof target === 'string') {
    const root = treeIndex().root
    return root === null ? undefined : descendantIds(root).find((at) => domOf(at)?.attrs.id === target)
  }
  return descendantIds(label).find((at) => LABELABLE.has(domOf(at)?.tag ?? ''))
}
const LABELABLE = new Set(['input', 'button', 'select', 'textarea'])

/**
 * A click on a checkbox, or on a label for one, flips it and fires `input`
 * and `change` with `target.checked` already flipped, as the DOM does. A
 * controlled checkbox then repaints from its new `checked` prop.
 */
function activateCheckable(payload: EventPayload): void {
  const chain = [payload.elementId, ...ancestorIds(payload.elementId)]
  let control = chain.find((at) => isCheckbox(domOf(at)))
  const viaLabel = control === undefined
  if (viaLabel) {
    const label = chain.find((at) => domOf(at)?.tag === 'label')
    control = label === undefined ? undefined : labelControl(label)
  }
  if (control === undefined || !isCheckbox(domOf(control)) || domOf(control)?.attrs.disabled) return
  const handlers = handlersOf(control)
  const node = nodeFor(control)
  checkedValues.set(control, !node.checked)
  try {
    if (viaLabel) call(handlers?.onClick, new CompatEvent('click', node, payload), control)
    const change = new CompatEvent('change', node, payload)
    call(handlers?.onInput, change, control)
    call(handlers?.onChange, change, control)
  } finally {
    checkedValues.delete(control)
  }
}

const domOf = (id: number): DomInfo | undefined => trackedInstance(id)?.props.__dom

function isSubmitControl(dom: DomInfo | undefined): boolean {
  const type = dom?.attrs.type
  if (dom?.tag === 'button') return type === undefined || type === 'submit'
  return dom?.tag === 'input' && type === 'submit'
}

/** The form a submit button or field belongs to: its nearest `<form>` ancestor. */
function formOf(id: number): number | undefined {
  return ancestorIds(id).find((at) => domOf(at)?.tag === 'form')
}

function submitForm(form: number, payload: EventPayload): void {
  call(handlersOf(form)?.onSubmit, new CompatEvent('submit', nodeFor(form), payload), form)
}

/** A click no handler prevented on a submit button (or inside one) submits its form. */
function submitFromButton(payload: EventPayload): void {
  const button = [payload.elementId, ...ancestorIds(payload.elementId)].find((at) => isSubmitControl(domOf(at)))
  if (button === undefined || domOf(button)?.attrs.disabled) return
  const form = formOf(button)
  if (form !== undefined) submitForm(form, payload)
}

/**
 * HTML implicit submission: Enter in a field clicks the form's first submit
 * button (nothing when it is disabled), or submits a form that has none.
 */
function submitImplicitly(field: number, payload: EventPayload): void {
  const form = formOf(field)
  if (form === undefined) return
  const button = descendantIds(form).find((at) => isSubmitControl(domOf(at)))
  if (button === undefined) {
    submitForm(form, payload)
    return
  }
  if (domOf(button)?.attrs.disabled) return
  onClick({ ...payload, elementId: button, eventType: 'click', clickCount: 1, button: 0 })
}

/**
 * A GPUIX `<input>` turns Enter into `submit` and reports no keyDown
 * (tools/compat/probe/input-run.ts). Replay it as the DOM delivers it: an
 * Enter keydown through the field and its ancestors, then `window`, then
 * implicit submission unless a handler prevented it.
 */
function inputSubmit(payload: EventPayload): void {
  const id = payload.elementId
  const key = { ...payload, eventType: 'keyDown', key: 'enter' } as Partial<EventPayload & KeyEvent>
  const event = new CompatEvent('keydown', nodeFor(id), key)
  for (const at of [id, ...ancestorIds(id)]) {
    call(handlersOf(at)?.onKeyDown, event, at)
    if (event.propagationStopped) break
  }
  if (!event.propagationStopped) {
    const windowEvent = windowKeyEvent('keydown', { ...key, preventDefault: () => event.preventDefault() } as KeyEvent)
    ;(globalThis as { window?: EventTarget }).window?.dispatchEvent(windowEvent)
  }
  if (!event.defaultPrevented) submitImplicitly(id, payload)
}
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
/** A draggable element also feeds the drag session (`dnd.ts`); having all three arms GPUIX's pointer capture. */
function onDragSourceDown(payload: EventPayload): void {
  onMouseDown(payload)
  pressSource(payload)
}
function onDragSourceMove(payload: EventPayload): void {
  onMouseMove(payload)
  moveSource(payload)
}
function onDragSourceUp(payload: EventPayload): void {
  onMouseUp(payload)
  const clicked = releaseSource(payload)
  if (clicked !== null) clickBubbling({ ...payload, eventType: 'click', elementId: clicked, clickCount: 1 })
}

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

/**
 * Keys typed in the same burst as a shortcut that opens a field (Ctrl+K then
 * "theme") reach `window` with nothing focused: the field's focus() runs in a
 * later JS turn than GPUI dispatches them, and GPUIX applies it a frame later
 * still. In the DOM that focus lands before the next keystroke, so the field
 * gets them. Printable keys no handler prevented are held here and given to a
 * controlled text field that focus() targets soon before or after
 * (palette.type-ahead). The window is wide because rendering what the
 * shortcut opens can take over a second on a loaded host.
 */
const TYPE_AHEAD_MS = 3000
let typeAhead: { text: string; at: number } | null = null
let focusTarget: { id: number; at: number } | null = null

const fresh = (entry: { at: number } | null): boolean =>
  entry !== null && performance.now() - entry.at < TYPE_AHEAD_MS

export function noteWindowKey(payload: KeyEvent, prevented: boolean): void {
  const ch = payload.keyChar
  const mods = payload.modifiers
  if (prevented || !ch || ch.length !== 1 || mods?.ctrl || mods?.alt || mods?.cmd) return
  if (compatRenderer()?.getFocusedElementId() != null) {
    focusTarget = null
    return
  }
  typeAhead = { text: (fresh(typeAhead) ? typeAhead?.text : '') + ch, at: performance.now() }
  if (focusTarget && fresh(focusTarget)) replayTypeAhead(focusTarget.id)
}

function replayTypeAhead(id: number): void {
  const pending = typeAhead
  typeAhead = null
  if (!pending || !fresh(pending)) return
  const dom = domOf(id)
  if ((dom?.tag !== 'input' && dom?.tag !== 'textarea') || dom.attrs.value === undefined) return
  const current = inputValues.get(id) ?? String(dom.attrs.value)
  inputChange({ elementId: id, value: current + pending.text } as EventPayload)
}

onFocusCall((id) => {
  focusTarget = { id, at: performance.now() }
  replayTypeAhead(id)
})

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
    // Not on focus: JS sees the field's focus before the keys GPUI dispatched ahead of it.
    if (type === 'blur' && focusTarget?.id === id) focusTarget = null
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
  onFileDrop?: typeof fileDrop
  onSubmit?: typeof inputSubmit
  onClick?: typeof onClick
  onAuxClick?: typeof onAuxClick
  onMouseDown?: (payload: EventPayload) => void
  onMouseUp?: (payload: EventPayload) => void
  onMouseMove?: typeof onMouseMove
  onMouseEnter?: (payload: EventPayload) => void
  onMouseLeave?: (payload: EventPayload) => void
  onKeyDown?: typeof onKeyDown
  onKeyUp?: typeof onKeyUp
  onFocus?: typeof onFocus
  onBlur?: typeof onBlur
  onChange?: typeof inputChange
  onScroll?: typeof onScroll
  onScrollChange?: typeof onScrollChange
}

/** A press and the click GPUIX reports after it are one action. */
const PRESS_ACTION_MS = 150
let lastWindowPress = -Infinity

/**
 * The DOM bubbles every press up to `window`; GPUIX reports a press only to
 * an element with a handler, and compat bubbling stops at its ancestors. Code
 * that waits on `window` for the reader's first press (`ChatRoute`'s boot
 * window, which re-activates its chat on every tree change until then) never
 * saw one, so each press is announced there once.
 */
function announcingPress<T extends (payload: EventPayload) => void>(listener: T): T {
  return ((payload: EventPayload) => {
    const now = performance.now()
    if (now - lastWindowPress > PRESS_ACTION_MS) {
      lastWindowPress = now
      ;(globalThis as { window?: EventTarget }).window?.dispatchEvent(
        domEvent('pointerdown', {
          target: nodeOrNull(payload.elementId),
          clientX: payload.x,
          clientY: payload.y,
          button: payload.button ?? 0
        })
      )
    }
    listener(payload)
  }) as T
}

const traced = {
  click: tracePointer('click', announcingPress(onClick)),
  auxClick: tracePointer('auxclick', announcingPress(onAuxClick)),
  down: tracePointer('down', announcingPress(onMouseDown)),
  up: tracePointer('up', onMouseUp),
  move: tracePointer('move', onMouseMove),
  enter: tracePointer('enter', hover.enter),
  leave: tracePointer('leave', hover.leave),
  occluderEnter: tracePointer('occluder-enter', occluderHover.enter),
  occluderLeave: tracePointer('occluder-leave', occluderHover.leave),
  sourceDown: tracePointer('source-down', announcingPress(onDragSourceDown)),
  sourceMove: tracePointer('source-move', onDragSourceMove),
  sourceUp: tracePointer('source-up', onDragSourceUp)
}

/**
 * Listeners a form control needs whatever its handlers: a field replays Enter
 * (`inputSubmit`) and a submit button submits its form on click.
 */
export function addFormListeners(tag: string, type: unknown, out: GpuixListeners): void {
  if (tag === 'input' && type !== 'checkbox') out.onSubmit = inputSubmit
  if ((tag === 'button' && (type === undefined || type === 'submit')) || (tag === 'input' && type === 'submit')) out.onClick = traced.click
  // A checkbox toggles on click, and so does the control a label names.
  if ((tag === 'input' && type === 'checkbox') || tag === 'label') out.onClick = traced.click
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
  out: GpuixListeners,
  draggable = false
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
  if (handlers.onClick || handlers.onDoubleClick) out.onClick = traced.click
  if (handlers.onContextMenu) out.onAuxClick = traced.auxClick
  if (handlers.onMouseDown || handlers.onPointerDown) out.onMouseDown = traced.down
  if (handlers.onMouseUp || handlers.onPointerUp) out.onMouseUp = traced.up
  if (handlers.onMouseMove || handlers.onPointerMove) out.onMouseMove = traced.move
  if (handlers.onMouseEnter || handlers.onPointerEnter) out.onMouseEnter = traced.enter
  if (handlers.onMouseLeave || handlers.onPointerLeave) out.onMouseLeave = traced.leave
  if (handlers.onKeyDown) out.onKeyDown = onKeyDown
  if (handlers.onKeyUp) out.onKeyUp = onKeyUp
  if (handlers.onWheel) out.onScroll = onScroll
  if (handlers.onScroll) out.onScrollChange = onScrollChange
  if (text && (handlers.onChange || handlers.onInput)) out.onChange = inputChange
  if (draggable) {
    out.onMouseDown = traced.sourceDown
    out.onMouseMove = traced.sourceMove
    out.onMouseUp = traced.sourceUp
  }
  if (handlers.onDrop || handlers.onDragOver || handlers.onDragEnter) out.onFileDrop = fileDrop
  return handlers
}

/**
 * A box GPUIX makes block the pointer (absolutely placed, or filled and
 * interactive) also blocks its own ancestors, which the DOM never does. It
 * gets the listeners that hand clicks and hover on to them: a click on the
 * fade of a row's action strip still clicks the row, and the row stays
 * hovered while the pointer is over the strip (`hover.ts`). Presses
 * (`mousedown`/`mouseup`) are not handed on: an ancestor that starts a gesture
 * on press (a Reorder item, a drag source) relies on GPUIX's pointer capture
 * to see the release, and a forwarded press arms no capture.
 */
export function addOccluderListeners(out: GpuixListeners, disabled: boolean): void {
  out.onMouseEnter = traced.occluderEnter
  out.onMouseLeave = traced.occluderLeave
  // A disabled control takes no click, and the DOM does not bubble one from it.
  if (disabled) return
  out.onClick ??= traced.click
  out.onAuxClick ??= traced.auxClick
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
