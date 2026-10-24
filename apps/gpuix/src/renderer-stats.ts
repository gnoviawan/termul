/**
 * Diagnostics for perf runs: when `TERMUL_GPUIX_STATS` names a file, append
 * one JSON line per second with how often JS called into the renderer and how
 * long it blocked. Every read below is a synchronous round trip to the GPUI
 * UI thread, and the tree and bounds reads also make it paint a frame, so
 * their count shows how much of the UI thread's load JS asks for.
 *
 * With `ops`, each line also counts the mutation ops by kind (`setCustomProp`
 * by key), their JSON bytes, and how many distinct elements got a `setText`.
 * It parses every batch, so it is for diagnostic runs, not for the timing ones.
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

export function recordRendererStats(renderer: object, file: string | undefined, ops = false): void {
  if (!file) return
  const target = renderer as Record<Counted, ((...args: unknown[]) => unknown) | undefined>
  const calls: Record<string, number> = {}
  const blockedMs: Record<string, number> = {}
  let batchBytes = 0
  const opCount: Record<string, number> = {}
  const opBytes: Record<string, number> = {}
  const textIds = new Set<unknown>()
  const countOps = (json: string) => {
    for (const op of JSON.parse(json) as [string, unknown, ...unknown[]][]) {
      const kind = op[0] === 'setCustomProp' ? `setCustomProp:${op[2]}` : op[0]
      opCount[kind] = (opCount[kind] ?? 0) + 1
      opBytes[kind] = (opBytes[kind] ?? 0) + JSON.stringify(op).length
      if (op[0] === 'setText') textIds.add(op[1])
    }
  }
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
        if (name === 'applyBatch') {
          batchBytes += (args[0] as string).length
          if (ops) countOps(args[0] as string)
        }
      }
    }
  }
  setInterval(() => {
    const line = {
      t: Date.now(),
      calls: { ...calls },
      blockedMs: { ...blockedMs },
      batchBytes,
      ...(ops ? { opCount: { ...opCount }, opBytes: { ...opBytes }, textIds: textIds.size } : {})
    }
    for (const bag of [calls, blockedMs, opCount, opBytes])
      for (const key of Object.keys(bag)) delete bag[key]
    textIds.clear()
    batchBytes = 0
    appendFileSync(file, `${JSON.stringify(line)}\n`)
  }, 1000).unref()
}
