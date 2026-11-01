import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, storeKey, wsRequest } from './helpers'

/**
 * On a phone, a long-press on text belongs to the OS: it selects a word, shows
 * the selection handles and the native Copy / Paste menu. The app-root
 * `GlobalContextMenu` must not open on a touch long-press: its modal layer
 * sets `pointer-events: none` on the body, so the selection handles freeze.
 */

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  locale: 'en-US',
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'
})

test.setTimeout(120_000)

async function registerActiveProject(): Promise<string> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-touchsel-${randomUUID().slice(0, 8)}`
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
  await wsRequest(E2E_BASE_URL, 'store_write', {
    key: storeKey('active-project'),
    value: { _version: 1, data: id }
  })
  return name
}

/**
 * Resolves once the boot-time agent warm-up has created its draft session.
 * Text typed into the launcher before then is discarded with the old composer.
 */
function watchAgentWarmup(page: Page, timeoutMs = 30_000): Promise<void> {
  const warmup = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`agent warm-up not observed within ${timeoutMs}ms`)),
      timeoutMs
    )
    page.on('websocket', (socket) => {
      if (socket.url().endsWith('/terminal/ws')) return
      const watched = new Map<string, string>()
      socket.on('framesent', (frame) => {
        const message = parseFrame<{ id?: string; type?: string }>(frame.payload)
        if (message?.id && (message.type === 'create_session' || message.type === 'spawn_agent')) {
          watched.set(message.id, message.type)
        }
      })
      socket.on('framereceived', (frame) => {
        const reply = parseFrame<{ id?: string; ok?: boolean }>(frame.payload)
        const kind = reply?.id ? watched.get(reply.id) : undefined
        if (kind === 'create_session' || (kind === 'spawn_agent' && reply?.ok === false)) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
  })
  warmup.catch(() => undefined)
  return warmup
}

function parseFrame<T>(payload: string | Buffer): T | undefined {
  try {
    return JSON.parse(String(payload)) as T
  } catch {
    return undefined
  }
}

async function bootMobileShell(page: Page): Promise<void> {
  const warmedUp = watchAgentWarmup(page)
  const projectName = await registerActiveProject()
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  await expect(
    page.getByRole('button', { name: new RegExp(`^${projectName}.*switch project$`) })
  ).toBeVisible()
  await warmedUp
}

async function sendPrompt(page: Page, composer: Locator, prompt: string): Promise<void> {
  await composer.click()
  await page.keyboard.type(prompt)
  await expect(composer).toContainText(prompt)
  await page.keyboard.press('Enter')
}

/**
 * Hold a finger on `target` for well past Radix's 700ms long-press timer,
 * through CDP so the browser runs its own touch, pointer and gesture pipeline.
 */
async function longPress(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error('long-press target has no layout box')
  const point = { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(1200)
  await expectNativeLongPress(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** What the finger sees mid-press: no app menu, and a page that still takes pointers. */
async function expectNativeLongPress(page: Page): Promise<void> {
  await expect(page.getByRole('menuitem')).toHaveText([])
  expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe('auto')
}

test('a long-press in the chat composer leaves the native menu (with Paste) to the OS', async ({
  page
}) => {
  await bootMobileShell(page)
  const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
  await launcher.click()
  await page.keyboard.type('hold here to paste')
  await expect(launcher).toContainText('hold here to paste')

  await longPress(page, launcher.getByText('hold here to paste'))
})

test('a long-press on agent prose selects text without an app menu taking over', async ({
  page
}) => {
  await bootMobileShell(page)
  const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
  await sendPrompt(page, launcher, `stream ${randomUUID().slice(0, 6)} [DURATION:40]`)

  // A reply still streaming has no message menu of its own (only a settled
  // turn tail does): its text is plain selectable prose.
  const reply = page
    .getByRole('log')
    .getByText(/chunk-2/)
    .first()
  await expect(reply).toBeVisible({ timeout: 30_000 })
  await longPress(page, reply)
})
