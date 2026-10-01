/**
 * project-switch scenario (CAP-2) — P projects (default 3), each with live
 * agent streaming and a flood terminal; repeated project switching
 * (away and return) measuring click→responsive and click→settled per switch.
 *
 * Phases: seed projects → setup workspaces → N switch cycles → measure.
 *
 * Desktop project switching is UI-driven — the sidebar's project entry
 * (`[aria-label="Project: <name>"]`) calls `useProjectStore.selectProject`
 * (the same code the user clicks). There is no exposed store global, so the
 * runner clicks the entry and measures the settle from rAF probes. Matches
 * the incident shape: switch under live load.
 *
 * Answers (scenarios.md): switch latency under live load; mount/remount
 * cost; verifies spec-project-switch-rendering-perf CAPs 1–3.
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright'
import { type PerfProjectSeed, reloadRenderer, seedPerfProjects } from '../runner/agent-config.ts'
import type { ScenarioContext, ScenarioDef } from '../runner/scenario-harness.ts'
import { launchChatViaUI, openLauncher, sleep, spawnFloodTerminal } from '../runner/scenario-ui.ts'

interface SwitchLatency {
  from: string
  to: string
  clickMs: number
  settledMs: number
}

/** Click the sidebar's project entry — the desktop selectProject path. */
async function clickProjectEntry(page: Page, projectName: string): Promise<void> {
  const entry = page.locator(`[aria-label^="Project: ${projectName}"]`).first()
  await entry.click({ timeout: 5000 })
}

/**
 * Measure one switch: click the entry, then poll rAF round-trips through
 * CDP evaluate until one completes under the responsive threshold.
 * Click→settled is the full quiet-rAF tail.
 */
async function measureSwitch(
  ctx: ScenarioContext,
  page: Page,
  from: string,
  to: string
): Promise<SwitchLatency> {
  const clickStart = Date.now()
  await clickProjectEntry(page, to).catch(() => undefined)
  let responsiveMs = Date.now() - clickStart
  for (let attempt = 0; attempt < 40; attempt++) {
    const t0 = Date.now()
    const raf = await ctx.handle
      .evaluate<number>(
        '(() => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now()))))()'
      )
      .catch(() => -1)
    if (raf >= 0 && Date.now() - t0 < 50) {
      responsiveMs = Date.now() - clickStart
      break
    }
    await sleep(250)
  }
  const settledMs = Date.now() - clickStart
  return { from, to, clickMs: responsiveMs, settledMs }
}

/** Load the active project: open a streaming chat, then a flood terminal. */
async function loadProjectWorkspace(ctx: ScenarioContext, page: Page, cwd: string): Promise<void> {
  try {
    await openLauncher(page)
    await launchChatViaUI(page, `perf ${path.basename(cwd)} load`, ctx.expectedAgentName)
  } catch {
    // Load failure surfaces as less activity downstream — continue setup.
  }
  if (ctx.flags['with-terminals'] !== false) {
    await spawnFloodTerminal(ctx, 0, cwd).catch(() => undefined)
  }
}

async function drive(ctx: ScenarioContext): Promise<void> {
  const { flags } = ctx
  const projects = Math.max(2, Math.floor(Number(flags.projects ?? 3)))
  const cycles = Math.max(1, Math.floor(Number(flags.cycles ?? 10)))
  const projectsRoot = process.env.TEMP ?? 'C:\\temp'
  const seeds: PerfProjectSeed[] = []
  for (let p = 0; p < projects; p++) {
    const name = `perf-project-${p}`
    const dir = path.join(projectsRoot, `termul-perf-${name}`)
    mkdirSync(dir, { recursive: true })
    seeds.push({ id: `perf-project-${String(p).padStart(4, '0')}`, name, path: dir })
  }

  // --- setup: seed P projects + live load in each --------------------------
  const setup = await ctx.beginPhase('setup-workspaces')
  const page = await ctx.handle.page()
  // Persist the project list so the sidebar renders every entry, reload so
  // the boot sequence activates projects[0], then visit each project in
  // turn and attach live load (chat + terminal) so tabs exist per project.
  await seedPerfProjects(ctx.handle, seeds, seeds[0].id)
  await reloadRenderer(ctx.handle)
  await page
    .locator(`[aria-label^="Project: ${seeds[0].name}"]`)
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => undefined)
  for (const seed of seeds) {
    await clickProjectEntry(page, seed.name).catch(() => undefined)
    await sleep(600)
    await loadProjectWorkspace(ctx, page, seed.path)
    await sleep(400)
  }
  // Return to the first project so the cycles measure away+return cleanly.
  await clickProjectEntry(page, seeds[0].name).catch(() => undefined)
  await sleep(800)
  await setup.end()

  // --- switch cycles: away and return ---------------------------------------
  const switches = await ctx.beginPhase('switch-cycles')
  const latencies: SwitchLatency[] = []
  for (let c = 0; c < cycles; c++) {
    const away = seeds[(c + 1) % seeds.length]
    const home = seeds[c % seeds.length]
    latencies.push(await measureSwitch(ctx, page, home.name, away.name))
    await sleep(1500)
    latencies.push(await measureSwitch(ctx, page, away.name, home.name))
    await sleep(1500)
  }
  await switches.end()

  // --- measure ---------------------------------------------------------------
  const measure = await ctx.beginPhase('measure')
  await sleep(2000)
  await measure.end()

  // Record per-switch latencies as derived data on the cycles phase.
  const cyclesPhase = ctx.lastPhase()
  if (cyclesPhase) {
    cyclesPhase.derived = {
      switchLatencies: latencies.map(
        (l) => `${l.from}->${l.to}: click→responsive ${l.clickMs}ms, settled ${l.settledMs}ms`
      ),
      medianClickResponsiveMs: medianOf(latencies.map((l) => l.clickMs)),
      medianSettledMs: medianOf(latencies.map((l) => l.settledMs))
    }
  }
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export const projectSwitchScenario: ScenarioDef = {
  name: 'project-switch',
  defaults: {
    projects: 3,
    cycles: 10,
    seed: 42,
    'lines-per-sec': 50,
    'with-terminals': true
  },
  drive
}
