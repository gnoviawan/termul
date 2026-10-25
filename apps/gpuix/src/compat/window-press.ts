/**
 * Presses as `document` and `window` listeners see them (ChatRoute's
 * first-interaction gate, click-outside handlers). GPUIX delivers a press only
 * to elements that listen for it, so CompatRoot mounts a zero-size sentinel
 * whose `onMouseDownOutside` sees every mouse down in the window. It reaches
 * JS before the element path of the same press, in the same batch (measured
 * with an automation click: sentinel, then the element's mouseDown and
 * click, all before a `setTimeout(0)` set by the sentinel). The DOM order is
 * the element path, then `document`, then `window`, so the sentinel holds the
 * press until the element path ran, or until that batch is over when no
 * element listens.
 *
 * Releases have no sentinel: `pointerup`/`mouseup`/`click` reach the page
 * only for presses an element path saw.
 *
 * The press's default action runs once its batch is over (`settleFocus`).
 */

import type { EventPayload } from '@gpuix/react'
import { hitTest } from './dnd'
import { compatReads, nodeOrNull } from './dom-node'

interface PendingPress {
  payload: EventPayload
  target: number | null
  stopped: boolean
  /** A `pointerdown` or `mousedown` listener called preventDefault, so focus stays put. */
  prevented: boolean
}

/** The press not yet handed to `document` and `window`. */
let pending: PendingPress | null = null
/** The press whose default action has not run yet. */
let settling: PendingPress | null = null

type Point = Pick<EventPayload, 'x' | 'y'>
const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y

/** The sentinel's `onMouseDownOutside`: a press somewhere in the window. */
export function sentinelPress(payload: EventPayload): void {
  flushPress()
  const press: PendingPress = { payload, target: null, stopped: false, prevented: false }
  pending = press
  settling = press
  setTimeout(() => {
    if (pending === press) flushPress()
    if (settling !== press) return
    settling = null
    settleFocus(press)
  }, 0)
}

/** A listener of the press at this point called preventDefault (`CompatEvent`). */
export function pressPrevented(at: Point): void {
  if (settling && samePoint(settling.payload, at)) settling.prevented = true
}

/**
 * The DOM's default action for a press no listener prevented: focus moves to
 * the focusable element pressed, or else leaves the focused one for `body`.
 * GPUI has already focused a focusable element it pressed, and the terminal
 * and editor focus their own host on press. So focus on a box away from the
 * press point means the press landed on content that takes no focus.
 */
function settleFocus(press: PendingPress): void {
  if (press.prevented) return
  const reads = compatReads()
  const focused = reads?.renderer.getFocusedElementId() ?? null
  if (!reads || focused === null) return
  const box = reads.bounds(focused)
  const { x = 0, y = 0 } = press.payload
  if (box && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) return
  reads.renderer.blur()
}

/** The element path of a press ran from `target`; `stopped` if a handler stopped it. */
export function elementPressed(payload: EventPayload, target: number, stopped: boolean): void {
  if (!pending || !samePoint(pending.payload, payload)) return
  pending.target = target
  pending.stopped = stopped
  flushPress()
}

/** Hand the held press to `document` and `window`. */
export function flushPress(): void {
  const press = pending
  if (!press) return
  pending = null
  if (press.stopped) return
  if (toPage(['pointerdown', 'mousedown'], press.payload, press.target)) press.prevented = true
}

/**
 * Fire each of `types` at `document`, then `window`, for a press at
 * `payload`'s point. `target` is the element the element path started from;
 * without one, the target is hit-tested when a listener reads it. True when a
 * listener called preventDefault.
 */
export function toPage(types: readonly string[], payload: EventPayload, target: number | null): boolean {
  const g = globalThis as { document?: EventTarget & { body?: unknown }; window?: EventTarget }
  const resolveTarget = (): unknown =>
    nodeOrNull(target ?? hitTest({ x: payload.x ?? 0, y: payload.y ?? 0 })) ?? g.document?.body ?? null
  let resolved: { value: unknown } | null = null
  const lazyTarget = (): unknown => {
    resolved ??= { value: resolveTarget() }
    return resolved.value
  }
  let prevented = false
  for (const type of types) {
    // Dispatch clears the stop flag when it returns, so the stop is recorded here.
    let stopped = false
    for (const host of [g.document, g.window]) {
      if (!host || stopped) continue
      const event = pageEvent(type, payload, lazyTarget, () => {
        stopped = true
      })
      host.dispatchEvent(event)
      if (event.defaultPrevented) prevented = true
    }
  }
  return prevented
}

function pageEvent(type: string, payload: EventPayload, target: () => unknown, onStop: () => void): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  for (const name of ['stopPropagation', 'stopImmediatePropagation'] as const) {
    const stop = event[name].bind(event)
    Object.defineProperty(event, name, {
      value: () => {
        onStop()
        stop()
      },
      configurable: true
    })
  }
  const button = payload.button ?? 0
  const mods = payload.modifiers
  const fields: Record<string, unknown> = {
    clientX: payload.x ?? 0,
    clientY: payload.y ?? 0,
    pageX: payload.x ?? 0,
    pageY: payload.y ?? 0,
    screenX: payload.x ?? 0,
    screenY: payload.y ?? 0,
    button,
    buttons: type.endsWith('down') ? 1 << button : 0,
    detail: payload.clickCount ?? 1,
    shiftKey: mods?.shift === true,
    ctrlKey: mods?.ctrl === true,
    altKey: mods?.alt === true,
    metaKey: mods?.cmd === true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true
  }
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(event, name, { value, configurable: true })
  }
  Object.defineProperty(event, 'target', { get: target, configurable: true })
  return event
}
