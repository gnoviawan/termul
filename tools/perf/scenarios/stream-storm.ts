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

import type { Page } from 'playwright'
import type { ScenarioContext, ScenarioDef } from '../runner/scenario-harness'

const START_CHAT_SELECTOR = 'button[aria-label="Start agent chat"]'
const COMPOSER_SELECTOR = '[data-composer-editor="true"]'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The launcher mounts when a pane is empty (fresh scratch profile = no
 * tabs) — wait for the composer and the start button to appear.
 */
async function waitForLauncher(page: Page): Promise<void> {
  await page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator(START_CHAT_SELECTOR).first().waitFor({ state: 'visible', timeout: 10_000 })
}

/**
 * Start one chat via the launcher UI: type a prompt, click start. Returns
 * nothing; the workspace opens the chat tab and the fake agent streams.
 */
async function launchChatViaUI(page: Page, prompt: string): Promise<void> {
  const composer = page.locator(COMPOSER_SELECTOR).first()
  await composer.click()
  await composer.type(prompt, { delay: 5 })
  await page.locator(START_CHAT_SELECTOR).first().click()
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

  // --- setup: launcher must be up on the (empty) workspace ----------------
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
    // The launcher re-appears after a chat opens? No — it morphs into the
    // chat's composer. New chats start from the chat input bar's composer:
    // the same [data-composer-editor] element inside the open chat panel.
    const composer = page.locator(COMPOSER_SELECTOR).first()
    if (await composer.count()) {
      await composer.click().catch(() => undefined)
      await composer.type(`perf stream ${i}`, { delay: 3 }).catch(() => undefined)
      // The chat input bar's send button shares the launcher's aria-label.
      await page
        .locator(START_CHAT_SELECTOR)
        .first()
        .click()
        .catch(() => undefined)
      await sleep(500)
    }
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
