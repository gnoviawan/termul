import { expect, type Page, test } from 'playwright/test'
import { armNextAgentCrash } from './helpers'
import { chatTab, launchChat, openWorkspace, selectProject } from './ui'

/**
 * Crash-recovery E2E: a chat whose agent dies mid-turn must not leave a
 * forever-running "Working…" indicator, and its tab must stay closable —
 * immediately, after reopening from history, and after a browser reload.
 *
 * A prompt containing the `[CRASH]` marker makes the fake agent
 * (fake-longrun-agent.ts) exit(1) ~0.4s after accepting `session/prompt` —
 * before the first chunk tick — so the persisted transcript ends on the
 * user bubble, exactly what a real mid-turn crash leaves behind.
 * `[DURATION:n]` bounds the fake's turn length: the host re-sends the
 * persisted open turn to the replacement agent on reopen (resume), and a
 * bounded resumed turn lets the tab close promptly instead of parking in
 * Closing for the default 300s.
 *
 * All chats live in proj-x: chats in the same project share one agent
 * process, so crash prompts must never reuse an agent another suite's
 * in-flight chat depends on.
 */

test.setTimeout(180_000)

const CRASH_A = 'kilo survey [CRASH]'
const CRASH_B = 'lima survey [CRASH] [DURATION:6]'
const CRASH_C = 'mike survey [CRASH] [DURATION:6]'

test.beforeEach(async ({ page }) => {
  await openWorkspace(page)
  await selectProject(page, 'proj-x')
})

/**
 * The workspace pane (`data-pane-content`) that owns this test's chat tab.
 * Every pane keeps all its tab panels mounted (inactive ones hidden), and
 * split layouts can show another pane's crashed chat at the same time — so
 * every panel-level assertion (banner, composer, Working…) must scope to
 * the pane whose tab strip contains the chat under test, or a foreign
 * panel's elements satisfy the locator.
 */
function chatPane(page: Page, titlePrefix: string) {
  return page.locator('[data-pane-content]').filter({ has: chatTab(page, titlePrefix) })
}

/** The transcript's live-turn indicator (TurnActivity's active label) in this chat's pane. */
function workingIndicator(page: Page, titlePrefix: string) {
  return chatPane(page, titlePrefix).getByText('Working…', { exact: true })
}

/**
 * Wait until THIS test's agent crash has fully propagated to the chat UI.
 * The host's teardown race decides which surface wins: `agent_crashed`
 * leaves status 'error' + the dismissible error banner, while a
 * session_closed/disconnect first leaves status 'closed' + the "This chat
 * stopped." resume affordance (and a Needs-you tab marker). Both are
 * correct crash outcomes — the contract under test is that the dead turn
 * clears and the tab settles, so accept either surface.
 *
 * Attached-not-visible: another pane's tab can hold activation after a
 * restore, which keeps this chat's panel mounted but hidden — the crash
 * surface still renders, it just isn't in the visible pane slot.
 */
async function waitForCrash(page: Page, titlePrefix: string): Promise<void> {
  const pane = chatPane(page, titlePrefix)
  const surfaced = pane
    .locator('[aria-label="Dismiss error"]')
    .or(pane.getByText('This chat stopped.'))
  await expect(surfaced.first()).toBeAttached({ timeout: 30_000 })
  await expect(workingIndicator(page, titlePrefix)).toBeHidden({ timeout: 30_000 })
}

/** Close the chat's tab and assert it is actually removed (never stuck "Closing"). */
async function closeChatTab(page: Page, titlePrefix: string): Promise<void> {
  // Middle-click closes the tab — the exact "can't close the tab" path from
  // the report, and immune to close-button hit-testing under tab overlap.
  await chatTab(page, titlePrefix).click({ button: 'middle' })
  await expect(chatTab(page, titlePrefix)).toBeHidden({ timeout: 15_000 })
}

