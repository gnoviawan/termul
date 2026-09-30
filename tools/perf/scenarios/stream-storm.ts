/**
 * stream-storm scenario (CAP-2) — K concurrent fake ACP agents streaming
 * `sessionUpdate` at ~rate/s each, S sessions (default K×2).
 *
 * Phases: warmup → sustained stream → measure.
 *
 * The app is driven through its REAL UI: the empty-pane AgentLauncher's
 * composer (a tiptap `[data-composer-editor="true"]` textbox) + the
 * `aria-label="Start agent chat"` button — the same surface a user uses.
 * That exercises the full launcher → startChat → spawn → session/new →
 * sendPrompt pipeline with the fake agent, exactly like manual use.
 *
 * Mid-stream session switching happens through the workspace tab bar
 * (chat tabs render with a `data-chat-tab-state` marker; the runner clicks
 * chat-tab buttons to change the visible session).
 *
 * Answers (scenarios.md): does concurrent streaming produce commit churn,
 * long frames, heap slope? Reproduces the multi-agent slowness as numbers.
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright'
import { reloadRenderer, seedPerfProject } from '../runner/agent-config.ts'
import type { ScenarioContext, ScenarioDef } from '../runner/scenario-harness.ts'

const START_CHAT_SELECTOR = 'button[aria-label="Start agent chat"]'
const NEW_CHAT_SELECTOR = 'button[aria-label="New agent chat"]'
// The launcher's composer vs the chat panel's composer share
// [data-composer-editor] — scope to the launcher group so locators can't
// resolve to a hidden chat composer once sessions exist.
const LAUNCHER_COMPOSER =
  '[data-agent-launcher-composer-group="true"] [data-composer-editor="true"]'

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * The launcher mounts when a pane is empty (fresh scratch profile = no
 * tabs) — wait for the composer and the start button to appear.
 */
async function waitForLauncher(page: Page): Promise<void> {
  await page.locator(LAUNCHER_COMPOSER).first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator(START_CHAT_SELECTOR).first().waitFor({ state: 'visible', timeout: 10_000 })
}

/**
 * Re-open the launcher on a workspace that already holds chats: click the
 * pane toolbar's "New agent chat" button, then wait for the launcher
 * composer. Without this, a bare composer locator resolves to a hidden
 * chat-panel composer and every click burns the 30s actionability
 * timeout — the sustained phase overruns ~7× and only one chat ever
 * starts.
 */
async function openLauncher(page: Page): Promise<void> {
  const composer = page.locator(LAUNCHER_COMPOSER).first()
  if (await composer.isVisible().catch(() => false)) return
  await page.locator(NEW_CHAT_SELECTOR).first().click({ timeout: 5000 })
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator(START_CHAT_SELECTOR).first().waitFor({ state: 'visible', timeout: 10_000 })
}

/**
 * Start one chat via the launcher UI: type a prompt, click start. Returns
 * nothing; the workspace opens the chat tab and the agent streams.
 */
async function launchChatViaUI(page: Page, prompt: string): Promise<void> {
  const composer = page.locator(LAUNCHER_COMPOSER).first()
  await composer.click({ timeout: 5000 })
  await composer.type(prompt, { delay: 5 })
  await page.locator(START_CHAT_SELECTOR).first().click({ timeout: 5000 })
  // The launcher morphs away once the chat tab opens — wait for the chat
  // surface (the panel's transcript container).
  await page
    .locator('[data-chat-tab-state="visible"], [data-chat-tab-state="hidden"]')
    .first()
    .waitFor({ state: 'attached', timeout: 45_000 })
    .catch(() => undefined)
}

/**
 * Switch the visible chat by clicking its tab-bar entry. Chat tabs render
 * as a labeled div (WorkspaceTabBar) whose click handler selects the tab;
 * the wrapper element in the pane carries `data-chat-tab-state`.
 */
