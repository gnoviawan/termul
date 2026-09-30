/**
 * CAP-7 secondary lane: the same scenario scripts against the termul-server
 * web client, headless, producing results in the same schema as desktop
 * runs.
 *
 * Stream-storm and project-switch only (spec: the terminal/PTY lane and
 * soak are desktop-primary). Load can use the same fake agents through the
 * server's agent path — the web client talks to termul-server over WS, and
 * the server spawns agents exactly like the desktop Rust host.
 *
 * Differences from the desktop lane:
 *  - The target is a URL (http://127.0.0.1:<port>), launched with plain
 *    `chromium.launch({ headless: true })` — no WebView2, no PID tree.
 *  - Process counters sample the termul-server node/bun process tree
 *    (still OS-level, still passive).
 *  - Everything else — observer injection, phase marking, result schema,
 *    report — is identical to the desktop lane.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { createCollector } from '../metrics/cdp-collector'
import { renderReport } from '../report/html-report'
import { pickFreePort } from '../runner/launch'
import { type PerfRunResult, type PhaseResult, summarize } from '../types'
import { RESULTS_ROOT, type ScenarioFlags } from './browser-shared'

export interface BrowserRunOptions {
  scenario: 'stream-storm' | 'project-switch'
  flags: ScenarioFlags
  /** Server base URL; default http://127.0.0.1:3000 (termul-server default). */
  serverUrl?: string
}

export interface BrowserContext {
  page: Page
  flags: ScenarioFlags
  seed: number
  runId: string
  beginPhase(name: string): Promise<{ name: string; end(): Promise<PhaseResult> }>
  lastPhase(): PhaseResult | null
}

/**
 * Launch the headless browser against the web client. If `serverUrl` points
 * at a not-yet-started server, the caller starts termul-server first; this
 * module only attaches.
 */
export async function runBrowserScenario(
  opts: BrowserRunOptions,
  drive: (ctx: BrowserContext) => Promise<void>
): Promise<string> {
  const serverUrl = opts.serverUrl ?? 'http://127.0.0.1:3000'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const runId = `${opts.scenario}-browser-${stamp}`
  const runDir = path.join(RESULTS_ROOT, runId)
  mkdirSync(runDir, { recursive: true })

  const startedAt = Date.now()
  const phases: PhaseResult[] = []
  const gaps: string[] = []
  const port = await pickFreePort()
  let browser: Browser | null = null

  try {
    browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`]
    })
    const page = await browser.newPage()
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    const collector = await createCollector(page)
    await collector.inject()
    // No PID tree to sample in the browser lane; process metrics stay absent
    // and the gap is explicit (the schema never invents numbers).
    gaps.push('process metrics: not captured in the browser lane (no WebView2 tree)')

    const makeClock = (name: string) => {
      const phaseStartWall = Date.now() - startedAt
      let ended = false
      return {
        name,
        end: async (): Promise<PhaseResult> => {
          if (ended) throw new Error(`phase ${name} ended twice`)
          ended = true
          const phaseEndWall = Date.now() - startedAt
          await collector.markPhaseEnd(name).catch(() => undefined)
          const drained = await collector.drainPhase().catch((err: unknown) => {
            gaps.push(`drain failed: ${String(err)}`)
            return null
          })
          const result: PhaseResult = {
            name,
            startedAtMs: phaseStartWall,
            durationMs: phaseEndWall - phaseStartWall,
            page: drained?.page,
            react: drained?.react,
            gaps: [...gaps, ...collector.gaps()]
          }
          phases.push(result)
          return result
        }
      }
    }

    const ctx: BrowserContext = {
      page,
      flags: opts.flags,
      seed: Number(opts.flags.seed ?? 42),
      runId,
      beginPhase: async (name) => {
        await collector.markPhaseStart(name).catch(() => undefined)
        return makeClock(name)
      },
      lastPhase: () => (phases.length > 0 ? phases[phases.length - 1] : null)
    }
    await drive(ctx)
  } finally {
    await browser?.close().catch(() => undefined)
  }

  const result: PerfRunResult = {
    meta: {
      runId,
      scenario: opts.scenario,
      startedAt: new Date(startedAt).toISOString(),
      params: Object.fromEntries(
        Object.entries(opts.flags).map(([k, v]) => [k, v as string | number | boolean])
      ),
      seed: Number(opts.flags.seed ?? 42),
      lane: 'browser',
      appTarget: serverUrl,
      reactProfiling: Bun.env.TERMUL_PERF_PROFILING === '1',
      machine: Bun.env.COMPUTERNAME,
      status: 'ok'
    },
    phases,
    summary: {}
  }
  result.summary = summarize(result)
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2))
  writeFileSync(path.join(runDir, 'report.html'), renderReport(result))
  console.log(`run ${runId} ok (browser lane) → ${runDir}`)
  return runId
}
