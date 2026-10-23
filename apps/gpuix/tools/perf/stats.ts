import type { PageMetrics, PerfRunResult } from '../../../../tools/perf/types.ts'
import { percentile, summarize } from '../../../../tools/perf/types.ts'
import type { ProcSample } from './proc-sampler.ts'

export type Numbers = Record<string, number>

const MB = 1024 * 1024
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

export function median(values: number[]): number {
  return percentile(values, 0.5)
}

/** Memory in MB (median and max over the window), CPU in % of one core (mean). */
export function summarizeProc(samples: ProcSample[], prefix: string): Numbers {
  const out: Numbers = {}
  if (samples.length === 0) return out
  const roles = new Set(samples.flatMap((s) => Object.keys(s.roles)))
  const series = (pick: (s: ProcSample) => number) => samples.map(pick)
  const add = (key: string, rss: number[], pss: number[], cpu: number[]) => {
    out[`${prefix}${key}.rssMedianMB`] = round(median(rss) / MB)
    out[`${prefix}${key}.rssMaxMB`] = round(Math.max(...rss) / MB)
    out[`${prefix}${key}.pssMedianMB`] = round(median(pss) / MB)
    out[`${prefix}${key}.pssMaxMB`] = round(Math.max(...pss) / MB)
    out[`${prefix}${key}.cpuMeanPct`] = round(cpu.reduce((a, b) => a + b, 0) / cpu.length)
  }
  add(
    'total',
    series((s) => s.total.rss),
    series((s) => s.total.pss),
    series((s) => s.total.cpu)
  )
  for (const role of roles) {
    add(
      role,
      series((s) => s.roles[role]?.rss ?? 0),
      series((s) => s.roles[role]?.pss ?? 0),
      series((s) => s.roles[role]?.cpu ?? 0)
    )
  }
  return out
}

/** Frame pacing and main-thread jank for one phase, via tools/perf summarize(). */
export function summarizePage(page: PageMetrics, durationMs: number): Numbers {
  const run: PerfRunResult = {
    meta: {
      runId: 'phase',
      scenario: 'phase',
      startedAt: '',
      params: {},
      seed: 0,
      lane: 'browser',
      appTarget: '',
      reactProfiling: false,
      status: 'ok'
    },
    phases: [{ name: 'phase', startedAtMs: 0, durationMs, page, gaps: [] }],
    summary: {}
  }
  const s = summarize(run)
  const deltas = page.frames.map((f) => f.deltaMs)
  const longtaskMs = page.longtasks.reduce((a, t) => a + t.duration, 0)
  return {
    'page.frames': deltas.length,
    'page.fps': round(deltas.length / (durationMs / 1000)),
    'page.frameP50Ms': round(percentile(deltas, 0.5)),
    'page.frameP95Ms': round(percentile(deltas, 0.95)),
    'page.frameP99Ms': round(percentile(deltas, 0.99)),
    'page.framesOver25Ms': s.droppedFrameCount,
    'page.framesOver50Ms': deltas.filter((d) => d > 50).length,
    'page.longtasks': s.longtaskCount,
    'page.longtaskMs': round(longtaskMs),
    'page.longtaskMsPerSec': round(longtaskMs / (durationMs / 1000)),
    'page.loafCount': s.totalLoafCount,
    'page.loafBlockingMs': round(s.totalLoafBlockingMs),
    'page.heapEndMB': round(s.heapEndBytes / MB),
    'page.domNodes': s.cdpNodes
  }
}

/** Median and range of every metric across runs. */
export function aggregate(
  runs: Numbers[]
): Record<string, { median: number; min: number; max: number; n: number }> {
  const keys = new Set(runs.flatMap((r) => Object.keys(r)))
  const out: Record<string, { median: number; min: number; max: number; n: number }> = {}
  for (const key of [...keys].sort()) {
    const xs = runs
      .map((r) => r[key])
      .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    if (xs.length === 0) continue
    out[key] = {
      median: round(median(xs), 2),
      min: round(Math.min(...xs), 2),
      max: round(Math.max(...xs), 2),
      n: xs.length
    }
  }
  return out
}
