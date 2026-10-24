/**
 * Diagnostics for perf runs: when `TERMUL_GPUIX_STATS` names a file, append
 * one JSON line per second with how often JS called into the renderer and how
 * long it blocked. Every read below is a synchronous round trip to the GPUI
 * UI thread, and the tree and bounds reads also make it paint a frame, so
 * their count shows how much of the UI thread's load JS asks for.
 */

import { appendFileSync } from 'node:fs'

const COUNTED = [
  'applyBatch',
  'getAutomationTree',
  'getElementBounds',
  'getElementsAt',
  'getListScrollTop',
  'getScrollOffset',
  'getFocusedElementId',
  'getWindowSize'
] as const

type Counted = (typeof COUNTED)[number]

export function recordRendererStats(renderer: object, file: string | undefined): void {
  if (!file) return
  const target = renderer as Record<Counted, ((...args: unknown[]) => unknown) | undefined>
  const calls: Record<string, number> = {}
  const blockedMs: Record<string, number> = {}
  let batchBytes = 0
  for (const name of COUNTED) {
    const original = target[name]
    if (typeof original !== 'function') continue
    const bound = original.bind(renderer)
    target[name] = (...args: unknown[]) => {
      const t0 = performance.now()
      try {
        return bound(...args)
      } finally {
        calls[name] = (calls[name] ?? 0) + 1
        blockedMs[name] = (blockedMs[name] ?? 0) + performance.now() - t0
        if (name === 'applyBatch') batchBytes += (args[0] as string).length
      }
    }
  }
  setInterval(() => {
    const line = { t: Date.now(), calls: { ...calls }, blockedMs: { ...blockedMs }, batchBytes }
    for (const key of Object.keys(calls)) delete calls[key]
    for (const key of Object.keys(blockedMs)) delete blockedMs[key]
    batchBytes = 0
    appendFileSync(file, `${JSON.stringify(line)}\n`)
  }, 1000).unref()
}
