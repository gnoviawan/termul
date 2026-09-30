/**
 * Shared scenario driver harness (CAP-2) — one place for the
 * spawn → attach → inject → phases → teardown → write pipeline every
 * scenario uses.
 *
 * Scenarios provide a `drive(ctx)` function; the harness owns:
 *  - run id + result dir creation
 *  - app launch/attach (with fake-agent registration + renderer reload)
 *  - collector injection (page observers + React hook tap)
 *  - process-counter sampling at fixed cadence
 *  - phase bookkeeping (mark/drain → PhaseResult assembly)
 *  - result.json + report.html writing
 *  - teardown (process tree kill, scratch dir cleanup)
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createCollector } from '../metrics/cdp-collector'
import { createProcessCollector } from '../metrics/process-collector'
import { renderReport } from '../report/html-report'
import { type PerfRunResult, type PhaseResult, summarize } from '../types'
import { buildFakeAgentConfig, registerFakeAgent, reloadRenderer } from './agent-config'
import { type AppHandle, launchApp, REPO_ROOT, RESULTS_ROOT } from './launch'

export interface ScenarioFlags {
  [key: string]: string | number | boolean | undefined
}

export interface ScenarioContext {
  handle: AppHandle
  flags: ScenarioFlags
  seed: number
  /** Run id (also the results dir name). */
  runId: string
  /** The shared collector (already injected when drive() is called). */
  collector: Awaited<ReturnType<typeof createCollector>>
  /** Start a named phase (marks in-page + wall-clock t0). */
  beginPhase(name: string): Promise<PhaseClock>
  /** The most recently begun phase (scenario derived-data hook). */
  lastPhase(): PhaseResult | null
  /** Wall-clock ms since harness start. */
  elapsedMs(): number
}

export interface PhaseClock {
  name: string
  /** End the phase, drain all collectors, and append the PhaseResult. */
  end(): Promise<PhaseResult>
}

export interface ScenarioDef {
  name: string
  /** Default flags (documented in help). */
  defaults: Record<string, string | number | boolean>
  /** Drive the scenario; return scenario-specific derived values. */
  drive(ctx: ScenarioContext): Promise<void>
  /** Whether this scenario spawns the fake agent at all. */
  needsFakeAgent?: boolean
}

/** Parse `--key value` / `--flag` args into a flags object. */
export function parseFlags(
  argv: string[],
  defaults: Record<string, string | number | boolean>
): ScenarioFlags {
  const flags: ScenarioFlags = { ...defaults }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      const asNum = Number(next)
      const value: string | number = Number.isFinite(asNum) ? asNum : next
      flags[key] = value
      i++
    }
  }
  return flags
}

