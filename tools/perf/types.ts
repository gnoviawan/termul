/**
 * Shared result schema for every perf-toolkit run (CAP-2..CAP-6).
 *
 * One `PerfRunResult` is written per run into
 * `tools/perf/results/<run-id>/result.json`; the HTML report and the
 * `compare` command both consume this shape. Scenarios append phase
 * measurements as they go, so the schema is append-friendly: every phase
 * carries its own metric bundles and gaps stay explicit (a collector that
 * failed records `null` plus a reason, it never silently disappears).
 */

/** One sample of an in-page or OS-level counter. */
export interface MetricSample {
  /** Milliseconds since the run's t0 (monotonic, phase-relative). */
  t: number
  value: number
}

/** A named time series (heap bytes, LoAF counts, private bytes, ...). */
export interface MetricSeries {
  metric: string
  /** Human-readable unit for the report (bytes, ms, count, percent). */
  unit: 'bytes' | 'ms' | 'count' | 'percent' | 'fps'
  samples: MetricSample[]
}

/** A single long-animation-frame attribution record (CAP-4). */
export interface LoafRecord {
  t: number
  duration: number
  blockingDuration: number
  /** Per-script attribution as reported by the LoAF observer. */
  scripts: Array<{
    name: string
    duration: number
    sourceUrl?: string
    sourceFunctionName?: string
    /** "x" file lines — "1:234" form. */
    sourceLine?: string
    invoker?: string
  }>
}

/** React-layer attribution: per-component commit counts and durations. */
export interface ComponentStat {
  component: string
  commits: number
  /** Sum of onRender actualDuration across commits (ms). */
  totalDurationMs: number
  /** Highest single-commit actualDuration (ms). */
  maxDurationMs: number
}

/** One CDP `Performance.getMetrics` snapshot. */
export interface CdpMetricsSnapshot {
  t: number
  metrics: Record<string, number>
}

/** rAF cadence bucket — deltas between consecutive frames. */
export interface FrameDelta {
  t: number
  deltaMs: number
}

/** A longtask or interaction-latency event observed in-page. */
export interface TimedEvent {
  t: number
  duration: number
  /** Event type for `event` entries (click/keydown); task name for longtasks. */
  name: string
  /** Interaction latency start offset relative to the event's start (ms). */
  startDelay?: number
}

export interface PageMetrics {
  /** Long animation frames + script attribution (CAP-4). */
  loaf: LoafRecord[]
  /** Legacy long tasks (fallback attribution when LoAF is unsupported). */
  longtasks: TimedEvent[]
  /** Interaction-to-next-paint style events. */
  interactions: TimedEvent[]
  /** rAF frame deltas for FPS/cadence percentiles. */
  frames: FrameDelta[]
  /** JS heap used bytes (performance.memory / getMetrics). */
  heapUsed: MetricSample[]
  heapTotal: MetricSample[]
  /** CDP Performance.getMetrics snapshots (Nodes, Documents, LayoutCount...). */
  cdp: CdpMetricsSnapshot[]
  /** Deterministic sessionUpdate event-sequence hash (CAP-1). */
  eventSequenceHash?: string
  /** Number of sessionUpdate events observed. */
  eventCount?: number
  /** The raw sessionUpdate kinds observed, in order (bounded buffer). */
  eventKinds?: string[]
}

export interface ProcessMetrics {
  /** Renderer private bytes series (Windows counter, by ms since t0). */
  privateBytes: MetricSample[]
  workingSet: MetricSample[]
  cpuPercent: MetricSample[]
  /** Which processes the counters were sampled from (pid → name). */
  processes: Array<{ pid: number; name: string; parentPid: number | null }>
}

export interface ReactMetrics {
  /** Component commit stats keyed by phase name. */
  components: ComponentStat[]
  /** Total commit count across all instrumented components. */
  totalCommits: number
  /** True when a profiling-capable React build was active. */
  profilingActive: boolean
  /** Why profiling was not active, when it was not. */
  profilingNote?: string
}

/** One scenario phase (warmup / sustained stream / measure / switch cycles). */
export interface PhaseResult {
  name: string
  /** Wall-clock ms since run t0 when the phase started. */
  startedAtMs: number
  durationMs: number
  page?: PageMetrics
  process?: ProcessMetrics
  react?: ReactMetrics
  /** Scenario-specific extras (switch latencies, flood throughput...). */
  derived?: Record<string, number | string[]>
  /** Explicit gap lines: which collectors failed and why. */
  gaps: string[]
}

export interface RunMeta {
  runId: string
  scenario: string
  /** ISO timestamp of run start. */
  startedAt: string
  /** CLI args the scenario received (seed, agents, duration...). */
  params: Record<string, string | number | boolean>
  seed: number
  /** Lane: 'desktop' (WebView2 real app) or 'browser' (termul-server). */
  lane: 'desktop' | 'browser'
  /** Absolute path of the app exe / server URL used. */
  appTarget: string
  /** Git commit of the repo at run time (best effort). */
  gitCommit?: string
  /** Whether the react-dom/profiling alias build was active. */
  reactProfiling: boolean
  /** Machine notes (hostname, CPU) for reproducibility. */
  machine?: string
  /** Exit status of the run. */
  status: 'ok' | 'failed'
  failure?: string
}

export interface PerfRunResult {
  meta: RunMeta
  phases: PhaseResult[]
  /** Aggregate view across phases (the compare input). */
  summary: Record<string, number>
}

