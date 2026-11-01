import { expect, test } from 'playwright/test'
import { chatTab, launchChat, openWorkspace, selectProject } from './ui'

/**
 * Background subagents that outlive their turn. The fake agent's
 * `[SUBAGENTS:4] [BG_TAIL:8]` launches two background subagents, ends the
 * turn after 4 s while they keep reporting, and reports their end 8 s later
 * through the host's `termul/subagent` marker. Until then the chat's status
 * pill keeps them running and says the chat waits on them.
 *
 * Chats live in proj-c, the least contested seeded project (see
 * elicitation.spec.ts).
 */

test.setTimeout(90_000)

const TITLE = 'bg tail review'

test.beforeEach(async ({ page }) => {
  await openWorkspace(page)
  await selectProject(page, 'proj-c')
})

test('the status pill waits on background subagents after the turn ends', async ({ page }) => {
  await launchChat(page, `${TITLE} [SUBAGENTS:4] [BG_TAIL:8]`)
  const pane = page.locator('[data-pane-content]').filter({ has: chatTab(page, TITLE) })
  await expect(pane.getByText('I am waiting for them.').first()).toBeVisible()

  const pill = pane.getByRole('button', { name: /^Session status: subagents/ })
  await expect(pill).toHaveAccessibleName(
    /^Session status: subagents 2 running; waiting on 2 background subagents/
  )
  await pill.click()
  await expect(
    page.getByRole('dialog', { name: 'Subagents' }).getByText('Waiting on 2 background subagents')
  ).toBeVisible()
  await page.keyboard.press('Escape')

  await expect(pill).toHaveAccessibleName(/^Session status: subagents 2 done(;|$)/, {
    timeout: 20_000
  })
})
