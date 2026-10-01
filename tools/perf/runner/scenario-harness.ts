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

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { createCollector } from '../metrics/cdp-collector.ts'
import { createProcessCollector } from '../metrics/process-collector.ts'
import { renderReport } from '../report/html-report.ts'

import { type PerfRunResult, type PhaseResult, summarize } from '../types.ts'
import {
  buildFakeAgentConfig,
  installAndSelectCatalogAgent,
  registerFakeAgent,
  reloadRenderer,
  seedComposerModel
} from './agent-config.ts'
import { type AppHandle, launchApp, REPO_ROOT, RESULTS_ROOT } from './launch.ts'

const execFileAsync = promisify(execFile)

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
  /** The agent name the launcher's pill must show before a chat is sent. */
  expectedAgentName?: string
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
  // --work real on the fake lane = mock-realistic agent: real tool-call
  // shapes (edit diffs, execute output), tool_call_update lifecycle,
  // ~900-char markdown chunks, per-session RNG divergence.
  if (flags.work === 'real') {
    env.PERF_AGENT_MOCK = '1'
    env.PERF_AGENT_TOOL_UPDATE_DELAY = '4'
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
    const { stdout: text } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      windowsHide: true
    })
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
    const realAgentId =
      typeof flags['use-real-agent'] === 'string' && flags['use-real-agent'].length > 0
        ? flags['use-real-agent']
        : null
    // The name the launcher's agent pill must show before a chat is sent.
    // Fake lane = the config's display name ('Perf Stub Agent'); real lane =
    // the catalog id capitalized the way registerFakeAgent derives it.
    let expectedAgentName: string | undefined
    if (realAgentId) {
      // Real catalog agent: download + install its binary into the dev
      // identifier's app-data, persist the resulting installedBinaryConfig
      // under `acp-registry:<id>` (resolves 'ready'), seed last-selected so
      // the launcher's restore picks it. The composer path then drives the
      const { configId } = await installAndSelectCatalogAgent(handle, realAgentId)
      expectedAgentName = realAgentId.charAt(0).toUpperCase() + realAgentId.slice(1)
      const model =
        typeof flags['use-real-agent-model'] === 'string' &&
        flags['use-real-agent-model'].length > 0
          ? flags['use-real-agent-model']
          : 'opencode/nemotron-3.5-lightning-free'
      // Pin a model the agent can actually serve with zero auth — opencode's
      // built-in *-free tier — so session/new doesn't land on a gated model.
      await seedComposerModel(handle, configId, model)
      await reloadRenderer(handle)
    } else if (scenario.needsFakeAgent !== false) {
      const agentEnv = fakeAgentEnv(flags, {})
      const config = buildFakeAgentConfig(REPO_ROOT, agentEnv)
      await registerFakeAgent(handle, config)
      expectedAgentName = config.name
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
      expectedAgentName,
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
  const reactProfiling = process.env.TERMUL_PERF_PROFILING === '1'
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
      machine: process.env.COMPUTERNAME,
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
