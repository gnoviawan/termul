import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, storeKey, wsRequest } from './helpers'
import { visibleChunkCount } from './ui'

/**
 * Reopening a chat whose turn is still running must show the tool cards the
 * agent emitted before the browser left (a reload, a closed tab), not only
 * the thoughts and replies. The fake agent's `[DOCK]` marker emits three
 * completed edit cards at the start of the turn and `[DURATION:90]` keeps the
 * turn streaming across the reload.
 */

test.setTimeout(120_000)

async function serverAgentIds(): Promise<string[]> {
  const agents = await wsRequest<Array<{ id: string }>>(E2E_BASE_URL, 'list_agents', {})
  return agents.map((agent) => agent.id)
}

let agentsBeforeTest = new Set<string>()

test.beforeEach(async () => {
  agentsBeforeTest = new Set(await serverAgentIds())
})

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) await page.close()
  for (const agentId of await serverAgentIds()) {
    if (agentsBeforeTest.has(agentId)) continue
    await wsRequest(E2E_BASE_URL, 'kill_agent', { agentId }).catch(() => {
      // already gone
    })
  }
})

async function registerProject(): Promise<{ id: string; name: string }> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-reopen-${randomUUID().slice(0, 8)}`
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

/** Boot the shell on a fresh project and start a chat from the empty-pane launcher. */
async function launchChat(page: Page, prompt: string): Promise<void> {
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
  await expect(
    page.getByRole('heading', { level: 1, name: `What should we do in ${project.name}?` })
  ).toBeVisible()
  const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
  const start = page.getByRole('button', { name: 'Start agent chat' })
  await expect(async () => {
    await launcher.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(prompt)
    await expect(start).toBeEnabled({ timeout: 2_500 })
  }).toPass({ timeout: 40_000 })
  await start.click()
  await expect(launcher).toBeHidden()
}

const EDITED_PATHS = ['src/auth.ts', 'src/session.ts', 'src/token.ts']

function diffBlockPaths(page: Page): Promise<string[]> {
  return page
    .locator('[data-diff-block]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-diff-block') ?? ''))
}

test('reload mid-turn: the reopened chat shows the tool cards emitted before the reload', async ({
  page
}) => {
  await launchChat(page, '[DOCK] [DURATION:90] reopen keeps tool cards')
  await expect.poll(() => diffBlockPaths(page)).toEqual(EDITED_PATHS)
  await expect(page.locator('main')).toContainText('chunk-2 ')
  const before = await visibleChunkCount(page)

  await page.reload()

  await expect.poll(() => visibleChunkCount(page), { timeout: 60_000 }).toBeGreaterThan(before)
  await expect.poll(() => diffBlockPaths(page)).toEqual(EDITED_PATHS)
  const cardsPrecedeChunks = await page.evaluate(() => {
    const lastCard = [...document.querySelectorAll('[data-diff-block]')].at(-1)
    const chunk = [...document.querySelectorAll('main *')].find(
      (el) => el.children.length === 0 && /\bchunk-1\b/.test(el.textContent ?? '')
    )
    if (!lastCard || !chunk) return 'missing'
    return lastCard.compareDocumentPosition(chunk) & Node.DOCUMENT_POSITION_FOLLOWING
      ? 'cards first'
      : 'chunks first'
  })
  expect(cardsPrecedeChunks).toBe('cards first')
})
