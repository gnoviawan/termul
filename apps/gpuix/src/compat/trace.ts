/**
 * Pointer trace for diagnosing lost presses: with `COMPAT_TRACE_POINTER=1`
 * every compat pointer listener logs its entry to stderr, with the element it
 * fired on and, for presses, the element the DOM's hit test picks there. Off,
 * `tracePointer` returns the listener itself.
 */

import type { EventPayload } from '@gpuix/react'
import { hitTest } from './dnd'
import { trackedInstance } from './dom-node'

const enabled =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.COMPAT_TRACE_POINTER === '1'

function label(id: number): string {
  const dom = trackedInstance(id)?.props.__dom
  if (!dom) return `${id}`
  const name = dom.attrs['data-testid'] ?? dom.attrs['aria-label'] ?? dom.className.split(' ')[0] ?? ''
  return `${id}:${dom.tag}${name ? `[${String(name).slice(0, 40)}]` : ''}`
}

export function tracePointer<T extends (payload: EventPayload) => void>(kind: string, listener: T): T {
  if (!enabled) return listener
  return ((payload: EventPayload) => {
    const { x, y } = payload
    const at = x === undefined || y === undefined ? '' : ` at=${x.toFixed(0)},${y.toFixed(0)} dom-hit=${label(hitTest({ x, y }) ?? -1)}`
    console.error(`[compat-trace] ${performance.now().toFixed(0)} ${kind} on=${label(payload.elementId)}${at}`)
    listener(payload)
  }) as T
}