function flagNumber(flags: ScenarioFlags, key: string, fallback: number): number {
  const v = flags[key]
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

/** Build the env the fake agent processes read (instance-offset seeds). */
export function fakeAgentEnv(
  flags: ScenarioFlags,
  overrides: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {
    PERF_AGENT_SEED: String(flagNumber(flags, 'seed', 42)),
    PERF_AGENT_RATE: String(flagNumber(flags, 'rate', 20)),
    PERF_AGENT_CHUNK_CHARS: String(flagNumber(flags, 'chunk-chars', 120))
  }
  const duration = flags.duration
  if (typeof duration === 'number' && duration > 0) {
    env.PERF_AGENT_DURATION = String(duration)
  }
  return { ...env, ...overrides }
}

/** Best-effort current commit for the run record (async — no sync spawn). */
async function gitCommitAsync(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

export interface RunScenarioOptions {
  scenario: ScenarioDef
  argv: string[]
  /** Lane: desktop (real app) or browser (termul-server, CAP-7). */
  lane?: 'desktop' | 'browser'
}

/** Run a scenario end-to-end; returns the run id (result dir name). */
export async function runScenario(opts: RunScenarioOptions): Promise<string> {
  const { scenario } = opts
  const flags = parseFlags(opts.argv, scenario.defaults)
  const seed = flagNumber(flags, 'seed', 42)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const runId = `${scenario.name}-${stamp}`
  const runDir = path.join(RESULTS_ROOT, runId)
  mkdirSync(runDir, { recursive: true })

  const startedAt = Date.now()
  const phases: PhaseResult[] = []
  let handle: AppHandle | null = null
  let processCollector: ReturnType<typeof createProcessCollector> | null = null
  let collector: Awaited<ReturnType<typeof createCollector>> | null = null
  let failure: string | undefined

  // Phase assembly shared by PhaseClock.end().
  const phaseGaps: string[] = []

  try {
    handle = await launchApp({
      runId,
      exe: typeof flags.exe === 'string' ? flags.exe : undefined,
      keepState: flags['keep-state'] === true
    })
    if (scenario.needsFakeAgent !== false) {
      const agentEnv = fakeAgentEnv(flags, {})
      const config = buildFakeAgentConfig(REPO_ROOT, agentEnv)
      await registerFakeAgent(handle, config)
      await reloadRenderer(handle)
    }
    const page = await handle.page()
    collector = await createCollector(page)
    await collector.inject()
    processCollector = createProcessCollector()
    processCollector.start(handle.rootPid, 2000)

    const makePhaseClock = (name: string): PhaseClock => {
      const phaseStartWall = Date.now() - startedAt
      let ended = false
      return {
        name,
        end: async (): Promise<PhaseResult> => {
          if (ended) throw new Error(`phase ${name} ended twice`)
          ended = true
          const phaseEndWall = Date.now() - startedAt
          if (collector) {
            await collector.markPhaseEnd(name).catch(() => undefined)
          }
          const drained = collector
            ? await collector.drainPhase().catch((err: unknown) => {
                phaseGaps.push(`drain failed: ${String(err)}`)
                return null
              })
            : null
          const procGaps: string[] = []
          const stoppedCollector = processCollector
          const process = stoppedCollector ? stoppedCollector.stop() : undefined
          if (stoppedCollector) {
            procGaps.push(...stoppedCollector.errors)
          } else {
            procGaps.push('process collector never started')
          }
          // Restart the process collector for the next phase so each phase
          // carries its own series slice.
          if (processCollector && handle) processCollector.start(handle.rootPid, 2000)
          const result: PhaseResult = {
            name,
            startedAtMs: phaseStartWall,
            durationMs: phaseEndWall - phaseStartWall,
            page: drained?.page,
            react: drained?.react,
            process,
            gaps: [...phaseGaps, ...procGaps]
          }
          phases.push(result)
          return result
        }
      }
    }

    const ctx: ScenarioContext = {
      handle,
      flags,
      seed,
      runId,
      collector,
      beginPhase: async (name: string) => {
        if (collector) await collector.markPhaseStart(name).catch(() => undefined)
        return makePhaseClock(name)
      },
      lastPhase: () => (phases.length > 0 ? phases[phases.length - 1] : null),
      elapsedMs: () => Date.now() - startedAt
    }

    await scenario.drive(ctx)
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  } finally {
    collector?.stop()
    processCollector?.stop()
    if (handle) {
      await handle.teardown().catch(() => undefined)
    }
  }

  const commit = await gitCommitAsync().catch(() => undefined)
  const reactProfiling = Bun.env.TERMUL_PERF_PROFILING === '1'
  const result: PerfRunResult = {
    meta: {
      runId,
      scenario: scenario.name,
      startedAt: new Date(startedAt).toISOString(),
      params: Object.fromEntries(
        Object.entries(flags)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, v as string | number | boolean])
      ),
      seed,
      lane: opts.lane ?? 'desktop',
      appTarget: handle?.exe ?? (typeof flags.exe === 'string' ? flags.exe : 'unresolved'),
      gitCommit: commit,
      reactProfiling,
      machine: Bun.env.COMPUTERNAME,
      status: failure ? 'failed' : 'ok',
      failure
    },
    phases,
    summary: {}
  }
  result.summary = summarize(result)

  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2))
  writeFileSync(path.join(runDir, 'report.html'), renderReport(result))
  console.log(`run ${runId} ${failure ? 'FAILED' : 'ok'} → ${runDir}`)
  if (failure) {
    throw new Error(failure)
  }
  return runId
}
