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

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { reloadRenderer, seedPerfProject } from '../runner/agent-config.ts'
import type { ScenarioContext, ScenarioDef } from '../runner/scenario-harness.ts'
import { launchChatViaUI, sleep, spawnFloodTerminal } from '../runner/scenario-ui.ts'

async function drive(ctx: ScenarioContext): Promise<void> {
  const { flags } = ctx
  const terminals = Math.max(1, Math.floor(Number(flags.terminals ?? 3)))
  const warmupSec = Math.max(0, Number(flags.warmup ?? 5))
  const floodSec = Math.max(1, Number(flags.sustain ?? 30))
  const measureSec = Math.max(1, Number(flags.measure ?? 15))
  const withAgentStream = flags['with-agent-stream'] === true
  // --- setup: seed a project (terminals need a live project context) -----
  const seed = await ctx.beginPhase('seed-project')
  const projectDir = path.join(process.env.TEMP ?? 'C:\\temp', 'termul-perf-project')
  mkdirSync(projectDir, { recursive: true })
  await seedPerfProject(ctx.handle, projectDir)
  await reloadRenderer(ctx.handle)
  await seed.end()

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
    // terminals flood (mixed-load variant from scenarios.md). The launcher
    // is the surface after seeding (no chats), so launchChatViaUI works
    // directly — .catch keeps failures cheap inside a flood phase.
    const page = await ctx.handle.page()
    await launchChatViaUI(page, 'perf flood concurrent stream', ctx.expectedAgentName).catch(
      () => undefined
    )
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