async function switchToChatTab(page: Page, index: number): Promise<void> {
  const wrappers = page.locator('[data-chat-tab-state]')
  const count = await wrappers.count()
  if (count === 0) return
  const target = wrappers.nth(index % count)
  const visible = await target.getAttribute('data-chat-tab-state')
  if (visible === 'visible') return
  // The tab-bar entry is the labeled clickable div above the wrapper.
  const tabEntry = target.locator('xpath=ancestor::div[@aria-label][1]')
  const entryCount = await tabEntry.count()
  if (entryCount > 0) {
    await tabEntry
      .first()
      .click({ timeout: 5000 })
      .catch(() => undefined)
  }
}

async function drive(ctx: ScenarioContext): Promise<void> {
  const { handle, flags } = ctx
  const page = await handle.page()
  const agents = Math.max(1, Math.floor(Number(flags.agents ?? 4)))
  const sessionsPerAgent = Math.max(1, Math.floor(Number(flags['sessions-per-agent'] ?? 2)))
  const totalSessions = agents * sessionsPerAgent
  const warmupSec = Math.max(0, Number(flags.warmup ?? 10))
  const sustainedSec = Math.max(1, Number(flags.sustain ?? 30))
  const measureSec = Math.max(1, Number(flags.measure ?? 20))
  const cycleMs = Math.max(1000, Number(flags['switch-every-ms'] ?? 5000))

  // --- setup: seed a project + wait for the launcher -----------------------
  // Fresh scratch profiles start with zero projects; the launcher mounts
  // only once a project is selected, so seed one first and reload so the
  // boot sequence activates it.
  const seed = await ctx.beginPhase('seed-project')
  const projectDir = path.join(process.env.TEMP ?? 'C:\\temp', 'termul-perf-project')
  mkdirSync(projectDir, { recursive: true })
  await seedPerfProject(handle, projectDir)
  await reloadRenderer(handle)
  await seed.end()

  // The launcher's composer mounts only on an empty pane with a selected
  // project — wait for it to become visible (fresh scratch profile = no
  // tabs, so the launcher is the default surface after reload).
  await waitForLauncher(page)

  // --- warmup phase --------------------------------------------------------
  const warmup = await ctx.beginPhase('warmup')
  // First chat: spawns the agent process and warms the pipeline (JIT, store
  // subscriptions, virtualizer sizing). One chat, short stream.
  await launchChatViaUI(page, 'perf warmup turn')
  await sleep(warmupSec * 1000)
  await warmup.end()

  // --- sustained stream phase ----------------------------------------------
  const sustained = await ctx.beginPhase('sustained-stream')
  // More chats: each start is a sendPrompt into the fake agent. Because
  // duration rides on the AGENT ENV (PERF_AGENT_DURATION), the streams keep
  // flowing for the scenario window; when duration=0 they run until
  // cancelled at teardown.
  for (let i = 0; i < totalSessions - 1; i++) {
    // Each subsequent chat re-opens the launcher via the pane toolbar's
    // "New agent chat" — the first launcher's surface morphs into the chat
    // composer once a session exists, so the launcher must be brought back
    // before typing the next prompt.
    try {
      await openLauncher(page)
      await launchChatViaUI(page, `perf stream ${i}`)
    } catch {
      // A failed launch shows up as a smaller session count downstream;
      // keep the storm going rather than aborting the whole phase.
    }
    await sleep(500)
  }
  // Cycle visibility across chat tabs mid-stream (the multi-chat incident
  // shape: switching sessions under live load).
  const deadline = Date.now() + sustainedSec * 1000
  let nextSwitch = Date.now() + cycleMs
  let cursor = 0
  while (Date.now() < deadline) {
    await sleep(250)
    if (Date.now() >= nextSwitch) {
      await switchToChatTab(page, cursor++)
      nextSwitch = Date.now() + cycleMs
    }
  }
  await sustained.end()

  // --- measure phase --------------------------------------------------------
  const measure = await ctx.beginPhase('measure')
  // Keep the storm flowing through the measured window.
  await sleep(measureSec * 1000)
  await measure.end()
}

export const streamStormScenario: ScenarioDef = {
  name: 'stream-storm',
  defaults: {
    agents: 4,
    'sessions-per-agent': 2,
    rate: 20,
    seed: 42,
    warmup: 10,
    sustain: 30,
    measure: 20,
    'switch-every-ms': 5000
  },
  drive
}
