import { randomUUID } from 'node:crypto'
import { expect, type Page, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN } from './helpers'
import { openWorkspace, selectColumnTab, selectProject } from './ui'

/**
 * Editor regression guards (the "editor always spinning" class):
 *
 * Root cause map (verified against dev @ 60178b3f):
 * - EditorPanel renders "Loading..." while a workspace editor tab exists
 *   without a matching editor-store file state; only a SUCCESSFUL
 *   filesystemApi.readFile clears it (editor-store.ts openFile).
 * - On web that read is GET /fs/read — a failure (or a restored
 *   tab whose read failed) strands the tab on "Loading..." forever.
 *
 * These tests pin the healthy paths: file open renders content, and a
 * reload restores the editor tab with content (not a stuck loader).
 * Test files are created via the server's /fs/write API (deterministic —
 * the New File button focuses the explorer search input on web).
 */

// The reload test chains a 2s persist-debounce wait, a full browser reload,
// and the workspace/editor restore — longer than Playwright's 30s default.
test.setTimeout(120_000)

const FILE_CONTENT = 'e2e editor content line 1'
const FILE_NAME = 'e2e-notes.md'
const RELOAD_FILE_NAME = 'e2e-reload.md'

async function writeFileOnServer(path: string, content: string): Promise<void> {
  const api = await request.newContext()
  const res = await api.post(`${E2E_BASE_URL}/fs/write`, {
    headers: {
      Authorization: `Bearer ${E2E_TOKEN}`,
      'content-type': 'application/json',
      // /fs/write is ledgered: the host refuses it without a command id.
      'X-Command-Id': randomUUID()
    },
    data: { path, content }
  })
  const body = (await res.json()) as { success?: boolean; error?: string }
  if (!res.ok() || !body.success) throw new Error(`fs/write failed: ${res.status()} ${body.error}`)
}

async function workspaceRoot(): Promise<string> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  return root
}

/**
 * The Explorer is a Side panel Column tab; Refresh lives in its header's
 * "More explorer actions" menu.
 */
async function refreshExplorer(page: Page): Promise<void> {
  await selectColumnTab(page, 'Explorer')
  await page.getByRole('button', { name: 'More explorer actions' }).click()
  await page.getByRole('menuitem', { name: 'Refresh' }).click()
}

test('editor opens a file and renders content (no stuck "Loading...")', async ({ page }) => {
  // proj-e is dedicated to the editor suite: no chats ever run there, so
  // the session-resume bootstrap never reopens agent-chat tabs that would
  // race the editor tab restore.
  await writeFileOnServer(`${await workspaceRoot()}/proj-e/${FILE_NAME}`, FILE_CONTENT)
  await openWorkspace(page)
  await selectProject(page, 'proj-e')

  // Refresh the explorer so the new file appears, then open it.
  await refreshExplorer(page)
  const fileNode = page.locator(`[data-path$="${FILE_NAME}"]`).first()
  await fileNode.waitFor({ state: 'visible' })
  await fileNode.dblclick()

  // The editor must render content. A transient "Loading..." during the
  // read is legitimate — a STUCK loader is the regression, so assert
  // content first, then that the loader is gone.
  await expect(page.locator('body')).toContainText(FILE_CONTENT, { timeout: 20_000 })
  await expect(page.locator('body')).not.toContainText('Loading...')
})

test('reload restores the editor tab with its content (not a stuck loader)', async ({ page }) => {
  const path = `${await workspaceRoot()}/proj-e/${RELOAD_FILE_NAME}`
  await writeFileOnServer(path, FILE_CONTENT)
  await openWorkspace(page)
  await selectProject(page, 'proj-e')

  await refreshExplorer(page)
  const fileNode = page.locator(`[data-path$="${RELOAD_FILE_NAME}"]`).first()
  await fileNode.waitFor({ state: 'visible' })
  await fileNode.dblclick()
  await expect(page.locator('body')).toContainText(FILE_CONTENT, { timeout: 20_000 })
  // Let the 500ms editor-state persist debounce flush before reloading
  // (a reload inside the debounce window races the persist — that is a
  // different concern than the stuck-loader regression under test).
  await page.waitForTimeout(2_000)

  await page.reload()
  await page.locator('[aria-label^="Project: proj-e"]').first().waitFor({ state: 'visible' })

  // The editor tab must restore with content. A transient "Loading..."
  // during the read is legitimate — a STUCK loader is the regression, so
  // assert content first, then that the loader is gone.
  await expect(page.locator('body')).toContainText(FILE_CONTENT, { timeout: 30_000 })
  await expect(page.locator('body')).not.toContainText('Loading...')
})
