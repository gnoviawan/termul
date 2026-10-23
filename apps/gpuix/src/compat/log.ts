/**
 * Counts every class, prop and DOM member the compat layer could not honour,
 * so a run reports what real components touch. The first occurrence of each
 * is logged when `COMPAT_VERBOSE=1`.
 */

import { log } from '../log'

const counts = new Map<string, number>()
const verbose =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.COMPAT_VERBOSE === '1'

export function compatWarn(kind: string, detail: string): void {
  const key = `${kind}\t${detail}`
  const n = counts.get(key) ?? 0
  counts.set(key, n + 1)
  if (n === 0 && verbose) log.warn('compat', `${kind}: ${detail}`)
}

export interface CompatIssue {
  kind: string
  detail: string
  count: number
}

export function compatReport(): CompatIssue[] {
  return [...counts.entries()]
    .map(([key, count]) => {
      const [kind, detail] = key.split('\t')
      return { kind, detail, count }
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count)
}
