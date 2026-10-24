/**
 * GPUIX answers a renderer query on Linux and Windows by asking the UI
 * thread and waiting at most 2 s (`recv_ui_response` in GPUIX's
 * renderer.rs); past that it throws "Timed out after 2 seconds waiting for
 * ...". With several chats streaming, the UI thread can be busy that long, and
 * the throw lands in whatever called the query: a key handler, a timer, an
 * effect. Uncaught, it replaced the whole UI with the runtime-error overlay.
 *
 * A slow answer is not an error for any caller, so this boundary turns the
 * timeout into the "nothing known" value each query already returns
 * (`null`, or a tree with no root) and logs it. Other errors still throw.
 */

import type { NativeRenderer } from '@gpuix/react'
import { log } from './log'

/** Each blocking query and the value it returns when nothing is known. */
const QUERIES = {
  getFocusedElementId: null,
  getListScrollTop: null,
  getScrollOffset: null,
  getElementBounds: null,
  getElementsAt: [],
  getAutomationTree: 'null',
  getWindowSize: null,
  getWindowInsets: null
} as const

const TIMEOUT = /^Timed out after \d+ seconds? waiting for/

/** Minimum gap between two timeout logs, so a pinned UI thread does not flood the log. */
const LOG_EVERY_MS = 5000

const guarded = new WeakSet<object>()

export function isQueryTimeout(error: unknown): boolean {
  return TIMEOUT.test(error instanceof Error ? error.message : String(error))
}

export function guardNativeQueries(renderer: NativeRenderer): void {
  if (guarded.has(renderer)) return
  guarded.add(renderer)
  const target = renderer as unknown as Record<string, unknown>
  let lastLog = 0
  let missed = 0
  for (const [name, fallback] of Object.entries(QUERIES)) {
    const query = target[name]
    if (typeof query !== 'function') continue
    target[name] = (...args: unknown[]) => {
      try {
        return query.apply(renderer, args)
      } catch (error) {
        if (!isQueryTimeout(error)) throw error
        missed += 1
        const now = performance.now()
        if (now - lastLog >= LOG_EVERY_MS) {
          log.warn('native', `query timed out ${JSON.stringify({ query: name, missed })}`)
          lastLog = now
          missed = 0
        }
        return fallback
      }
    }
  }
}
