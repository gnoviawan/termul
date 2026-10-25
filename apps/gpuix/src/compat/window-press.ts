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
 */

import type { EventPayload } from '@gpuix/react'
import { hitTest } from './dnd'
import { nodeOrNull } from './dom-node'

interface PendingPress {
  payload: EventPayload
  target: number | null
  stopped: boolean
}

let pending: PendingPress | null = null

const samePoint = (a: EventPayload, b: EventPayload): boolean => a.x === b.x && a.y === b.y

/** The sentinel's `onMouseDownOutside`: a press somewhere in the window. */
export function sentinelPress(payload: EventPayload): void {
  flushPress()
  const press: PendingPress = { payload, target: null, stopped: false }
  pending = press
  setTimeout(() => {
    if (pending === press) flushPress()
  }, 0)
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
  toPage(['pointerdown', 'mousedown'], press.payload, press.target)
}

/**
 * Fire each of `types` at `document`, then `window`, for a press at
 * `payload`'s point. `target` is the element the element path started from;
 * without one, the target is hit-tested when a listener reads it.
 */
export function toPage(types: readonly string[], payload: EventPayload, target: number | null): void {
  const g = globalThis as { document?: EventTarget & { body?: unknown }; window?: EventTarget }
  const resolveTarget = (): unknown =>
    nodeOrNull(target ?? hitTest({ x: payload.x ?? 0, y: payload.y ?? 0 })) ?? g.document?.body ?? null
  let resolved: { value: unknown } | null = null
  const lazyTarget = (): unknown => {
    resolved ??= { value: resolveTarget() }
    return resolved.value
  }
  for (const type of types) {
    // Dispatch clears the stop flag when it returns, so the stop is recorded here.
    let stopped = false
    for (const host of [g.document, g.window]) {
      if (!host || stopped) continue
      const event = pageEvent(type, payload, lazyTarget, () => {
        stopped = true
      })
      host.dispatchEvent(event)
    }
  }
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
