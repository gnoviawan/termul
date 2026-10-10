import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'
import { launchChat, openWorkspace, selectProject } from './ui'

/**
 * Mobile message actions E2E (spec-mobile-message-actions): a phone-sized
 * browser drives a REAL chat through the web client's mobile shell and checks
 * what jsdom cannot evaluate — the computed CSS contract (the action row is
 * transparent and inert at rest, revealed by keyboard focus), real touch
 * long-press timing, focus return, the browser's back stack and the
 * interaction with the app-root context menu.
 *
 * Every test registers its own project and chats with the fake agent
 * (`[DURATION:n]` ends the turn quickly), so no state is shared with other
 * suites or with other tests in this file.
 */

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  locale: 'en-US',
  permissions: ['clipboard-read', 'clipboard-write'],
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'
})

test.setTimeout(120_000)

/** A turn that ends ~3s after the prompt (the fake agent's `[DURATION:n]` marker). */
const QUICK_TURN = '[DURATION:2]'

interface Chat {
  prompt: string
  /** Every message element of the open chat's thread, in order. */
  messages: Locator
  /** The first user message (the prompt). */
  user: Locator
  /** The agent reply of the first turn. */
  agent: Locator
  /** The open chat's composer (the launcher's carries the "Agent prompt" name). */
  composer: Locator
}

/**
 * Register a throwaway project under the suite's workspace root and make it
 * the web client's active project, so the app boots straight into it. The
 * name is unique per call: chat state persists per project id.
 */
