import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, storeKey, wsRequest } from './helpers'
import { chatTab, launchChat, openWorkspace, selectProject } from './ui'

/**
 * Stop one subagent. The fake agent's `[SUBAGENTS:12] [BG_TAIL:30]` runs two
 * subagents in the ACP RFD form with `capabilities.cancel`, keeps its turn
 * open for 12 s and the subagents for 30 s past it. A `session/cancel` for a
 * subagent's session ends only that subagent as cancelled. The stop happens
 * while the turn runs, so the turn's own normal end proves it was not
 * cancelled.
 */

test.setTimeout(90_000)

const PROMPT_MARKERS = '[SUBAGENTS:12] [BG_TAIL:30]'
const TURN_END = 'I am waiting for them.'

function rowIn(scope: ReturnType<Page['locator']>, title: string, status: string) {
  return scope.getByRole('button', { name: new RegExp(`^${title}.*${status}`) })
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await openWorkspace(page)
    await selectProject(page, 'proj-c')
  })

  test('Stop in the panel ends one subagent and leaves the rest running', async ({ page }) => {
    const title = 'stop one subagent'
    await launchChat(page, `${title} ${PROMPT_MARKERS}`)
    const pane = page.locator('[data-pane-content]').filter({ has: chatTab(page, title) })
    const pill = pane.getByRole('button', { name: /^Session status: subagents/ })
    // Earlier proj-c chats (background-subagents, subagent-history, an earlier
    // run of this test) end with the same sentence and stay mounted, invisible,
    // behind this tab. The role query skips them.
    const transcript = pane.getByRole('log')
    await expect(pill).toHaveAccessibleName(/subagents 2 working/)

    await pill.click()
    await rowIn(
      page.getByRole('dialog', { name: 'Subagents' }),
      'Review the store',
      'Working'
    ).click()
    const panel = page.getByTestId('subagent-panel')
    await panel.getByRole('button', { name: 'Stop', exact: true }).click()

    await expect(panel.getByText('Stopped', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: /^Stop/ })).toHaveCount(0)
    await expect(pill).toHaveAccessibleName(/subagents 1 working, 1 stopped/)

    await expect(transcript.getByText(TURN_END)).toBeVisible({ timeout: 20_000 })
    await expect(transcript.getByText(/\[CANCELLED after/)).toHaveCount(0)
    await expect(pill).toHaveAccessibleName(/subagents 1 working, 1 stopped/)
  })
})

test.describe('phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  })

  /** A fresh project, so the phone launcher opens on a new chat. */
  async function registerProject(): Promise<{ id: string; name: string }> {
    const root = process.env.E2E_WORKSPACE_ROOT
    if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
    const name = `proj-stop-${randomUUID().slice(0, 8)}`
    const id = `e2e-${name}`
    const path = join(root, name)
    await mkdir(path, { recursive: true })
    const api = await request.newContext()
    try {
      const res = await api.post(`${E2E_BASE_URL}/projects`, {
        headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'content-type': 'application/json' },
        data: { id, name, path, color: 'blue' }
      })
      if (!res.ok()) throw new Error(`project registration failed: ${res.status()}`)
    } finally {
      await api.dispose()
    }
    return { id, name }
  }

  test('a row stop asks first, then stops only that subagent', async ({ page }) => {
    const project = await registerProject()
    await wsRequest(E2E_BASE_URL, 'store_write', {
      key: storeKey('active-project'),
      value: { _version: 1, data: project.id }
    })
    await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
    await page.waitForFunction(
      (token) => localStorage.getItem('termul.webAuthToken') === token,
      E2E_TOKEN
    )
    await page.goto(`${E2E_BASE_URL}/#/`)
    const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
    const start = page.getByRole('button', { name: 'Start agent chat' })
    await expect(async () => {
      await launcher.focus()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.insertText(`phone stop ${PROMPT_MARKERS}`)
      await expect(start).toBeEnabled({ timeout: 2_500 })
    }).toPass({ timeout: 40_000 })
    await start.tap()

    const pill = page.getByRole('button', { name: /^Session status: subagents/ })
    await expect(pill).toHaveAccessibleName(/subagents 2 working/)
    await pill.tap()
    const sheet = page.getByRole('dialog', { name: 'Subagents' })
    const stop = sheet.getByRole('button', { name: 'Stop Review the store' })
    const box = await stop.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)

    await stop.tap()
    const confirm = page.getByRole('alertdialog', { name: 'Stop agent?' })
    await expect(confirm).toContainText('Its work so far is kept.')
    await confirm.getByRole('button', { name: 'Cancel' }).tap()
    await expect(confirm).toBeHidden()
    await expect(rowIn(sheet, 'Review the store', 'Working')).toBeVisible()

    await stop.tap()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop', exact: true }).tap()
    await expect(rowIn(sheet, 'Review the store', 'Stopped')).toBeVisible()
    await expect(rowIn(sheet, 'Review the host', 'Working')).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Stop Review the store' })).toHaveCount(0)
    await expect(sheet.getByRole('button', { name: 'Stop Review the host' })).toBeVisible()
  })
})
