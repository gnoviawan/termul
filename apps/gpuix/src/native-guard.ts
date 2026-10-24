/**
 * GPUIX answers a renderer query on Linux and Windows by asking the UI
 * thread and waiting at most 2 s (`recv_ui_response` in GPUIX's
 * renderer.rs); past that it throws "Timed out after 2 seconds waiting for
 * ...". With several chats streaming, the UI thread can be busy that long, and
 * the throw lands in whatever called the query: a key handler, a timer, an
 * effect. Uncaught, it replaced the whole UI with the runtime-error overlay.
 *
 * A slow answer is not an error for the app's callers, so this boundary turns
 * the timeout into the "nothing known" value each query already returns
 * (`null`) and logs it. Other errors still throw.
 *
 * `getAutomationTree` and `getElementsAt` stay unguarded here: GPUIX's
 * automation server calls them on this same renderer, and its drivers retry
 * on the timeout error. A guarded tree read answered `null`, which a driver
 * took for an empty window (no chat cards, chatsOpen 0 in a stream-storm
 * run). The app's own tree read (`compat/live-reads.ts`) goes through
 * `orOnTimeout` instead.
 */

import type { NativeRenderer } from '@gpuix/react'
import { log } from './log'

/** Each blocking query and the value it returns when nothing is known. */
const QUERIES = {
  getFocusedElementId: null,
  getListScrollTop: null,
  getScrollOffset: null,
  getElementBounds: null,
  getWindowSize: null,
  getWindowInsets: null
} as const

const TIMEOUT = /^Timed out after \d+ seconds? waiting for/

/** Minimum gap between two timeout logs, so a pinned UI thread does not flood the log. */
const LOG_EVERY_MS = 5000

const guarded = new WeakSet<object>()
let lastLog = 0
let missed = 0

export function isQueryTimeout(error: unknown): boolean {
  return TIMEOUT.test(error instanceof Error ? error.message : String(error))
}

/** `read()`, or `fallback` when the UI thread did not answer in time. */
export function orOnTimeout<T>(query: string, read: () => T, fallback: T): T {
  try {
    return read()
  } catch (error) {
    if (!isQueryTimeout(error)) throw error
    missed += 1
    const now = performance.now()
    if (now - lastLog >= LOG_EVERY_MS) {
      log.warn('native', `query timed out ${JSON.stringify({ query, missed })}`)
      lastLog = now
      missed = 0
    }
    return fallback
  }
}

export function guardNativeQueries(renderer: NativeRenderer): void {
  if (guarded.has(renderer)) return
  guarded.add(renderer)
  const target = renderer as unknown as Record<string, unknown>
  for (const [name, fallback] of Object.entries(QUERIES)) {
    const query = target[name]
    if (typeof query !== 'function') continue
    target[name] = (...args: unknown[]) =>
      orOnTimeout(name, () => query.apply(renderer, args), fallback)
  }
}