async function registerActiveProject(): Promise<string> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-msgact-${randomUUID().slice(0, 8)}`
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
    key: 'web-active-project',
    value: { _version: 1, data: id }
  })
  return name
}

/** The locators of the chat that will hold `prompt` as its first user message. */
function chatFor(page: Page, prompt: string): Chat {
  const messages = page.getByRole('log').locator('[data-slot="message"]')
  return {
    prompt,
    messages,
    user: messages.filter({ hasText: prompt }).first(),
    agent: messages.filter({ hasText: /chunk-\d/ }).first(),
    composer: page.locator('[data-chat-composer="true"]').getByRole('textbox')
  }
}

/** The JSON body of a websocket frame, or `undefined` for a non-JSON (or binary) one. */
function parseFrame<T>(payload: string | Buffer): T | undefined {
  try {
    return JSON.parse(String(payload)) as T
  } catch {
    return undefined
  }
}

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session, and that session
 * creation re-activates the pane. Text typed into the launcher BEFORE it lands
 * is discarded with the old composer (a test-only race: a person needs seconds
 * to start typing). An agent that fails to start also ends the warm-up: no
 * session will follow it.
 *
 * Rejects after `timeoutMs` when no matching frame is seen (the app reused an
 * existing session, the request ids differ, ...), so a failure points at the
 * warm-up step instead of the 120s test timeout. Non-JSON frames are ignored.
 */
function watchAgentWarmup(page: Page, timeoutMs = 30_000): Promise<void> {
  const warmup = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`agent warm-up not observed within ${timeoutMs}ms`)),
      timeoutMs
    )
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
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
        if (kind === 'create_session' || (kind === 'spawn_agent' && reply?.ok === false)) done()
      })
    })
  })
  // The wait is awaited later, after the project is registered and the page has
  // loaded; a timeout in between must not surface as an unhandled rejection.
  warmup.catch(() => undefined)
  return warmup
}

/**
 * Boot the mobile shell on a fresh project and send `prompt` from the empty
 * launcher. Resolves once the user message is in the thread.
 */
async function openChat(page: Page, prompt: string): Promise<Chat> {
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

  const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
  await launcher.click()
  await page.keyboard.type(prompt)
  await expect(launcher).toContainText(prompt)
  await page.keyboard.press('Enter')

  const chat = chatFor(page, prompt)
  await expect(chat.user).toBeVisible()
  return chat
}

/** A unique prompt that ends its turn ~3s later (the fake agent's `[DURATION:n]` marker). */
function quickPrompt(label: string): string {
  return `${label} ${randomUUID().slice(0, 6)} ${QUICK_TURN}`
}

/**
 * `openChat` for a quick turn, resolved once the reply has settled: the agent
 * message only becomes focusable when it stops streaming and ends its turn.
 */
async function openSettledChat(page: Page, label: string): Promise<Chat> {
  const chat = await openChat(page, quickPrompt(label))
  await expect(chat.agent).toHaveAttribute('tabindex', '0', { timeout: 60_000 })
  return chat
}

interface ActionState {
  /** Opacity multiplied through every ancestor: what the eye sees. */
  opacity: number
  pointerEvents: string
  /** Whether a tap on the control's centre would land on it. */
  reachable: boolean
}

/** The computed, real-browser state of an action-row control. */
function actionState(control: Locator): Promise<ActionState> {
  return control.evaluate((element) => {
    let opacity = 1
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity)
    }
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return {
      opacity: Math.round(opacity * 100) / 100,
      pointerEvents: getComputedStyle(element).pointerEvents,
      reachable: hit !== null && element.contains(hit)
    }
  })
}

const HIDDEN: ActionState = { opacity: 0, pointerEvents: 'none', reachable: false }
const REVEALED: ActionState = { opacity: 1, pointerEvents: 'auto', reachable: true }

/** Poll until every named control of `message` is in `expected` (the reveal fades over 150ms). */
async function expectRow(
  message: Locator,
  names: readonly string[],
  expected: ActionState
): Promise<void> {
  for (const name of names) {
    await expect
      .poll(() => actionState(message.getByRole('button', { name, exact: true })), {
        message: `${name} action state`
      })
      .toEqual(expected)
  }
}

/** Shift+Tab from wherever focus is until `target` itself has focus. */
async function tabBackTo(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Shift+Tab')
  }
  await expect(target).toBeFocused()
}

/** The centre of a locator, scrolled into view, in viewport coordinates. */
async function centreOf(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no layout box (not rendered)')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Put a finger down at `point` with real touch events and keep it there. The
 * returned function lifts it. Playwright's `tap()` has no hold, so the touch
 * goes through CDP; the browser then runs its own pointer/touch pipeline, which
 * is what Radix's 700ms long-press timer listens to.
 */
async function pressAndHold(
  page: Page,
  point: { x: number; y: number }
): Promise<{ move: (dx: number, dy: number) => Promise<void>; release: () => Promise<void> }> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  return {
    move: async (dx, dy) => {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: point.x + dx, y: point.y + dy }]
      })
    },
    release: async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await cdp.detach()
    }
  }
}

/**
 * Long-press the message's content until its menu is up, hold past the
 * app-root menu's own 700ms timer (it must have been suppressed), then lift.
 * Resolves with the finished state: menu open, finger up.
 */
async function longPress(page: Page, content: Locator): Promise<void> {
  const finger = await pressAndHold(page, await centreOf(content))
  await expect(page.getByRole('menu')).toBeVisible()
  await page.waitForTimeout(800)
  await expect(page.getByRole('menu')).toHaveCount(1)
  await finger.release()
}

/** The menu's items, in order. A Radix menu item's name is its label. */
function menuItems(page: Page): Locator {
  return page.getByRole('menuitem')
}

/** What the page's clipboard holds right now. */
function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText())
}

/** Put a known value on the clipboard so a stale copy can never satisfy an assertion. */
async function seedClipboard(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText('e2e-clipboard-sentinel'))
  expect(await readClipboard(page)).toBe('e2e-clipboard-sentinel')
}

/** Frontend log lines the page POSTs to the server, parsed. */
function trackFrontendLogs(
  page: Page
): () => Array<{ level: string; source: string; body: string }> {
  const lines: Array<{ level: string; source: string; body: string }> = []
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().endsWith('/log/frontend-error')) return
    const payload = req.postDataJSON() as { level?: string; source?: string }
    lines.push({
      level: payload.level ?? '',
      source: payload.source ?? '',
      body: req.postData() ?? ''
    })
  })
  return () => [...lines]
}

test('at rest both settled messages are focusable but their action rows stay hidden and inert, and a tap changes nothing', async ({
  page
}) => {
  const chat = await openSettledChat(page, 'rest')

  await expect(chat.user).toHaveAttribute('tabindex', '0')
  await expect(chat.agent).toHaveAttribute('tabindex', '0')
  // The agent reply is the last message of the thread, which pins its row
  // everywhere else: focus mode ignores `pinned`, so it is hidden too.
  await expectRow(chat.user, ['Copy', 'Edit'], HIDDEN)
  await expectRow(chat.agent, ['Copy', 'Retry'], HIDDEN)

  // A tap neither reveals a row nor opens a menu: touch users get the
  // long-press, keyboard and assistive-technology users get focus.
  await chat.user.tap()
  await chat.agent.tap()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expectRow(chat.user, ['Copy', 'Edit'], HIDDEN)
  await expectRow(chat.agent, ['Copy', 'Retry'], HIDDEN)
})

test('keyboard focus reveals a message row: from inside the row and from the message itself, with a focus ring', async ({
  page
}) => {
  const chat = await openSettledChat(page, 'focus')
  await chat.composer.focus()

  // One Shift+Tab from the composer lands on the agent row's last control:
  // the row shows because focus is inside it.
  await page.keyboard.press('Shift+Tab')
  await expect(chat.agent.getByRole('button', { name: 'Retry', exact: true })).toBeFocused()
  await expectRow(chat.agent, ['Copy', 'Retry'], REVEALED)
  await expectRow(chat.user, ['Copy', 'Edit'], HIDDEN)

  // The agent message itself: row revealed and an inset focus ring painted.
  await tabBackTo(page, chat.agent)
  await expectRow(chat.agent, ['Copy', 'Retry'], REVEALED)
  await expect(chat.agent).not.toHaveCSS('box-shadow', 'none')
  await expect(chat.user).toHaveCSS('box-shadow', 'none')

  // Moving on to the user message hands the reveal over.
  await tabBackTo(page, chat.user)
  await expectRow(chat.user, ['Copy', 'Edit'], REVEALED)
  await expectRow(chat.agent, ['Copy', 'Retry'], HIDDEN)
  await expect(chat.user).not.toHaveCSS('box-shadow', 'none')
})

test('a revealed row still works by touch: tapping its Copy copies the turn', async ({ page }) => {
  const chat = await openSettledChat(page, 'rowtap')
  await chat.composer.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(chat.agent.getByRole('button', { name: 'Retry', exact: true })).toBeFocused()
  await expectRow(chat.agent, ['Copy', 'Retry'], REVEALED)
  await seedClipboard(page)

  // The message's touch pointerdown is default-prevented (it keeps the
  // app-root menu from arming); the click on a control inside must still fire.
  await chat.agent.getByRole('button', { name: 'Copy', exact: true }).tap()

  await expect.poll(() => readClipboard(page)).toContain('[DONE after')
  expect(await readClipboard(page)).toMatch(/^chunk-1 /)
})

test('long-pressing a user message opens Copy and Edit (no app-level Paste / Select All); Copy copies the prompt', async ({
  page
}) => {
  const chat = await openSettledChat(page, 'userlp')
  await seedClipboard(page)
  await expect(page.getByRole('menu')).toHaveCount(0)

  await longPress(page, chat.user.getByText(chat.prompt))

  // Exactly the row's items, in the row's order. Any app-level Copy / Cut /
  // Paste / Select All entry would show up in this list.
  await expect(menuItems(page)).toHaveText(['Copy', 'Edit'])

  await page.getByRole('menuitem', { name: 'Copy', exact: true }).tap()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(() => readClipboard(page)).toBe(chat.prompt)
  // A successful copy is silent: no toast of either kind.
  await expect(page.getByText('Failed to copy')).toHaveCount(0)
})

test('long-pressing the agent turn tail opens Copy and Retry; Copy copies the reply and Retry re-runs the turn', async ({
  page
}) => {
  const chat = await openSettledChat(page, 'agentlp')
  await seedClipboard(page)
  const reply = chat.agent.getByText(/\[DONE after/)

  await longPress(page, reply)
  await expect(menuItems(page)).toHaveText(['Copy', 'Retry'])
  await page.getByRole('menuitem', { name: 'Copy', exact: true }).tap()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(() => readClipboard(page)).toContain('[DONE after')

  await expect(page.getByRole('log').getByText(/\[DONE after/)).toHaveCount(1)
  await longPress(page, reply)
  await page.getByRole('menuitem', { name: 'Retry', exact: true }).tap()
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Retry re-sends the last user turn: a second reply finishes in the thread.
  await expect(page.getByRole('log').getByText(/\[DONE after/)).toHaveCount(2, {
    timeout: 60_000
  })
})

test('choosing Edit seeds the composer with the prompt and leaves focus there, not on the message', async ({
  page
}) => {
  const chat = await openSettledChat(page, 'edit')

  await longPress(page, chat.user.getByText(chat.prompt))
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).tap()

  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(chat.composer).toContainText(chat.prompt)
  await expect(chat.composer).toBeFocused()
  await expect(chat.user).not.toBeFocused()
})

test('the context-menu key, Shift+F10 and a right-click open the menu; Esc closes it and focus returns to the message', async ({
  page
}) => {
  const chat = await openSettledChat(page, 'keys')
  await chat.composer.focus()
  await tabBackTo(page, chat.user)
  await expect(chat.user).toBeFocused()

  await page.keyboard.press('ContextMenu')
  await expect(menuItems(page)).toHaveText(['Copy', 'Edit'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(chat.user).toBeFocused()

  await page.keyboard.press('Shift+F10')
  await expect(menuItems(page)).toHaveText(['Copy', 'Edit'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(chat.user).toBeFocused()

  // A mouse right-click on the agent tail: its own menu, again without the
  // app-level entries.
  await chat.agent.getByText(/\[DONE after/).click({ button: 'right' })
  await expect(menuItems(page)).toHaveText(['Copy', 'Retry'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('system back closes the open menu and stays in the chat', async ({ page }) => {
  const chat = await openSettledChat(page, 'back')
  const hash = new URL(page.url()).hash

  await longPress(page, chat.user.getByText(chat.prompt))
  await expect(menuItems(page)).toHaveText(['Copy', 'Edit'])

  await page.goBack()

  await expect(page.getByRole('menu')).toHaveCount(0)
  // Back consumed the overlay, not the route: still the same chat, thread intact.
  expect(new URL(page.url()).hash).toBe(hash)
  await expect(chat.user).toBeVisible()
  await expect(chat.agent).toBeVisible()
})

test('a finger that drags instead of holding never opens the menu', async ({ page }) => {
  const chat = await openSettledChat(page, 'drag')

  const finger = await pressAndHold(page, await centreOf(chat.user.getByText(chat.prompt)))
  await finger.move(0, -24)
  await finger.move(0, -48)
  // Longer than the 700ms long-press: if the move had not cancelled it, the
  // menu would be up by now.
  await page.waitForTimeout(1_000)
  await finger.release()

  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('a streaming reply is untouched; once it settles into the turn tail it is focusable and gets its menu', async ({
  page
}) => {
  const chat = await openChat(page, `stream ${randomUUID().slice(0, 6)} [DURATION:8]`)
  await expect(chat.agent).toBeVisible()

  // While streaming: the user message already has actions, the reply none.
  await expect(chat.user).toHaveAttribute('tabindex', '0')
  await expect(chat.agent).not.toHaveAttribute('tabindex', /.*/)
  await expect(chat.agent).not.toHaveAttribute('data-state', /.*/)

  // A right-click is the app-level menu's, never the message menu.
  await chat.agent
    .getByText(/chunk-\d/)
    .first()
    .click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: /^Paste/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Retry', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  // The turn ends and the reply becomes the settled turn tail: focusable, with
  // its menu. (The list swaps the live turn's container for a plain message
  // item at this point, so the DOM node itself is not carried over.)
  await expect(chat.agent).toHaveAttribute('tabindex', '0', { timeout: 60_000 })
  await longPress(page, chat.agent.getByText(/\[DONE after/))
  await expect(menuItems(page)).toHaveText(['Copy', 'Retry'])
})

test('when the clipboard refuses, the menu closes with the existing "Failed to copy" toast and a warn log without the text', async ({
  page
}) => {
  const logs = trackFrontendLogs(page)
  const chat = await openSettledChat(page, 'nocopy')
  // Both clipboard paths copyText tries (async API, then execCommand) fail.
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: () => Promise.reject(new Error('clipboard refused (e2e)'))
    })
    document.execCommand = () => false
  })

  await longPress(page, chat.user.getByText(chat.prompt))
  await page.getByRole('menuitem', { name: 'Copy', exact: true }).tap()

  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByText('Failed to copy')).toBeVisible()
  await expect
    .poll(() => logs().filter((line) => line.source === 'MessageActions.contextMenu'))
    .toHaveLength(1)
  const [warning] = logs().filter((line) => line.source === 'MessageActions.contextMenu')
  expect(warning.level).toBe('warn')
  expect(warning.body).not.toContain(chat.prompt)
})

test('without PointerEvent long-press cannot work: rows stay visible, messages stay focusable and selectable, one info log per page load', async ({
  page
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: undefined })
  })
  const logs = trackFrontendLogs(page)
  const chat = await openSettledChat(page, 'fallback')
  expect(await page.evaluate(() => typeof window.PointerEvent)).toBe('undefined')

  // Rows keep today's touch behaviour: visible at rest, no focus needed.
  await expectRow(chat.user, ['Copy', 'Edit'], REVEALED)
  await expectRow(chat.agent, ['Copy', 'Retry'], REVEALED)
  await expect(chat.user).toHaveAttribute('tabindex', '0')
  await expect(chat.agent).toHaveAttribute('tabindex', '0')
  // Long-press cannot own the gesture here, so native text selection stays.
  await expect(chat.user).not.toHaveCSS('user-select', 'none')
  await expect(chat.agent).not.toHaveCSS('user-select', 'none')

  // The visible Copy carries the action.
  await seedClipboard(page)
  await chat.user.getByRole('button', { name: 'Copy', exact: true }).tap()
  await expect.poll(() => readClipboard(page)).toBe(chat.prompt)

  // The menu still opens on `contextmenu`.
  await chat.user.getByText(chat.prompt).click({ button: 'right' })
  await expect(menuItems(page)).toHaveText(['Copy', 'Edit'])
  await page.keyboard.press('Escape')

  // Two messages fell back, one log line.
  await expect
    .poll(() => logs().filter((line) => line.source === 'MessageActions.fallback'))
    .toHaveLength(1)
  const [info] = logs().filter((line) => line.source === 'MessageActions.fallback')
  expect(info.level).toBe('info')
  expect(info.body).not.toContain(chat.prompt)
})

test.describe('desktop shell', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
  })

  test("a wide window keeps today's messages: not focusable, no message menu, hover reveals the row", async ({
    page
  }) => {
    // The desktop shell has no launcher-in-the-pane flow: use the sidebar.
    // Prompt text typed before the boot-time agent warm-up lands is discarded
    // with the old composer, so wait for it like `openChat` does (a loaded
    // server, e.g. after the mobile tests, makes the race visible here too).
    const warmedUp = watchAgentWarmup(page)
    const projectName = await registerActiveProject()
    await openWorkspace(page)
    await selectProject(page, projectName)
    await warmedUp
    const prompt = quickPrompt('desktop')
    await launchChat(page, prompt)
    const chat = chatFor(page, prompt)
    await expect(chat.agent).toContainText('[DONE after', { timeout: 60_000 })

    await expect(chat.user).not.toHaveAttribute('tabindex', /.*/)
    await expect(chat.agent).not.toHaveAttribute('tabindex', /.*/)
    await expect(chat.user).not.toHaveAttribute('data-state', /.*/)

    // Hover reveal on a fine pointer is unchanged: opacity only, the row never
    // goes pointer-events: none.
    const copy = chat.user.getByRole('button', { name: 'Copy', exact: true })
    await page.mouse.move(0, 0)
    await expect.poll(async () => (await actionState(copy)).opacity).toBe(0)
    expect((await actionState(copy)).pointerEvents).toBe('auto')
    await chat.user.hover()
    await expect.poll(() => actionState(copy)).toEqual(REVEALED)

    // Right-click is the app-level menu's; no Edit / Retry entry.
    await chat.user.getByText(chat.prompt).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /^Paste/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Retry', exact: true })).toHaveCount(0)
  })
})
