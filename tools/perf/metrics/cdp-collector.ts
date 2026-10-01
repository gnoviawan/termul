/**
 * CDP-attached metric collector (CAP-3) — ties the three passive layers to
 * the connected page:
 *
 * - Injects the page-observer + React-hook scripts on every new document
 *   (`Page.addScriptToEvaluateOnNewDocument` primary, `addInitScript`
 *   fallback, per architecture.md implementation-unknowns).
 * - Polls `Performance.getMetrics` (JSHeapUsedSize, Nodes, Documents,
 *   LayoutCount) at a fixed cadence.
 * - Drains the in-page buffers per phase and converts them into the
 *   result-schema types.
 *
 * Everything is passive: no app state mutation, no input synthesis.
 */

import type { CDPSession, Page } from 'playwright'
import type {
  CdpMetricsSnapshot,
  ComponentStat,
  FrameDelta,
  LoafRecord,
  MetricSample,
  PageMetrics,
  ReactMetrics,
  TimedEvent
} from '../types.ts'
import { DRAIN_SCRIPT, PAGE_OBSERVER_SCRIPT } from './page-observers.ts'
import { REACT_DRAIN_SCRIPT, REACT_INJECT_SCRIPT } from './react-scan-inject.ts'

interface InPageSnapshot {
  loaf: LoafRecord[]
  longtasks: TimedEvent[]
  interactions: TimedEvent[]
  frames: FrameDelta[]
  heapUsed: MetricSample[]
  heapTotal: MetricSample[]
  eventKinds: string[]
  phases: Array<{ name: string; t0: number; t1: number }>
}

interface ReactDrain {
  active: boolean
  note?: string
  rootCommits?: number
  components: ComponentStat[]
  totalCommits: number
  /** Drain emits {t, deltaMs} — wall time of each root commit. */
  rootCommitDurations?: Array<{ t: number; deltaMs: number }>
}

export interface CollectorOptions {
  /** CDP Performance.getMetrics poll cadence (ms, default 2000). */
  cdpCadenceMs?: number
}

export interface PerfCollector {
  /** Install scripts into the page (call right after attach, before load). */
  inject(): Promise<void>
  /** Mark a phase boundary in-page (name recorded with t0/t1). */
  markPhaseStart(name: string): Promise<void>
  markPhaseEnd(name: string): Promise<void>
  /** Drain + snapshot everything accumulated since the last drain. */
  drainPhase(): Promise<{ page: PageMetrics; react: ReactMetrics }>
  /** Collectors report their own gaps; consumed at phase assembly. */
  gaps(): string[]
  /** Stop polling timers. */
  stop(): void
}

