import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN } from './helpers'
import { launchChat, openWorkspace, selectProject } from './ui'

/**
 * The composer @ menu in a real browser against termul-server: a bare `@`
 * opens Conversations and Explorer, Explorer lists the project with no query
 * (it used to show nothing on web), folders drill in and back, and a picked
 * conversation becomes a pill that the sent prompt keeps as a chip.
 */

test.setTimeout(120_000)

const createdProjectIds: string[] = []

test.afterEach(async ({ request }) => {
  for (const id of createdProjectIds.splice(0)) {
    await request
      .delete(`${E2E_BASE_URL}/projects/${id}`, {
        headers: { Authorization: `Bearer ${E2E_TOKEN}` }
      })
      .catch(() => {})
  }
})

async function createProject(api: APIRequestContext): Promise<string> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT unset — run under tests/e2e global-setup')
  const unique = `at-menu-${randomUUID().slice(0, 6)}`
  const path = join(root, unique)
  await mkdir(join(path, 'src'), { recursive: true })
  await writeFile(join(path, 'README.md'), '# readme\n')
  await writeFile(join(path, 'src', 'app.ts'), 'export {}\n')
  const id = `e2e-proj-${unique}`
  const res = await api.post(`${E2E_BASE_URL}/projects`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'content-type': 'application/json' },
    data: { id, name: unique, path, color: 'blue' }
  })
  if (!res.ok()) throw new Error(`project registration failed: ${res.status()}`)
  createdProjectIds.push(id)
  return unique
}

const launcherEditor = (page: Page) =>
  page.locator('[data-composer-editor="true"][aria-label="Agent prompt"]').first()
const menu = (page: Page) => page.getByRole('listbox')
const option = (page: Page, name: string | RegExp) => menu(page).getByRole('option', { name })

async function openLauncher(page: Page): Promise<void> {
  if (!(await launcherEditor(page).isVisible())) {
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
  }
  await expect(launcherEditor(page)).toHaveAttribute('contenteditable', 'true')
}

test('a bare @ lists Conversations and Explorer, and Explorer shows files without typing', async ({
  page,
  request
}) => {
  const projectName = await createProject(request)
  await openWorkspace(page)
  await selectProject(page, projectName)
  await openLauncher(page)

  await launcherEditor(page).click()
  await page.keyboard.type('look at @')
  await expect(option(page, /^Conversations/)).toBeVisible()
  await expect(option(page, /^Explorer/)).toBeVisible()

  await option(page, /^Explorer/).click()
  await expect(option(page, /^src/)).toBeVisible()
  await expect(option(page, /^README\.md/)).toBeVisible()

  await option(page, /^src/).click()
  await expect(option(page, /^app\.ts/)).toBeVisible()
  await expect(option(page, /Use this folder/)).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(option(page, /^README\.md/)).toBeVisible()

  await option(page, /^README\.md/).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(launcherEditor(page)).toContainText('README.md')
})

test('a picked conversation becomes a pill and the sent prompt keeps it as a chip', async ({
  page,
  request
}) => {
  const projectName = await createProject(request)
  await openWorkspace(page)
  await selectProject(page, projectName)
  await launchChat(page, '[DURATION:1] first chat about parsing')
  await launchChat(page, '[DURATION:1] second chat')

  const chatEditor = page.locator('[data-chat-composer="true"] [data-composer-editor="true"]')
  await expect(chatEditor.filter({ visible: true })).toHaveCount(1)
  await chatEditor.filter({ visible: true }).click()
  await page.keyboard.type('compare with @')
  await option(page, /^Conversations/).click()
  const row = option(page, /first chat about parsing/)
  await expect(row).toBeVisible()
  await row.click()
  await expect(menu(page)).toHaveCount(0)
  const editor = chatEditor.filter({ visible: true })
  await expect(editor.locator('[title*="first chat about parsing"]')).toBeVisible()

  await page.keyboard.type(' now')
  await page.keyboard.press('Enter')
  await expect(editor).toHaveText('')
  const sentMessage = page.getByText('compare with', { exact: false }).last()
  await expect(
    sentMessage.locator('..').locator('[title*="first chat about parsing"]')
  ).toBeVisible()
  await expect(editor.locator('[title*="first chat about parsing"]')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('termul-conversation')
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('the @ menu opens Explorer with files on a phone', async ({ page, request }) => {
    const projectName = await createProject(request)
    await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
    await page.waitForFunction(
      (token) => localStorage.getItem('termul.webAuthToken') === token,
      E2E_TOKEN
    )
    await page.goto(`${E2E_BASE_URL}/#/`)
    await page.getByRole('button', { name: 'Switch project' }).tap()
    await page.getByRole('button', { name: projectName, exact: true }).tap()
    await expect(launcherEditor(page)).toHaveAttribute('contenteditable', 'true')

    await launcherEditor(page).tap()
    await page.keyboard.type('@')
    await expect(option(page, /^Conversations/)).toBeVisible()
    await option(page, /^Explorer/).tap()
    await expect(option(page, /^README\.md/)).toBeVisible()
    await expect(launcherEditor(page)).toBeFocused()
  })
})
