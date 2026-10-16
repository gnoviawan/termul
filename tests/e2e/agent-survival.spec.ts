import { expect, type Page, test } from 'playwright/test'
import {
  chatCard,
  chatTab,
  launchChat,
  openWorkspace,
  selectColumnTab,
  selectProject,
  visibleChunkCount
} from './ui'

/**
 * Survival E2E: long-running agent chats keep running and stay visible
 * across chat close, tab switching, project switching, and browser reload.
 *
 * The fake agent (fake-longrun-agent.ts) streams a chunk per second for
 * DURATION_SEC — default 300s, i.e. the whole suite can poke a running
 * chat mid-turn without it finishing.
 */

test.setTimeout(180_000)

const PROMPT_A = 'alpha survey of things'
const PROMPT_B = 'beta survey of things'
const PROMPT_C = 'gamma survey of things'

/** How long the closed chat stays detached; the agent streams 1 chunk/s. */
const DETACHED_MS = 10_000
/** Chunks past the pre-close one that must have streamed while detached. */
const DETACHED_CHUNKS = 8
/** Upper bound for the reopen to replay them (< DETACHED_CHUNKS seconds). */
const REPLAY_MS = 5_000

/** Highest `chunk-N` index in the page text, or -1 when none shows. */
async function latestChunkIndex(page: Page): Promise<number> {
  const text = await page.locator('body').innerText()
  let latest = -1
  for (const match of text.matchAll(/\bchunk-(\d+)\b/g)) {
    latest = Math.max(latest, Number(match[1]))
  }
  return latest
}

test.beforeEach(async ({ page }) => {
  await openWorkspace(page)
})

test('closing a chat mid-turn only detaches it: the host keeps the turn and a reopen shows what streamed meanwhile', async ({
  page
}) => {
  await launchChat(page, PROMPT_A)

  // The turn is running: transcript grows, tab shows Working.
  await expect
    .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
    .toContain('chunk-2 ')
  expect(await chatTab(page, PROMPT_A).getAttribute('aria-label')).toContain('Working')

  // Close the chat tab mid-turn. The renderer decides no agent lifetime: the
  // tab goes away at once and the host keeps running the turn. Note the last
  // chunk the tab showed: the fake agent streams one chunk per second.
  const lastChunkBeforeClose = await latestChunkIndex(page)
  await chatTab(page, PROMPT_A).hover()
  await page.locator('[aria-label="Close tab"]').first().click()
  await expect(chatTab(page, PROMPT_A)).toBeHidden()

  // Let the host stream for DETACHED_MS while no tab shows the chat, then
  // reopen it from the project's history index (the session is still recorded
  // server-side). Use the Side panel's Chats card — body-first matching could
  // hit the tab bar's title span instead of the history card.
  await page.waitForTimeout(DETACHED_MS)
  await selectColumnTab(page, 'Chats')
  await chatCard(page, PROMPT_A).click()
  await expect(chatTab(page, PROMPT_A)).toBeVisible()

  // The reopened transcript shows chunks that streamed while the chat was
  // closed (durable history replay, not a blank chat). The target chunk is
  // DETACHED_CHUNKS past the last one seen before the close, and it must show
  // within REPLAY_MS of the reopen. A stream that stopped at the close and
  // resumed on the reopen needs DETACHED_CHUNKS seconds (> REPLAY_MS) to
  // reach it, so only streaming during the detached window passes.
  await expect
    .poll(async () => page.locator('body').innerText(), { timeout: REPLAY_MS })
    .toContain(`chunk-${lastChunkBeforeClose + DETACHED_CHUNKS} `)
  await expect(chatTab(page, PROMPT_A)).toHaveAttribute('aria-label', /Working/)
})

test('tab switching mid-run: another chat tab in the pane; switching tabs keeps both runs alive', async ({
  page
}) => {
  // Chat A in the active pane.
  await launchChat(page, PROMPT_A)
  await expect
    .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
    .toContain('chunk-1 ')

  // Open a second chat in the same pane via the launcher (deterministic
  // new-chat path — an open chat's composer would queue instead).
  await launchChat(page, PROMPT_B)

  // Both tabs exist; A is backgrounded but still Working.
  await expect(chatTab(page, PROMPT_A)).toHaveAttribute('aria-label', /Working/)

  // Switch back to A: its transcript is intact and still growing.
  await chatTab(page, PROMPT_A).click()
  await expect
    .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
    .toContain('chunk-1 ')
  const before = await visibleChunkCount(page)

  // Switch to B and back once more — A keeps streaming in the background.
  await chatTab(page, PROMPT_B).click()
  await page.waitForTimeout(2000)
  await chatTab(page, PROMPT_A).click()
  await expect
    .poll(async () => visibleChunkCount(page), { timeout: 30_000 })
    .toBeGreaterThan(before)
})

