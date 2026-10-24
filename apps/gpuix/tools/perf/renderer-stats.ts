import { existsSync, readFileSync } from 'node:fs'

interface Line {
  t: number
  calls: Record<string, number>
  blockedMs: Record<string, number>
  batchBytes: number
}

/**
 * Per-second renderer calls and blocked time between `from` and `to`, from
 * the GPUIX client's `TERMUL_GPUIX_STATS` file (`src/renderer-stats.ts`).
 * Keys: `ui.<method>PerS`, `ui.<method>BlockedMsPerS`, `ui.batchKBPerS`.
 */
export function summarizeRendererStats(file: string, from: number, to: number): Record<string, number> {
  if (!existsSync(file)) return {}
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((raw) => JSON.parse(raw) as Line)
    .filter((line) => line.t > from && line.t <= to + 1000)
  if (!lines.length) return {}
  const seconds = lines.length
  const calls: Record<string, number> = {}
  const blocked: Record<string, number> = {}
  let bytes = 0
  for (const line of lines) {
    for (const [name, n] of Object.entries(line.calls)) calls[name] = (calls[name] ?? 0) + n
    for (const [name, ms] of Object.entries(line.blockedMs)) blocked[name] = (blocked[name] ?? 0) + ms
    bytes += line.batchBytes
  }
  const out: Record<string, number> = { 'ui.batchKBPerS': Math.round(bytes / 1024 / seconds) }
  for (const [name, n] of Object.entries(calls)) out[`ui.${name}PerS`] = Math.round((n / seconds) * 10) / 10
  for (const [name, ms] of Object.entries(blocked)) out[`ui.${name}BlockedMsPerS`] = Math.round(ms / seconds)
  return out
}
