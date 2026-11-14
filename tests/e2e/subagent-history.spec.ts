import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from 'playwright/test'
import { chatTab, launchChat, openWorkspace, railChat, selectProject, showAllRailChats } from './ui'

/**
 * Subagents stay in the chat history. The fake agent's `[SUBAGENTS:4]
 * [BG_TAIL:8]` announces two subagents in the ACP RFD form, ends the turn
 * after 4 s and reports each one idle 8 s later; `[SUBAGENTS:3]` sends two
 * legacy Claude background `Agent` calls. In both, the turn folds when it
 * ends, and the subagent group must stay in the transcript, live, after a
 * reload and after a reopen from the Rail chat rows, with the panel's Activity
 * and text restored from the host.
 *
 * Chats live in proj-c, the least contested seeded project (see
 * elicitation.spec.ts).
 */

test.setTimeout(150_000)

test.beforeEach(async ({ page }) => {
  await openWorkspace(page)
  await selectProject(page, 'proj-c')
})

/**
 * A chat title unique to this run. Chats outlive a test (the server and
 * workspace are shared by the whole suite), so under `--repeat-each` a fixed
 * title would match the previous repeat's still-open tab too: the reopen
 * would close one tab and wait forever for the other to disappear. The
 * fixed-length suffix also keeps one title from prefix-matching another.
 */
function uniqueTitle(base: string): string {
  return `${base} ${randomUUID().slice(0, 8)}`
}

function paneOf(page: Page, title: string) {
  return page.locator('[data-pane-content]').filter({ has: chatTab(page, title) })
}

/** The folded turn shows the group; its first row opens the subagent panel. */
async function expectGroupAndPanel(page: Page, title: string, text: RegExp): Promise<void> {
  const pane = paneOf(page, title)
  await expect(pane.getByRole('button', { name: /^Worked/ })).toBeVisible()
  const header = pane.getByRole('button', { name: /^2 subagents:/ }).filter({ visible: true })
  await expect(header).toHaveCount(1)
  await expect(header).toBeVisible()
  // The group folds once every subagent settles, and its rows stay mounted
  // (clipped, still "visible") while folded. Read the header's expanded state
  // instead, and retry: the fold can land between the read and the click.
  const row = pane.locator('[data-subagent-row]').filter({ visible: true }).first()
  await expect(async () => {
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 })
    await row.click({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  const body = page.locator('[data-subagent-panel-body]')
  await expect(body.getByText(/^Activity · [1-9]/)).toBeVisible()
  await expect(body.getByText('Read chat.ts').first()).toBeVisible()
  await expect(body).toContainText(text)
  await page.getByRole('button', { name: 'Back to chat' }).click()
}

async function reopenFromHistory(page: Page, title: string): Promise<void> {
  await chatTab(page, title).hover()
  await chatTab(page, title).locator('[aria-label="Close tab"]').click()
  await expect(chatTab(page, title)).toBeHidden()
  await showAllRailChats(page)
  await railChat(page, title).click()
  await expect(chatTab(page, title)).toBeVisible()
}

test('RFD subagents stay in the transcript after the turn, a reload and a reopen', async ({
  page
}) => {
  const title = uniqueTitle('history rfd')
  await launchChat(page, `${title} [SUBAGENTS:4] [BG_TAIL:8]`)
  const pane = paneOf(page, title)
  await expect(pane.getByText('I am waiting for them.').filter({ visible: true })).toBeVisible()
  await expect(
    pane.getByRole('button', { name: /^2 subagents:/ }).filter({ visible: true })
  ).toHaveCount(1)
  await expect(pane.getByRole('button', { name: /^Session status: subagents 2 done/ })).toBeVisible(
    {
      timeout: 20_000
    }
  )
  await expectGroupAndPanel(page, title, /Result.*Checked src\//s)

  await page.reload()
  await chatTab(page, title).click()
  await expectGroupAndPanel(page, title, /Result.*Checked src\//s)

  await reopenFromHistory(page, title)
  await expectGroupAndPanel(page, title, /Result.*Checked src\//s)
})

test('legacy Claude background subagents keep their activity across a reload', async ({ page }) => {
  const title = uniqueTitle('history legacy')
  await launchChat(page, `${title} [SUBAGENTS:3]`)
  const pane = paneOf(page, title)
  await expect(pane.getByText('Both reviewers finished.').filter({ visible: true })).toBeVisible()
  await expectGroupAndPanel(page, title, /Checked src\//)

  await page.reload()
  await chatTab(page, title).click()
  await expectGroupAndPanel(page, title, /Checked src\//)
})