test('project switching mid-run: another project runs concurrently; both chats survive switches', async ({
  page
}) => {
  // Chat in proj-a.
  await launchChat(page, PROMPT_A)
  await expect
    .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
    .toContain('chunk-1 ')

  // Switch to proj-b, launch a second chat there.
  await selectProject(page, 'proj-b')
  await launchChat(page, PROMPT_B)
  await expect
    .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
    .toContain('chunk-1 ')

  // Switch back to proj-a: its chat + transcript must be there, still growing.
  await selectProject(page, 'proj-a')
  await expect(chatTab(page, PROMPT_A)).toBeVisible()
  await expect
    .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
    .toContain(PROMPT_A)

  // And proj-b's chat still exists in that project (switch back once more).
  await selectProject(page, 'proj-b')
  await expect(chatTab(page, PROMPT_B)).toBeVisible()
})

test('browser reload mid-run: transcript restores and the turn keeps streaming (server-owned resume)', async ({
  page
}) => {
  await launchChat(page, PROMPT_A)
  await expect
    .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
    .toContain('chunk-2 ')
  const before = await visibleChunkCount(page)

  // Full browser reload (F5 semantics) — the renderer loses everything; the
  // server owns the agent. localStorage keeps the token.
  await page.reload()
  await page.locator('[aria-label^="Project: proj-a"]').first().waitFor({ state: 'visible' })

  // Resume bootstrap: session history index loads, the still-running chat
  // reopens (status not closed), and NEW chunks arrive past `before`.
  await expect
    .poll(async () => visibleChunkCount(page), { timeout: 60_000 })
    .toBeGreaterThan(before)

  // The transcript must include the pre-reload history (durable replay).
  const bodyText = await page.locator('body').innerText()
  expect(bodyText).toContain('chunk-1 ')
})

test('browser context close mid-run: a new browser continues the server-owned turn', async ({
  page,
  context,
  browser
}) => {
  await launchChat(page, PROMPT_C)
  await expect
    .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
    .toContain('chunk-2 ')
  const before = await visibleChunkCount(page)

  // Close the whole context (browser "close"): WS drops, agent is
  // server-owned, turn keeps running server-side.
  await context.close()

  // A fresh browser connects and reattaches: same session, chunks continue.
  const page2 = await browser.newContext().then((ctx) => ctx.newPage())
  await openWorkspace(page2)
  await expect
    .poll(async () => visibleChunkCount(page2), { timeout: 90_000 })
    .toBeGreaterThan(before)
  const bodyText = await page2.locator('body').innerText()
  expect(bodyText).toContain('chunk-1 ')
  await page2.context().close()
})

test('three projects run concurrently with isolated transcripts', async ({ page }) => {
  // Prompts unique to this test: earlier tests leave PROMPT_A/B/C chats in
  // several projects, so only these titles can be asserted absent.
  const ISO_A = 'isolated alpha survey'
  const ISO_B = 'isolated beta survey'
  const ISO_C = 'isolated gamma survey'
  // One chat per project, all running at once. Select proj-a explicitly:
  // the server's active project carries over from earlier tests.
  await selectProject(page, 'proj-a')
  await launchChat(page, ISO_A)
  await selectProject(page, 'proj-b')
  await launchChat(page, ISO_B)
  await selectProject(page, 'proj-c')
  await launchChat(page, ISO_C)

  // All three are streaming server-side; verify by rotating through the
  // projects and seeing each project's transcript grow on return.
  for (const project of ['proj-a', 'proj-b', 'proj-c'] as const) {
    await selectProject(page, project)
    await expect
      .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
      .toContain('chunk-1 ')
  }

  // Back on proj-a: its own chat must be present with a live turn —
  // the ACTIVE conversation belongs to this project (its transcript keeps
  // growing on return, which the rotation loop above already pinned; this
  // adds the tab-level presence check).
  await selectProject(page, 'proj-a')
  await expect(chatTab(page, ISO_A)).toBeVisible()

  // No foreign chat tabs in the visible pane tree. Each visited project keeps
  // its own pane tree mounted but hidden, so count only visible tabs: a leaked
  // tab would render another project's chat in the active project.
  const tabsTitled = (title: string) =>
    page.locator(`[draggable="true"][aria-label^="${title}"]`).filter({ visible: true })
  await expect(tabsTitled(ISO_B)).toHaveCount(0)
  await selectProject(page, 'proj-b')
  await expect(chatTab(page, ISO_B)).toBeVisible()
  await expect(tabsTitled(ISO_A)).toHaveCount(0)
  await expect(tabsTitled(ISO_C)).toHaveCount(0)
  await selectProject(page, 'proj-c')
  await expect(chatTab(page, ISO_C)).toBeVisible()
  await expect(tabsTitled(ISO_A)).toHaveCount(0)
  await expect(tabsTitled(ISO_B)).toHaveCount(0)
})
