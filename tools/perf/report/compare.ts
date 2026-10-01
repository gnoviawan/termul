/**
 * `perf compare` (CAP-5) — per-metric min/median deltas with threshold
 * verdicts between two result dirs.
 *
 * Verdict semantics (metrics-catalog "Derived / reported"):
 *  - regressed: median moved against the good direction beyond the threshold
 *  - improved:  median moved in the good direction beyond the threshold
 *  - flat:      within the threshold
 *  - gap:       the metric is missing on either side — printed explicitly,
 *               never silently skipped
 *
 * Directions: lower is better for every current summary metric (commits,
 * blocking time, heap slope, dropped frames, interaction latency). CPU and
 * memory ends likewise. If a "higher is better" metric is added, it must be
 * listed in HIGHER_IS_BETTER.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  type CompareMetricRow,
  type CompareReport,
  type PerfRunResult,
  summarize
} from '../types.ts'

/** Metrics where a higher value is the better direction. */
const HIGHER_IS_BETTER = new Set(['frameP05Fps', 'frameP50Fps', 'frameP95Fps'])

/**
 * Thresholds: relative change of the median that counts as a real move.
 * Defaults are conservative (metrics-catalog "Notes on variance"): commit
 * counts and heap slope are the stable surfaces, wall-clock-ish metrics
 * need more slack.
 */
const DEFAULT_THRESHOLDS: Record<string, number> = {
  totalCommits: 0.1,
  topComponentCommits: 0.15,
  totalLoafCount: 0.15,
  totalLoafBlockingMs: 0.15,
  longtaskCount: 0.15,
  heapSlopeBytesPerSec: 0.25,
  heapEndBytes: 0.1,
  privateBytesEnd: 0.1,
  privateBytesSlopeBytesPerSec: 0.25,
  frameP05Fps: 0.1,
  frameP50Fps: 0.1,
  frameP95Fps: 0.1,
  droppedFrameCount: 0.2,
  interactionCount: 0.2,
  interactionMaxMs: 0.25,
  cdpNodes: 0.15,
  cdpLayoutCount: 0.15,
  cdpJsHeapUsed: 0.1
}

function loadResult(dir: string): PerfRunResult {
  const file = path.join(dir, 'result.json')
  if (!existsSync(file)) {
    throw new Error(`no result.json in ${dir} (expected a run directory from tools/perf/results/)`)
  }
  return JSON.parse(readFileSync(file, 'utf8')) as PerfRunResult
}

/** Compare two run dirs. Pure: no output, no FS writes. */
export function compareRuns(baseDir: string, againstDir: string): CompareReport {
  const base = loadResult(baseDir)
  const against = loadResult(againstDir)
  const baseSummary = summarize(base)
  const againstSummary = summarize(against)
  const keys = new Set([...Object.keys(baseSummary), ...Object.keys(againstSummary)])
  const rows: CompareMetricRow[] = []
  const gaps: string[] = []

  for (const metric of keys) {
    const inBase = metric in baseSummary
    const inAgainst = metric in againstSummary
    if (!inBase || !inAgainst) {
      if (!inBase && !inAgainst) continue
      const missingSide = inBase ? 'against' : 'base'
      gaps.push(`metric ${metric}: missing on the ${missingSide} side`)
      rows.push({
        metric,
        base: inBase ? baseSummary[metric] : null,
        against: inAgainst ? againstSummary[metric] : null,
        deltaMin: null,
        deltaMedian: null,
        pctMedian: null,
        verdict: 'gap'
      })
      continue
    }
    const b = baseSummary[metric]
    const a = againstSummary[metric]
    // Single-run summaries carry min===median; the compare contract over
    // repeated samples lives at the scenario level (future: per-sample
    // arrays). For now the summary's median IS the aggregate.
    const deltaMedian = a - b
    const deltaMin = deltaMedian
    const pct = b !== 0 ? (a - b) / Math.abs(b) : a !== 0 ? 1 : 0
    const threshold = DEFAULT_THRESHOLDS[metric] ?? 0.2
    const higherBetter = HIGHER_IS_BETTER.has(metric)
    let verdict: CompareMetricRow['verdict'] = 'flat'
    if (Math.abs(pct) > threshold) {
      const improved = higherBetter ? pct > 0 : pct < 0
      verdict = improved ? 'improved' : 'regressed'
    }
    rows.push({
      metric,
      base: b,
      against: a,
      deltaMin,
      deltaMedian,
      pctMedian: pct,
      verdict,
      threshold: verdict === 'improved' || verdict === 'regressed' ? threshold : undefined
    })
  }

  // Scenario/seed mismatch warnings — identical inputs should produce an
  // identical verdict; a mismatched pair is a usage error worth flagging.
  if (base.meta.scenario !== against.meta.scenario) {
    gaps.push(
      `scenario mismatch: base is ${base.meta.scenario}, against is ${against.meta.scenario}`
    )
  }
  if (base.meta.seed !== against.meta.seed) {
    gaps.push(
      `seed mismatch: base=${base.meta.seed} against=${against.meta.seed} (determinism requires the same seed)`
    )
  }

  return {
    baseRunId: base.meta.runId,
    againstRunId: against.meta.runId,
    rows: rows.sort((x, y) => {
      const order = { regressed: 0, gap: 1, improved: 2, flat: 3 }
      return order[x.verdict] - order[y.verdict]
    }),
    gaps
  }
}

function fmtValue(metric: string, v: number | null): string {
  if (v === null) return '—'
  if (
    metric.includes('Bytes') ||
    (metric.startsWith('heap') && metric.endsWith('Bytes')) ||
    metric.includes('HeapUsed')
  ) {
    const n = v
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let x = n
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024
      i++
    }
    return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
  }
  if (metric.includes('Ms')) return `${Math.round(v)} ms`
  if (metric.includes('Fps')) return `${v.toFixed(1)} fps`
  return String(Math.round(v * 100) / 100)
}

/** Human-readable compare table (also used by the CLI). */
export function formatCompare(report: CompareReport): string {
  const lines: string[] = []
  lines.push(`base:    ${report.baseRunId}`)
  lines.push(`against: ${report.againstRunId}`)
  lines.push('')
  const verdictMark = {
    improved: '+',
    regressed: '-',
    flat: '·',
    gap: '!'
  } as const
  lines.push('  verdict   metric                          base     against   Δmedian       Δ%')
  for (const row of report.rows) {
    const mark = verdictMark[row.verdict]
    const pct =
      row.pctMedian === null
        ? '—'
        : `${row.pctMedian > 0 ? '+' : ''}${(row.pctMedian * 100).toFixed(1)}%`
    const delta = row.deltaMedian === null ? '—' : fmtValue(row.metric, row.deltaMedian)
    lines.push(
      `${mark} ${row.verdict.padEnd(9)} ${row.metric.padEnd(30)} ${fmtValue(row.metric, row.base).padStart(10)} ${fmtValue(row.metric, row.against).padStart(10)} ${delta.padStart(10)} ${pct.padStart(8)}`
    )
  }
  if (report.gaps.length > 0) {
    lines.push('')
    lines.push('gaps:')
    for (const g of report.gaps) lines.push(`  ! ${g}`)
  }
  const regressed = report.rows.filter((r) => r.verdict === 'regressed').length
  const improved = report.rows.filter((r) => r.verdict === 'improved').length
  lines.push('')
  lines.push(
    `verdict: ${regressed} regressed, ${improved} improved, ${report.rows.length - regressed - improved} flat/gap`
  )
  return lines.join('\n')
}
