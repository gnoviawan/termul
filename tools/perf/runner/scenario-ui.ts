/**
 * Shared UI-driving helpers for desktop scenarios: launcher reopen, chat
 * launch through the composer, and flood-terminal spawn. Kept out of the
 * individual scenario files so stream-storm, project-switch, and pty-flood
 * all drive the same launcher/chat/terminal surfaces identically.
 *
 * Selector contract: the launcher's composer and a chat panel's composer
 * share `[data-composer-editor]` — everything launcher-facing is scoped
 * under `[data-agent-launcher-composer-group]` so locators can't resolve
 * to a hidden chat composer once sessions exist.
 */

import path from 'node:path'
import type { Page } from 'playwright'
import { REPO_ROOT } from './launch.ts'
import type { ScenarioContext } from './scenario-harness.ts'

export const START_CHAT_SELECTOR = 'button[aria-label="Start agent chat"]'
export const NEW_CHAT_SELECTOR = 'button[aria-label="New agent chat"]'
export const LAUNCHER_COMPOSER =
  '[data-agent-launcher-composer-group="true"] [data-composer-editor="true"]'
export const CHAT_TAB_MARKER = '[data-chat-tab-state]'

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Wait for the launcher on an empty workspace (fresh scratch profile = no
 * tabs → the launcher is the default surface after project seeding).
 */
export async function waitForLauncher(page: Page): Promise<void> {
  await page.locator(LAUNCHER_COMPOSER).first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator(START_CHAT_SELECTOR).first().waitFor({ state: 'visible', timeout: 10_000 })
}

/**
 * Re-open the launcher on a workspace that already holds chats: click the
 * pane toolbar's "New agent chat" button, then wait for the launcher
 * composer. Without this, a bare composer locator resolves to a hidden
 * chat-panel composer and every click burns the 30s actionability
 * timeout.
 */
export async function openLauncher(page: Page): Promise<void> {
  const composer = page.locator(LAUNCHER_COMPOSER).first()
  if (await composer.isVisible().catch(() => false)) return
  await page.locator(NEW_CHAT_SELECTOR).first().click({ timeout: 5000 })
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator(START_CHAT_SELECTOR).first().waitFor({ state: 'visible', timeout: 10_000 })
}

export const AGENT_PICKER_TRIGGER = 'button[aria-label^="Select ACP agent:"]'

/**
 * Ensure the launcher's agent pill names `expectedName` before we send a
 * prompt. The pill's aria-label is "Select ACP agent: <label>". On a
 * mismatch we open the picker and click the entry whose label matches —
 * same clicks a user makes. A hard throw beats silently running codex:
 * its every attempt errors, which both wastes the run and hides the bug.
 */
async function ensureAgentSelected(page: Page, expectedName: string): Promise<void> {
  const trigger = page.locator(AGENT_PICKER_TRIGGER).first()
  const label = (await trigger.getAttribute('aria-label').catch(() => null)) ?? ''
  const want = expectedName.trim().toLowerCase()
  if (label.toLowerCase().includes(want)) return
  await trigger.click({ timeout: 5000 })
  const option = page
    .locator(`button[aria-pressed]`)
    .filter({ hasText: new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
    .first()
  await option.click({ timeout: 5000 })
  const after = (await trigger.getAttribute('aria-label').catch(() => null)) ?? ''
  if (!after.toLowerCase().includes(want)) {
    throw new Error(
      `launcher agent is "${after.replace('Select ACP agent: ', '')}", expected "${expectedName}"`
    )
  }
}

/**
 * Start one chat via the launcher UI: type a prompt, click start. When
 * `expectedAgent` is set the launcher's agent pill is checked (and
 * corrected via the picker) BEFORE the prompt goes out — the same
 * "which agent did the launcher pick" check the user does visually.
 */
export async function launchChatViaUI(
  page: Page,
  prompt: string,
  expectedAgent?: string
): Promise<void> {
  const composer = page.locator(LAUNCHER_COMPOSER).first()
  if (expectedAgent) {
    await ensureAgentSelected(page, expectedAgent)
  }
  await composer.click({ timeout: 5000 })
  await composer.pressSequentially(prompt, { delay: 5 })
  await page.locator(START_CHAT_SELECTOR).first().click({ timeout: 5000 })
  // The launcher morphs away once the chat tab opens — wait for the chat
  // surface (the panel's transcript container).
  await page
    .locator('[data-chat-tab-state="visible"], [data-chat-tab-state="hidden"]')
    .first()
    .waitFor({ state: 'attached', timeout: 45_000 })
    .catch(() => undefined)
}

export interface SpawnedTerminal {
  id: string
}

/**
 * Spawn one flood terminal through the app's `terminal_spawn` IPC. The
 * command requires an `onData` Tauri Channel — serialised as the string
 * `"__CHANNEL__:<callbackId>"` where the id is registered via
 * `__TAURI_INTERNALS__.transformCallback`. We install a no-op consumer:
 * the PTY keeps writing (backend + IPC flood is the load) but we drop the
 * bytes rather than buffer MBs of flood output in the webview.
 *
 * Runs entirely inside `handle.evaluate` so the channel callback is
 * registered against the live page's `__TAURI_INTERNALS__`.
 */
export async function spawnFloodTerminal(
  ctx: ScenarioContext,
  index: number,
  cwd?: string
): Promise<SpawnedTerminal> {
  const floodScript = path.join(REPO_ROOT, 'tools', 'perf', 'fake-agent', 'flood.ts')
  const linesPerSec = Number(ctx.flags['lines-per-sec'] ?? 200)
  const resizeEvery = Number(ctx.flags['resize-every'] ?? 200)
  const duration = Number(ctx.flags.duration ?? 0)
  const result = await ctx.handle.evaluate<string>(
    `(async () => {
      const internals = window.__TAURI_INTERNALS__
      if (!internals) throw new Error('no __TAURI_INTERNALS__')
      const onDataId = internals.transformCallback(() => {})
      const res = await internals.invoke('terminal_spawn', {
        options: {
          program: 'bun',
          args: ${JSON.stringify([floodScript])},
          env: {
            PERF_FLOOD_LINES_PER_SEC: ${JSON.stringify(String(linesPerSec))},
            PERF_FLOOD_RESIZE_EVERY: ${JSON.stringify(String(resizeEvery))},
            PERF_FLOOD_DURATION: ${JSON.stringify(String(duration))},
            PERF_FLOOD_SEED: ${JSON.stringify(String(ctx.seed + index))}
          },
          cwd: ${JSON.stringify(cwd ?? null)},
          cols: 120,
          rows: 30,
          kind: 'shell'
        },
        onData: '__CHANNEL__:' + onDataId
      })
      return res && res.success && res.data ? 'ok:' + res.data.id : 'err:' + JSON.stringify(res)
    })()`
  )
  if (!result.startsWith('ok:')) {
    throw new Error(`terminal_spawn failed: ${result}`)
  }
  return { id: result.slice(3) }
}