export async function createCollector(
  page: Page,
  opts: CollectorOptions = {}
): Promise<PerfCollector> {
  // One CDP session per page for the whole run: script injection, metric
  // polls, and phase marks all multiplex over it.
  const cdp: CDPSession = await page.context().newCDPSession(page)
  const gaps: string[] = []
  const cdpCadence = opts.cdpCadenceMs ?? 2000
  const cdpSnapshots: CdpMetricsSnapshot[] = []
  const startedAt = Date.now()
  let cdpTimer: ReturnType<typeof setInterval> | null = null
  let injected = false

  const cdpSend = async <T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> => {
    // Playwright types send() keys narrowly; this surface is intentionally
    // string-keyed (Page.addScriptToEvaluateOnNewDocument, Runtime.evaluate...).
    return (await (
      cdp.send as unknown as (m: string, p?: Record<string, unknown>) => Promise<unknown>
    )(method, params)) as T
  }

  const pollCdpMetrics = async (): Promise<void> => {
    try {
      const res = await cdpSend<{ metrics: Array<{ name: string; value: number }> }>(
        'Performance.getMetrics'
      )
      const metrics: Record<string, number> = {}
      for (const m of res.metrics) metrics[m.name] = m.value
      cdpSnapshots.push({ t: Date.now() - startedAt, metrics })
    } catch {
      if (gaps.length < 20) gaps.push('Performance.getMetrics poll failed')
    }
  }

  // Evaluate an IIFE-expression string in the page's main world with an
  // optional JSON-serialized argument (phase names).
  const evaluateExpr = async <T>(expression: string, arg?: string): Promise<T | null> => {
    const wrapped = arg === undefined ? expression : `${expression}(${JSON.stringify(arg)})`
    try {
      const res = await cdpSend<{
        result: { value?: unknown }
        exceptionDetails?: { text: string }
      }>('Runtime.evaluate', {
        expression: wrapped,
        returnByValue: true,
        awaitPromise: false
      })
      if (res.exceptionDetails) {
        if (gaps.length < 20) gaps.push(`evaluate failed: ${res.exceptionDetails.text}`)
        return null
      }
      return (res.result?.value ?? null) as T | null
    } catch (err) {
      if (gaps.length < 20) gaps.push(`evaluate threw: ${String(err)}`)
      return null
    }
  }

  return {
    gaps: () => [...gaps, ...(injected ? [] : ['in-page observers never injected'])],

    async inject(): Promise<void> {
      // Primary path: raw CDP addScriptToEvaluateOnNewDocument — runs before
      // the app bundle on every navigation, including the first.
      try {
        await cdpSend('Page.enable')
        await cdpSend('Runtime.enable')
        await cdpSend('Performance.enable')
        await cdpSend('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_OBSERVER_SCRIPT })
        await cdpSend('Page.addScriptToEvaluateOnNewDocument', { source: REACT_INJECT_SCRIPT })
        injected = true
      } catch {
        // Fallback: Playwright addInitScript (applies to subsequent loads).
        try {
          await page.addInitScript(PAGE_OBSERVER_SCRIPT)
          await page.addInitScript(REACT_INJECT_SCRIPT)
          injected = true
        } catch {
          gaps.push('both addScriptToEvaluateOnNewDocument and addInitScript failed')
          return
        }
      }
      // Also evaluate once NOW for the already-loaded document — the app may
      // have finished its first paint before attach completed; the React hook
      // tap must wrap onCommitFiberRoot before more commits happen.
      try {
        await cdpSend('Runtime.evaluate', {
          expression: PAGE_OBSERVER_SCRIPT,
          returnByValue: true
        })
        await cdpSend('Runtime.evaluate', {
          expression: REACT_INJECT_SCRIPT,
          returnByValue: true
        })
      } catch {
        // The app navigated or the context was replaced; the new-document
        // scripts will cover the next load.
      }
      cdpTimer = setInterval(() => {
        void pollCdpMetrics()
      }, cdpCadence)
      await pollCdpMetrics()
    },

    async markPhaseStart(name: string): Promise<void> {
      await evaluateExpr(
        '((name) => { window.__perfPhase = { name, t0: performance.now() }; if (!window.__perfPhases) window.__perfPhases = []; })',
        name
      )
    },

    async markPhaseEnd(name: string): Promise<void> {
      await evaluateExpr(
        '((name) => { const cur = window.__perfPhase; if (!cur || cur.name !== name) return; if (!window.__perfPhases) window.__perfPhases = []; window.__perfPhases.push({ name: cur.name, t0: cur.t0, t1: performance.now() }); })',
        name
      )
    },

    async drainPhase(): Promise<{ page: PageMetrics; react: ReactMetrics }> {
      const snap = await evaluateExpr<InPageSnapshot>(DRAIN_SCRIPT)
      const reactDrain = await evaluateExpr<ReactDrain>(REACT_DRAIN_SCRIPT)
      const page: PageMetrics = {
        loaf: snap?.loaf ?? [],
        longtasks: snap?.longtasks ?? [],
        interactions: snap?.interactions ?? [],
        frames: snap?.frames ?? [],
        heapUsed: snap?.heapUsed ?? [],
        heapTotal: snap?.heapTotal ?? [],
        cdp: cdpSnapshots.splice(0),
        eventKinds: snap?.eventKinds ?? []
      }
      if (snap === null) gaps.push('in-page drain returned null (observers not installed?)')
      const react: ReactMetrics = {
        components: reactDrain?.components ?? [],
        totalCommits: reactDrain?.totalCommits ?? 0,
        rootCommits: reactDrain?.rootCommits,
        // Drain emits {t, deltaMs} — normalise onto MetricSample {t, value}.
        rootCommitDurations: reactDrain?.rootCommitDurations?.map((d) => ({
          t: d.t,
          value: d.deltaMs
        })),
        profilingActive: reactDrain?.active ?? false
      }
      if (reactDrain === null) gaps.push('react drain returned null (hook tap not installed?)')
      return { page, react }
    },

    stop(): void {
      if (cdpTimer) clearInterval(cdpTimer)
      cdpTimer = null
    }
  }
}
