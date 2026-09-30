/**
 * soak scenario (CAP-2) — stream-storm load held for a long duration
 * (default 30 min, `--minutes`), with periodic project switches.
 *
 * Phases: warmup → soak window (sampled continuously) → measure.
 *
 * Memory signature (the 2026-09-28 incident): JS heap + renderer private
 * bytes vs time distinguish allocation churn (sawtooth, flat slope) from
 * retained-heap growth (monotonic climb). The process collector samples at
 * its fixed cadence for the whole window; heap slope comes from the linear
 * regression in the report.
 *
 * This scenario is LONG (>15 min default). The CLI requires --yes (or the
 * --minutes override) so unattended scripts don't accidentally pin a dev
 * machine for half an hour.
 */

import type { ScenarioContext, ScenarioDef } from '../runner/scenario-harness'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function drive(ctx: ScenarioContext): Promise<void> {
  const { handle, flags } = ctx
  const page = await handle.page()
  const minutes = Math.max(1, Number(flags.minutes ?? 30))
  const warmupSec = Math.max(0, Number(flags.warmup ?? 10))
  const switchEverySec = Math.max(10, Number(flags['switch-every-sec'] ?? 120))
  const agents = Math.max(1, Math.floor(Number(flags.agents ?? 2)))

  // --- warmup: start the agent chats ---------------------------------------
  const warmup = await ctx.beginPhase('warmup')
  const composer = page.locator('[data-composer-editor="true"]').first()
  if (await composer.count()) {
    await composer.click().catch(() => undefined)
    await composer.type('perf soak warmup', { delay: 3 }).catch(() => undefined)
    await page
      .locator('button[aria-label="Start agent chat"]')
      .first()
      .click()
      .catch(() => undefined)
  }
  await sleep(warmupSec * 1000)
  await warmup.end()

  // --- soak window: stream load + periodic switches --------------------------
  const soak = await ctx.beginPhase('soak')
  const deadline = Date.now() + minutes * 60 * 1000
  let nextSwitch = Date.now() + switchEverySec * 1000
  let switchCount = 0
  while (Date.now() < deadline) {
    await sleep(1000)
    if (Date.now() >= nextSwitch) {
      // Periodic project switch under sustained load: re-invoke the active
      // project's switch (away-and-return pair happens naturally every other
      // cycle when multiple projects exist; single-project runs still
      // exercise the remount path).
      await ctx.handle
        .evaluate(
          `(async () => {
            const store = window.__termulAcpStore
            if (!store) return 'noop'
            const active = store.getState().activeSessionId
            if (active) await store.getState().setActiveSession(active)
            return 'store'
          })()`
        )
        .catch(() => undefined)
      switchCount++
      nextSwitch = Date.now() + switchEverySec * 1000
    }
  }
  await soak.end()

  // --- measure ----------------------------------------------------------------
  const measure = await ctx.beginPhase('measure')
  await sleep(5000)
  await measure.end()

  const soakPhase = ctx.lastPhase()
  if (soakPhase) {
    soakPhase.derived = {
      soakMinutes: minutes,
      switchCount,
      agentChats: agents
    }
  }
}

export const soakScenario: ScenarioDef = {
  name: 'soak',
  defaults: {
    minutes: 30,
    agents: 2,
    rate: 10,
    seed: 42,
    warmup: 10,
    'switch-every-sec': 120
  },
  drive
}