/** Aggregation mode for compare (metrics-catalog: min + median). */
export type AggregateMode = 'min' | 'median'

export interface CompareMetricRow {
  metric: string
  base: number | null
  against: number | null
  deltaMin: number | null
  deltaMedian: number | null
  /** pct change of medians, when both sides have the metric. */
  pctMedian: number | null
  verdict: 'improved' | 'regressed' | 'flat' | 'gap'
  /** Threshold that fired (when verdict is improved/regressed). */
  threshold?: number
}

export interface CompareReport {
  baseRunId: string
  againstRunId: string
  rows: CompareMetricRow[]
  /** Explicit gap lines for metrics missing on either side. */
  gaps: string[]
}

/** Summary keys produced by summarize() — also the compare metric set. */
export interface SummaryKeys {
  totalCommits: number
  totalLoafCount: number
  totalLoafBlockingMs: number
  longtaskCount: number
  heapSlopeBytesPerSec: number
  heapEndBytes: number
  privateBytesEnd: number
  privateBytesSlopeBytesPerSec: number
  frameP05Fps: number
  frameP50Fps: number
  frameP95Fps: number
  droppedFrameCount: number
  interactionCount: number
  interactionMaxMs: number
  cdpNodes: number
  cdpLayoutCount: number
  cdpJsHeapUsed: number
}

/**
 * Linear regression slope of a series (y per second, x in ms).
 * Returns 0 for degenerate input rather than NaN so compare never blows up.
 */
export function slopeBytesPerSec(samples: MetricSample[]): number {
  const n = samples.length
  if (n < 2) return 0
  let sumX = 0
  let sumY = 0
  for (const s of samples) {
    sumX += s.t
    sumY += s.value
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let num = 0
  let den = 0
  for (const s of samples) {
    num += (s.t - meanX) * (s.value - meanY)
    den += (s.t - meanX) ** 2
  }
  if (den === 0) return 0
  // slope per ms → per second
  return (num / den) * 1000
}

/** Median of a numeric array (0 for empty). */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** p-th percentile (0..1) of a numeric array (0 for empty). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[idx]
}

/** Last sample value of a series (0 for empty). */
export function lastValue(series: MetricSample[]): number {
  return series.length > 0 ? series[series.length - 1].value : 0
}

/** Collapse a phase list into the flat summary used by compare. */
export function summarize(result: PerfRunResult): Record<string, number> {
  const out: Record<string, number> = {}
  const commits: number[] = []
  let totalCommits = 0
  let loafCount = 0
  let loafBlockingMs = 0
  let longtaskCount = 0
  let interactionCount = 0
  let interactionMax = 0
  let droppedFrames = 0
  const heapSlopes: number[] = []
  const heapEnds: number[] = []
  const privateEnds: number[] = []
  const privateSlopes: number[] = []
  const fpsAll: number[] = []
  let cdpNodes = 0
  let cdpLayoutCount = 0
  let cdpJsHeap = 0
  for (const phase of result.phases) {
    const page = phase.page
    if (page) {
      loafCount += page.loaf.length
      for (const l of page.loaf) loafBlockingMs += l.blockingDuration
      longtaskCount += page.longtasks.length
      interactionCount += page.interactions.length
      for (const i of page.interactions) interactionMax = Math.max(interactionMax, i.duration)
      for (const f of page.frames) if (f.deltaMs > 25) droppedFrames++
      if (page.heapUsed.length > 0) {
        heapSlopes.push(slopeBytesPerSec(page.heapUsed))
        heapEnds.push(lastValue(page.heapUsed))
      }
      const frameDeltas = page.frames.map((f) => (f.deltaMs > 0 ? 1000 / f.deltaMs : 0))
      if (frameDeltas.length > 0) fpsAll.push(...frameDeltas)
      for (const snap of page.cdp) {
        cdpNodes = Math.max(cdpNodes, snap.metrics.Nodes ?? 0)
        cdpLayoutCount = Math.max(cdpLayoutCount, snap.metrics.LayoutCount ?? 0)
        cdpJsHeap = Math.max(cdpJsHeap, snap.metrics.JSHeapUsedSize ?? 0)
      }
    }
    if (phase.process) {
      if (phase.process.privateBytes.length > 0) {
        privateEnds.push(lastValue(phase.process.privateBytes))
        privateSlopes.push(slopeBytesPerSec(phase.process.privateBytes))
      }
    }
    if (phase.react) {
      totalCommits += phase.react.totalCommits
      for (const c of phase.react.components) commits.push(c.commits)
    }
  }
  out.totalCommits = totalCommits
  out.topComponentCommits = commits.length > 0 ? Math.max(...commits) : 0
  out.totalLoafCount = loafCount
  out.totalLoafBlockingMs = loafBlockingMs
  out.longtaskCount = longtaskCount
  out.heapSlopeBytesPerSec = median(heapSlopes)
  out.heapEndBytes = median(heapEnds)
  out.privateBytesEnd = median(privateEnds)
  out.privateBytesSlopeBytesPerSec = median(privateSlopes)
  out.frameP05Fps = percentile(fpsAll, 0.05)
  out.frameP50Fps = percentile(fpsAll, 0.5)
  out.frameP95Fps = percentile(fpsAll, 0.95)
  out.droppedFrameCount = droppedFrames
  out.interactionCount = interactionCount
  out.interactionMaxMs = interactionMax
  out.cdpNodes = cdpNodes
  out.cdpLayoutCount = cdpLayoutCount
  out.cdpJsHeapUsed = cdpJsHeap
  return out
}
