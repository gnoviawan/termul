/**
 * pty-flood scenario (CAP-2) — T terminals running canned high-throughput
 * output scripts (sustained lines/s + resize churn), plus optional
 * concurrent agent stream.
 *
 * The flood script (tools/perf/fake-agent/flood.ts) is spawned through the
 * app's REAL PTY path: `terminal_spawn` with
 * `{ program: 'bun', args: [<flood.ts>] }` — `resolve_program_path`
 * accepts PE images so `bun flood.ts` runs (verified in the code map).
 *
 * Phases: warmup → flood (sustained) → measure.
 * Answers (scenarios.md): xterm write/render cost and resize churn under
 * flood; isolates terminal-bound vs React-bound jank.
 */

import path from 'node:path'
import { REPO_ROOT } from '../runner/launch'
import type { ScenarioContext, ScenarioDef } from '../runner/scenario-harness'

interface SpawnedTerminal {
  id: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Spawn one flood terminal through the app's terminal IPC. The renderer's
 * `terminalApi.spawn` builds a binary Channel; from CDP we invoke the
 * Tauri command with the same options (the Channel is optional plumbing —
 * the flood keeps writing regardless of whether we attach the data
 * consumer; the terminal store attaches its own).
 */
async function spawnFloodTerminal(ctx: ScenarioContext, index: number): Promise<SpawnedTerminal> {
  const floodScript = path.join(REPO_ROOT, 'tools', 'perf', 'fake-agent', 'flood.ts')
  const linesPerSec = Number(ctx.flags['lines-per-sec'] ?? 200)
  const resizeEvery = Number(ctx.flags['resize-every'] ?? 200)
  const duration = Number(ctx.flags.duration ?? 0)
  const result = await ctx.handle.tauriInvoke<SpawnedTerminal>('terminal_spawn', {
    options: {
      program: 'bun',
      args: [floodScript],
      env: {
        PERF_FLOOD_LINES_PER_SEC: String(linesPerSec),
        PERF_FLOOD_RESIZE_EVERY: String(resizeEvery),
        PERF_FLOOD_DURATION: String(duration),
        PERF_FLOOD_SEED: String(ctx.seed + index)
      },
      cols: 120,
      rows: 30,
      kind: 'shell'
    }
  })
  return result
}

async function drive(ctx: ScenarioContext): Promise<void> {
  const { flags } = ctx
  const terminals = Math.max(1, Math.floor(Number(flags.terminals ?? 3)))
  const warmupSec = Math.max(0, Number(flags.warmup ?? 5))
  const floodSec = Math.max(1, Number(flags.sustain ?? 30))
  const measureSec = Math.max(1, Number(flags.measure ?? 15))
  const withAgentStream = flags['with-agent-stream'] === true

  // --- warmup: one terminal up first (renderer attach, xterm mount) -------
  const warmup = await ctx.beginPhase('warmup')
  await spawnFloodTerminal(ctx, 0)
  await sleep(warmupSec * 1000)
  await warmup.end()

  // --- flood: remaining terminals + optional agent stream ------------------
  const flood = await ctx.beginPhase('flood')
  for (let i = 1; i < terminals; i++) {
    await spawnFloodTerminal(ctx, i)
    await sleep(300)
  }
  if (withAgentStream) {
    // Optional concurrent agent stream: drive a launcher chat while the
    // terminals flood (mixed-load variant from scenarios.md).
    const page = await ctx.handle.page()
    const composer = page.locator('[data-composer-editor="true"]').first()
    if (await composer.count()) {
      await composer.click().catch(() => undefined)
      await composer.type('perf flood concurrent stream', { delay: 3 }).catch(() => undefined)
      await page
        .locator('button[aria-label="Start agent chat"]')
        .first()
        .click()
        .catch(() => undefined)
    }
  }
  await sleep(floodSec * 1000)
  await flood.end()

  // --- measure: flood continues (duration=0 = forever until killed) --------
  const measure = await ctx.beginPhase('measure')
  await sleep(measureSec * 1000)
  await measure.end()
}

export const ptyFloodScenario: ScenarioDef = {
  name: 'pty-flood',
  defaults: {
    terminals: 3,
    'lines-per-sec': 200,
    'resize-every': 200,
    seed: 42,
    warmup: 5,
    sustain: 30,
    measure: 15
  },
  drive
}
