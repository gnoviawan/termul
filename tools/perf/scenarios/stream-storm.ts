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
import { launchChatViaUI, openLauncher, sleep, waitForLauncher } from '../runner/scenario-ui.ts'

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
  const workReal = flags.work === 'real'

  // Long-running prompts for `--work real`: substantive generation tasks a
  // user would actually give an agent (essays, code, design docs). Each
  // keeps a real model streaming for tens of seconds instead of the 3-word
  // quick prompts used for the deterministic fake lane.
  const REAL_PROMPTS = [
    'Write a detailed 800-word essay comparing event sourcing with CRUD for order systems.',
    'Write a TypeScript implementation of a rate limiter with token bucket, sliding window, and leaky bucket, with comments.',
    'Draft a design document for a terminal session persistence feature: requirements, data model, failure cases.',
    'Explain step by step how a Tauri app spawns and pipes a PTY on Windows, including ConPTY.',
    'Write a comprehensive test plan for a chat streaming UI: happy paths, reconnects, ordering, backpressure.',
    'Write a long tutorial on React reconciliation: fibers, commit phases, and why keys matter for lists.',
    'Produce a detailed comparison table and analysis of ACP vs LSP vs MCP protocols for AI coding agents.',
    'Write 1000 words on WebView2 memory management: process model, GC pressure, suspended tabs.'
  ]
  const FOLLOW_UPS = [
    'Continue — add concrete edge cases and failure modes.',
    'Go deeper: quantify the performance impact with rough numbers.',
    'Now write a second part covering operational tradeoffs and migration concerns.'
  ]

  /** Send a follow-up turn into the currently visible chat's composer.
   * Bounded at 5s: a composer that won't accept input under load is a
   * finding (a blocked send once cost the whole run at 30s). */
  const sendFollowUp = async (text: string): Promise<void> => {
    const chatComposer = page
      .locator('[data-chat-tab-state="visible"] [data-composer-editor="true"]')
      .first()
    if (!(await chatComposer.isVisible().catch(() => false))) return
    await chatComposer.click({ timeout: 3000 }).catch(() => undefined)
    await chatComposer
      .pressSequentially(text, { delay: 3, timeout: 5000 })
      .catch(() => undefined)
    await chatComposer.press('Enter', { timeout: 3000 }).catch(() => undefined)
  }

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
  await launchChatViaUI(
    page,
    workReal ? REAL_PROMPTS[0] : 'perf warmup turn',
    ctx.expectedAgentName
  )
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
      await launchChatViaUI(
        page,
        workReal ? REAL_PROMPTS[(i + 1) % REAL_PROMPTS.length] : `perf stream ${i}`,
        ctx.expectedAgentName
      )
    } catch {
      // A failed launch shows up as a smaller session count downstream;
      // keep the storm going rather than aborting the whole phase.
    }
    await sleep(500)
  }
  // Cycle visibility across chat tabs mid-stream (the multi-chat incident
  // shape: switching sessions under live load). In --work real mode, every
  // second cycle also sends a follow-up turn into the visible chat's
  // composer — keeps finished streams alive and exercises the composer
  // under load, the real-world shape of "8 agents running long work".
  const deadline = Date.now() + sustainedSec * 1000
  let nextSwitch = Date.now() + cycleMs
  let cursor = 0
  let followUpIdx = 0
  while (Date.now() < deadline) {
    await sleep(250)
    if (Date.now() >= nextSwitch) {
      await switchToChatTab(page, cursor++)
      nextSwitch = Date.now() + cycleMs
      if (workReal && cursor % 2 === 0) {
        await sendFollowUp(FOLLOW_UPS[followUpIdx++ % FOLLOW_UPS.length])
      }
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