test('agent dies mid-turn: the running indicator clears, an error surfaces, and the tab still closes', async ({
  page
}) => {
  armNextAgentCrash()
  await launchChat(page, CRASH_A)
  await expect(chatTab(page, 'kilo survey')).toBeVisible()

  await waitForCrash(page, 'kilo survey')
  await expect(chatTab(page, 'kilo survey')).not.toHaveAttribute('aria-label', /Working|Closing/)

  await closeChatTab(page, 'kilo survey')
})

test('reopening a crashed chat from history does not resurrect the dead turn', async ({ page }) => {
  armNextAgentCrash()
  await launchChat(page, CRASH_B)
  await waitForCrash(page, 'lima survey')
  await closeChatTab(page, 'lima survey')

  // Reopen from the project's history index. The sidebar lists every seeded
  // project, so scope the expand/entry lookups to proj-x.
  const projXEntry = page
    .locator('li')
    .filter({ has: page.getByRole('button', { name: /^Project: proj-x/ }) })
  await projXEntry.getByRole('button', { name: 'Expand chats' }).click()
  await page.getByRole('complementary').getByText('lima survey').first().click()
  await expect(chatTab(page, 'lima survey')).toBeVisible()

  // Transcript restored on a fresh agent: Working… may legitimately appear
  // during the restore window, but it must END — the dead turn must never
  // re-arm the live-turn flags (pre-fix it spun forever), and the tab must
  // settle out of Working/Closing.
  await expect(page.locator('body')).toContainText('lima survey')
  await expect(workingIndicator(page, 'lima survey')).toBeHidden({ timeout: 30_000 })
  await expect(chatTab(page, 'lima survey')).not.toHaveAttribute('aria-label', /Working|Closing/)

  // The reopened chat is still usable: a fresh agent owns it, so a new
  // prompt runs a real turn. The open chat's composer lacks the launcher's
  // "Agent prompt" aria-label; the lookup is pane-scoped so a second
  // visible pane's mounted chat can never be typed into.
  const doneMarkers = chatPane(page, 'lima survey')
    .locator('div[role="log"]:visible')
    .getByText('DONE after')
  const doneBaseline = await doneMarkers.count()
  const composer = chatPane(page, 'lima survey').locator(
    '[data-composer-editor="true"]:visible:not([aria-label="Agent prompt"])'
  )
  await composer.click()
  await composer.pressSequentially('still here? [DURATION:2]')
  await page.keyboard.press('Enter')
  // Proof the send dispatched a real turn on the fresh agent: the fake ends
  // every turn with a "[DONE after …]" chunk. The dead turn is NEVER
  // re-executed on reopen (the host replays the transcript, it does not
  // re-prompt), so the new send's marker is the +1 over the replayed
  // baseline — counting the delta rather than an absolute keeps the wait
  // honest if a restored transcript ever carries its own marker.
  await expect(doneMarkers).toHaveCount(doneBaseline + 1, { timeout: 30_000 })
  await expect(workingIndicator(page, 'lima survey')).toBeHidden({ timeout: 30_000 })

  await closeChatTab(page, 'lima survey')
})

test('browser reload with a crashed chat open: the restored chat is not stuck loading and closes', async ({
  page
}) => {
  armNextAgentCrash()
  await launchChat(page, CRASH_C)
  await waitForCrash(page, 'mike survey')

  // Full reload: the renderer loses all state; the workspace tab restores
  // and the bootstrap reopens the session from persisted history.
  await page.reload()
  await page.locator('[aria-label^="Project: proj-x"]').first().waitFor({ state: 'visible' })
  await expect(chatTab(page, 'mike survey')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('body')).toContainText('mike survey')

  // Same contract as the history reopen: the resumed turn may briefly show
  // Working… but must end — never the pre-fix forever-spinner.
  await expect(workingIndicator(page, 'mike survey')).toBeHidden({ timeout: 30_000 })
  await expect(chatTab(page, 'mike survey')).not.toHaveAttribute('aria-label', /Working|Closing/)

  await closeChatTab(page, 'mike survey')
})
