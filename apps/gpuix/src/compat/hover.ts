/**
 * DOM hover (mouseenter/mouseleave) from GPUI hover.
 *
 * GPUI hovers an element only while no box painted above it blocks the
 * pointer, and every absolutely placed or filled interactive box blocks
 * (`should_occlude`), its own ancestors included. In the DOM the pointer over
 * a child still hovers every ancestor. So a row whose hover reveals an
 * absolute action strip got mouseleave the moment the strip painted under the
 * pointer, hid the strip, got mouseenter again, and looped while presses
 * landed on whichever frame was up.
 *
 * Here an element is hovered when GPUI hovers it or hovers a blocking box
 * inside it. Blocking boxes report their GPUI hover through
 * `occluderHover` (`addOccluderListeners` in events.ts); elements with enter
 * or leave handlers through `hover`. Changes settle in one task, since GPUI
 * reports the parent's leave and the child's enter as separate events.
 */

import type { EventPayload } from '@gpuix/react'
import { ancestorIds, nodeFor, trackedInstance } from './dom-node'
import { CompatEvent, type DomHandlers } from './events'

/** Elements GPUI hovers right now: ones with hover handlers, and blocking boxes. */
const gpuiHovered = new Set<number>()
const occluders = new Set<number>()
/** Elements whose mouseenter ran and whose mouseleave has not. */
const entered = new Set<number>()
let pending: ReturnType<typeof setTimeout> | null = null

const handlersOf = (id: number): DomHandlers | null => trackedInstance(id)?.props.__dom?.handlers ?? null

const takesHover = (h: DomHandlers | null): h is DomHandlers =>
  h !== null && (h.onMouseEnter || h.onMouseLeave || h.onPointerEnter || h.onPointerLeave) !== undefined

function fire(id: number, kind: 'enter' | 'leave', handlers: DomHandlers): void {
  const payload = { elementId: id, eventType: kind === 'enter' ? 'mouseEnter' : 'mouseLeave' } as EventPayload
  const pairs: [string, ((event: CompatEvent) => void) | undefined][] =
    kind === 'enter'
      ? [['pointerenter', handlers.onPointerEnter], ['mouseenter', handlers.onMouseEnter]]
      : [['pointerleave', handlers.onPointerLeave], ['mouseleave', handlers.onMouseLeave]]
  const target = nodeFor(id)
  for (const [type, handler] of pairs) {
    if (!handler) continue
    const event = new CompatEvent(type, target, payload)
    event.currentTarget = target
    handler(event)
  }
}

function settle(): void {
  pending = null
  const hovered = new Set<number>()
  for (const id of gpuiHovered) {
    // A box that stopped painting (unmounted, display: none) never reports its leave.
    if (!trackedInstance(id)) {
      gpuiHovered.delete(id)
      occluders.delete(id)
      continue
    }
    hovered.add(id)
    if (occluders.has(id)) for (const at of ancestorIds(id)) hovered.add(at)
  }
  for (const id of [...entered]) {
    if (hovered.has(id)) continue
    entered.delete(id)
    const handlers = handlersOf(id)
    if (handlers) fire(id, 'leave', handlers)
  }
  for (const id of hovered) {
    if (entered.has(id)) continue
    const handlers = handlersOf(id)
    if (!takesHover(handlers)) continue
    entered.add(id)
    fire(id, 'enter', handlers)
  }
}

function note(id: number, isHovered: boolean, occluder: boolean): void {
  if (isHovered) {
    gpuiHovered.add(id)
    if (occluder) occluders.add(id)
  } else {
    gpuiHovered.delete(id)
    occluders.delete(id)
  }
  pending ??= setTimeout(settle, 0)
}

export const hover = {
  enter: (payload: EventPayload) => note(payload.elementId, true, false),
  leave: (payload: EventPayload) => note(payload.elementId, false, false)
}

export const occluderHover = {
  enter: (payload: EventPayload) => note(payload.elementId, true, true),
  leave: (payload: EventPayload) => note(payload.elementId, false, true)
}
