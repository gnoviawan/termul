import { expect, type Page, test } from 'playwright/test'
import { chatCard, chatTab, launchChat, openWorkspace, selectColumnTab, selectProject } from './ui'

/**
 * Subagents stay in the chat history. The fake agent's `[SUBAGENTS:4]
 * [BG_TAIL:8]` announces two subagents in the ACP RFD form, ends the turn
 * after 4 s and reports each one idle 8 s later; `[SUBAGENTS:3]` sends two
 * legacy Claude background `Agent` calls. In both, the turn folds when it
 * ends, and the subagent group must stay in the transcript, live, after a
 * reload and after a reopen from the Chats list, with the panel's Activity
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

function paneOf(page: Page, title: string) {
  return page.locator('[data-pane-content]').filter({ has: chatTab(page, title) })
}

/**
 * The folded turn shows the group; its first row opens the subagent panel.
 * The group stays open while a subagent works. It folds once all settle, and
 * the fold animation unmounts the rows when it ends: wait for that before
 * opening the group, or a row seen mid-fold detaches under the click.
 */
async function expectGroupAndPanel(
  page: Page,
  title: string,
  status: '2 done' | '2 working',
  text: RegExp
): Promise<void> {
  const pane = paneOf(page, title)
  await expect(pane.getByRole('button', { name: /^Worked/ })).toBeVisible()
  const header = pane
    .getByRole('button', { name: `2 subagents: ${status}`, exact: true })
    .filter({ visible: true })
  await expect(header).toHaveCount(1)
  const rows = pane.locator('[data-subagent-row]').filter({ visible: true })
  if (status === '2 done') {
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(rows).toHaveCount(0)
    await header.click()
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await rows.first().click()
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
  await selectColumnTab(page, 'Chats')
  await chatCard(page, title).click()
  await expect(chatTab(page, title)).toBeVisible()
}

test('RFD subagents stay in the transcript after the turn, a reload and a reopen', async ({
  page
}) => {
  const title = 'history rfd'
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
  await expectGroupAndPanel(page, title, '2 done', /Result.*Checked src\//s)

  await page.reload()
  await chatTab(page, title).click()
  await expectGroupAndPanel(page, title, '2 done', /Result.*Checked src\//s)

  await reopenFromHistory(page, title)
  await expectGroupAndPanel(page, title, '2 done', /Result.*Checked src\//s)
})

test('legacy Claude background subagents keep their activity across a reload', async ({ page }) => {
  const title = 'history legacy'
  await launchChat(page, `${title} [SUBAGENTS:3]`)
  const pane = paneOf(page, title)
  await expect(pane.getByText('Both reviewers finished.').filter({ visible: true })).toBeVisible()
  await expectGroupAndPanel(page, title, '2 working', /Checked src\//)

  await page.reload()
  await chatTab(page, title).click()
  await expectGroupAndPanel(page, title, '2 working', /Checked src\//)
})
