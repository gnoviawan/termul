import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile toast dock clearance E2E (spec-mobile-toast-dock-clearance): a
 * phone-sized browser drives the web client's mobile shell and checks what
 * jsdom cannot: that the toast stack really follows the measured dock.
 *
 * `useDockClearance` publishes the distance from the viewport bottom to the
 * highest dock edge (the chat dock, the terminal key bar or the agent
 * launcher's composer column) as `--mobile-dock-height` on `:root`, and both
 * mobile Toaster offsets are that distance plus a 12px gap. The unit tests
 * pin the arithmetic with stubbed rects; this suite pins the geometry in a
 * real layout: the variable against the element's real top edge, the toast's
 * real bottom edge against the variable, and that no dock control sits under
 * a toast.
 *
 * Every test registers its own project (fresh chat state, nothing shared with
 * other suites) and raises its toast through an existing UI flow: an
 * unsupported attachment (chat and launcher), a failed clipboard read (key
 * bar), an empty required elicitation field, or a saved file (editor tab).
 * The fake agent (fake-longrun-agent.ts) supplies the dock content through
 * prompt markers: `[DOCK]` (changed-files bar), `[ASK:permission]` and
 * `[ASK:elicitation]` (approvals).
 *
 * Not automated here (unit tests own them, see the spec's matrix): a missing
 * `ResizeObserver` (the browser always has one), the clamp to the viewport
 * height, and the once-only warning. The iOS keyboard is emulated the way the
 * dock suite does it: the visual viewport reports less height than the layout
 * viewport, which is what the panel's keyboard spacer reads; a real keyboard
 * and the home-indicator inset need a device pass (V-18 in the spec).
 */

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
})

test.setTimeout(120_000)

const DOCK_VAR = '--mobile-dock-height'
/** The 12px gap `ui/sonner.tsx` adds above the measured dock edge. */
const TOAST_GAP = 12
/** The toast ends at least this far above a dock edge (the gap is 12; leave slack for rounding). */
const MIN_CLEARANCE = 8
/** The most the clearance may over-report while the workspace's boot animation is running. */
const BOOT_ANIMATION_SLACK_PX = 8
/** Keeps a turn running for the whole test, so the dock stays busy. */
const LONG = '[DURATION:90]'
const UNSUPPORTED_TOAST = "This agent can't embed files"

/**
 * Every chat (and every launcher warm-up) runs its own `bun` fake-agent process
 * and the server never reaps them when it stops, so a suite that leaves them
 * running exhausts the machine's commit limit. Each test therefore kills the
 * agents it caused.
 */
async function serverAgentIds(): Promise<string[]> {
  const agents = await wsRequest<Array<{ id: string }>>(E2E_BASE_URL, 'list_agents', {})
  return agents.map((agent) => agent.id)
}

let agentsBeforeTest = new Set<string>()

test.beforeEach(async () => {
  agentsBeforeTest = new Set(await serverAgentIds())
})

test.afterEach(async ({ page }, testInfo) => {
  // Hygiene: the key-bar tests open a shell and the server caps live PTYs, so
  // close it through the UI. Best effort: a failed test must keep its own error.
  try {
    if (
      !page.isClosed() &&
      (await page.getByRole('group', { name: 'Terminal keys' }).count()) > 0
    ) {
      await closeTerminal(page)
      await expect(page.getByRole('group', { name: 'Terminal keys' })).toHaveCount(0)
    }
  } catch {
    // the terminal is already gone
  }
  // Close the page first: a page that is still open warms a replacement for
  // the agent killed below. A failed test keeps its page for the failure report.
  if (testInfo.status === testInfo.expectedStatus) await page.close()
  for (const agentId of await serverAgentIds()) {
    if (agentsBeforeTest.has(agentId)) continue
    await wsRequest(E2E_BASE_URL, 'kill_agent', { agentId }).catch(() => {
      // already gone (closed by the test itself)
    })
  }
})

interface Project {
  id: string
  name: string
  path: string
}

/**
 * Register a throwaway project under the suite's workspace root and make it the
 * web client's active project, so the app boots straight into it. The name is
 * unique per call: chats and layouts persist per project id, so a reused id
 * would restore an earlier test's state. `files` are written into the project.
 */
async function registerProject(files: Record<string, string> = {}): Promise<Project> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-toastdock-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, file)), { recursive: true })
    await writeFile(join(path, file), content)
  }
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
  return { id, name, path }
}

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session, and that session
 * creation re-activates the pane. A terminal opened BEFORE it lands is swapped
 * out from under the key bar (a test-only race: a person needs seconds to
 * reach the drawer). An agent that fails to start also ends the warm-up.
 */
function watchAgentWarmup(page: Page): Promise<void> {
  return new Promise<void>((resolve) => {
    page.on('websocket', (socket) => {
      if (socket.url().endsWith('/terminal/ws')) return
      const watched = new Map<string, string>()
      socket.on('framesent', (frame) => {
        const message = JSON.parse(String(frame.payload)) as { id?: string; type?: string }
        if (message.id && (message.type === 'create_session' || message.type === 'spawn_agent')) {
          watched.set(message.id, message.type)
        }
      })
      socket.on('framereceived', (frame) => {
        const reply = JSON.parse(String(frame.payload)) as { id?: string; ok?: boolean }
        const kind = reply.id ? watched.get(reply.id) : undefined
        if (kind === 'create_session' || (kind === 'spawn_agent' && reply.ok === false)) resolve()
      })
    })
  })
}

/**
 * Sign in and land on the workspace root; the launcher names the fresh project.
 * `settleWarmup` is for tests that open a tab from the empty pane: the launcher
 * warm-up creates a draft session that re-activates the pane, which would swap
 * the tab out from under the test.
 */
async function bootWorkspace(
  page: Page,
  project: Project,
  opts: { settleWarmup?: boolean } = {}
): Promise<void> {
  const warmedUp = watchAgentWarmup(page)
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  await expect(
    page.getByRole('heading', { level: 1, name: `What should we do in ${project.name}?` })
  ).toBeVisible()
  if (opts.settleWarmup) await Promise.race([warmedUp, sleep(10_000)])
}

/**
 * Boot the shell on a fresh project and start a chat from the empty-pane
 * launcher. Resolves once the launcher has handed over to the chat.
 */
async function launchChat(
  page: Page,
  prompt: string,
  opts: { project?: Project; mouse?: boolean } = {}
): Promise<Project> {
  const project = opts.project ?? (await registerProject())
  const press = (target: Locator): Promise<void> => (opts.mouse ? target.click() : target.tap())
  await bootWorkspace(page, project)
  const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
  const start = page.getByRole('button', { name: 'Start agent chat' })
  // The launcher re-renders once its git probe settles, which drops focus and
  // any text typed before that, and Start stays disabled until the agent has
  // warmed up. Entering the prompt is idempotent (focus, select all, replace),
  // so retry it until Start enables instead of sleeping for a fixed time.
  await expect(async () => {
    await launcher.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(prompt)
    await expect(start).toBeEnabled({ timeout: 2_500 })
  }).toPass({ timeout: 40_000 })
  await press(start)
  await expect(launcher).toBeHidden()
  return project
}

/** The chat dock wrapper: the one element the chat reports to the toast stack. */
function chatDock(page: Page): Locator {
  return page.locator('[data-chat-dock="true"]')
}

function composerCard(page: Page): Locator {
  return page.locator('[data-chat-composer="true"]')
}

function chatEditor(page: Page): Locator {
  return composerCard(page).getByRole('textbox')
}

function permissionPrompt(page: Page): Locator {
  return page.getByRole('region', { name: 'Approval needed' })
}

function toastWith(page: Page, text: string | RegExp): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: text })
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no layout box (not rendered)')
  return box
}

/** The published `--mobile-dock-height` in px, or null while the property is absent. */
async function publishedClearance(page: Page): Promise<number | null> {
  return page.evaluate((name) => {
    const raw = document.documentElement.style.getPropertyValue(name)
    return raw === '' ? null : Number.parseFloat(raw)
  }, DOCK_VAR)
}

/**
 * Published clearance minus the real distance from the viewport bottom to the
 * element's top edge (the contract's `ceil(innerHeight - top)`), read in one
 * evaluation so the two never straddle a layout change. `'absent'` while the
 * property is not set, so a failing poll says which side was wrong.
 */
async function clearanceError(target: Locator): Promise<number | 'absent'> {
  return target.evaluate((el, name) => {
    const raw = document.documentElement.style.getPropertyValue(name)
    if (raw === '') return 'absent'
    const measured = Math.ceil(window.innerHeight - el.getBoundingClientRect().top)
    return Number.parseFloat(raw) - measured
  }, DOCK_VAR)
}

/**
 * How far the toast's bottom edge is from where the published clearance plus
 * the 12px gap puts it (the viewport bottom minus the offset). 0 once settled.
 * Without the property the offset falls back to the safe-area inset (0 in the
 * emulated phone), so the toast sits one gap above the viewport bottom.
 */
async function toastBottomError(toast: Locator): Promise<number> {
  return toast.evaluate(
    (el, args) => {
      const raw = document.documentElement.style.getPropertyValue(args.name)
      const clearance = raw === '' ? 0 : Number.parseFloat(raw)
      return el.getBoundingClientRect().bottom - (window.innerHeight - (clearance + args.gap))
    },
    { name: DOCK_VAR, gap: TOAST_GAP }
  )
}

/**
 * How long a toast has to slide in and settle. Toasts auto-dismiss after 4s, so
 * a poll that outlives that only ever reports a missing element; keep it short
 * enough that a wrong position fails with its numbers.
 */
const TOAST_SETTLE_MS = 3_000

/** The toast has slid in and rests where the published clearance puts it (within 1px). */
async function expectToastFollowsClearance(toast: Locator): Promise<void> {
  await expect
    .poll(async () => Math.abs(await toastBottomError(toast)), { timeout: TOAST_SETTLE_MS })
    .toBeLessThanOrEqual(1)
}

/** Gap between the toast's bottom edge and the given top edge (negative: they overlap). */
async function gapAbove(toast: Locator, topEdge: number): Promise<number> {
  const box = await boxOf(toast)
  return topEdge - (box.y + box.height)
}

/** Closes a toast through its own close button and waits until it is gone. */
async function dismissToast(toast: Locator): Promise<void> {
  await toast.locator('[data-close-button]').tap()
  await expect(toast).toHaveCount(0)
}

/**
 * The toast ends at least MIN_CLEARANCE above the top edge (a number, or a read
 * repeated on every poll for an edge that is still moving).
 */
async function expectToastClear(
  toast: Locator,
  topEdge: number | (() => Promise<number>)
): Promise<void> {
  await expect
    .poll(async () => gapAbove(toast, typeof topEdge === 'number' ? topEdge : await topEdge()), {
      timeout: TOAST_SETTLE_MS
    })
    .toBeGreaterThanOrEqual(MIN_CLEARANCE)
}

/** Polls `read` until it is within `tolerance` px of `target`. */
async function expectNear(
  read: () => Promise<number>,
  target: number,
  tolerance = 1
): Promise<void> {
  await expect.poll(async () => Math.abs((await read()) - target)).toBeLessThanOrEqual(tolerance)
}

/** A tap at the centre of the element reaches the element itself, not a toast over it. */
async function isReachable(control: Locator): Promise<boolean> {
  return control.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return hit !== null && (hit === el || el.contains(hit) || hit.closest('button') === el)
  })
}

/** The toast is still up while the control is checked, and a tap on the control reaches it. */
async function expectReachableUnder(
  toast: Locator,
  control: Locator,
  label: string
): Promise<void> {
  await expect(toast, `${label}: the toast is still up`).toBeVisible()
  expect(await isReachable(control), `${label} is reachable`).toBe(true)
}

/**
 * Raise the chat composer's unsupported-attachment toast through the "Add to
 * chat" sheet: the fake agent advertises no embedded context, so the composer
 * answers a chosen file with its capability toast.
 */
async function raiseAttachToast(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add to chat', includeHidden: true }).tap()
  const sheet = page.getByRole('dialog', { name: 'Add to chat' })
  await expect(sheet).toBeVisible()
  const chooserOpened = page.waitForEvent('filechooser')
  await sheet.getByRole('button', { name: 'Attach files', exact: true }).tap()
  const chooser = await chooserOpened
  await chooser.setFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello')
  })
  const toast = toastWith(page, UNSUPPORTED_TOAST)
  await expect(toast).toBeVisible()
  return toast
}

/**
 * Emulate the on-screen keyboard: the visual viewport reports `px` less height
 * than the layout viewport, which is what the chat panel's keyboard spacer reads.
 */
async function installFakeKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const vv = window.visualViewport
    if (!vv) return
    Object.defineProperty(vv, 'height', {
      configurable: true,
      get: () =>
        window.innerHeight - ((window as unknown as { __keyboardPx?: number }).__keyboardPx ?? 0)
    })
  })
}

async function setKeyboardHeight(page: Page, px: number): Promise<void> {
  await page.evaluate((height) => {
    ;(window as unknown as { __keyboardPx: number }).__keyboardPx = height
    window.visualViewport?.dispatchEvent(new Event('resize'))
  }, px)
}

// ---------------------------------------------------------------------------
// Chat dock
// ---------------------------------------------------------------------------

test('one-row composer: the variable is the distance to the dock top and the toast ends 12px above it', async ({
  page
}) => {
  await launchChat(page, `${LONG} one row`)
  const dock = chatDock(page)
  await expect(dock).toHaveCount(1)
  await expect(composerCard(page)).toBeVisible()
  // The wrapper holds the composer card.
  await expect(dock.locator('[data-chat-composer="true"]')).toHaveCount(1)

  // The variable is the distance from the viewport bottom to the dock's top...
  await expect.poll(() => clearanceError(dock)).toBe(0)
  // ...and the dock reaches the viewport bottom, so its own padding is inside it.
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')
  const dockBox = await boxOf(dock)
  expect(Math.abs(dockBox.y + dockBox.height - viewport.height)).toBeLessThanOrEqual(1)
  const clearance = await publishedClearance(page)
  expect(clearance).toBeGreaterThan((await boxOf(composerCard(page))).height)

  const toast = await raiseAttachToast(page)
  await expectToastFollowsClearance(toast)
  // The toast stack stays clear of the composer card and its toolbar row.
  const cardTop = (await boxOf(composerCard(page))).y
  await expectToastClear(toast, cardTop)
  // It keeps its width: the object offset only lifts the bottom edge.
  const toastBox = await boxOf(toast)
  expect(toastBox.x).toBeGreaterThanOrEqual(0)
  expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(viewport.width)
  expect(toastBox.width).toBeGreaterThan(300)
  // The published value did not move while the toast was up.
  await expect.poll(() => clearanceError(dock)).toBe(0)
})

test('an open approval grows the dock and the toast clears Allow and Reject', async ({ page }) => {
  await launchChat(page, '[DURATION:3] opening turn')
  await expect(page.locator('main')).toContainText('[DONE after')
  const dock = chatDock(page)
  await expect.poll(() => clearanceError(dock)).toBe(0)
  const baseline = await publishedClearance(page)
  if (baseline === null) throw new Error('the chat dock published no clearance')

  // A permission request arrives with the second turn: the prompt joins the dock.
  const editor = chatEditor(page)
  await editor.tap()
  await page.keyboard.insertText(`[ASK:permission] ${LONG} second turn`)
  await page.keyboard.press('Enter')
  const prompt = permissionPrompt(page)
  await expect(prompt).toBeVisible()
  await expect(dock.getByRole('region', { name: 'Approval needed' })).toBeVisible()

  // The variable follows the taller dock.
  await expect.poll(() => clearanceError(dock)).toBe(0)
  const grown = await publishedClearance(page)
  expect(grown).toBeGreaterThan(baseline)

  const toast = await raiseAttachToast(page)
  await expectToastFollowsClearance(toast)
  const options = prompt.getByRole('group', { name: 'Permission options' }).getByRole('button')
  await expect(options).toHaveText(['Always allow', 'Allow once', 'Reject'])
  const promptTop = (await boxOf(prompt)).y
  // The toast clears the prompt's top edge, so it covers none of its buttons...
  await expectToastClear(toast, promptTop)
  // ...and a tap on each option reaches the option, not the toast.
  for (let i = 0; i < 3; i++) {
    await expectReachableUnder(toast, options.nth(i), `option ${i}`)
  }
})

test('the changed-files bar and its expansion push the dock top up and the toast follows', async ({
  page
}) => {
  const project = await registerProject({
    'src/auth.ts': "export const authMarker = 'e2e-auth-file'"
  })
  await launchChat(page, `[DOCK] ${LONG} changed files`, { project })
  const dock = chatDock(page)
  const bar = dock.getByRole('button', { name: 'Changed files 3 +17 −2', exact: true })
  const git = dock.getByRole('button', { name: 'Open Git changes', exact: true })
  // The bar and the composer are both inside the one wrapper.
  await expect(bar).toBeVisible()
  await expect(dock.locator('[data-chat-composer="true"]')).toHaveCount(1)
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => clearanceError(dock)).toBe(0)
  const collapsed = await publishedClearance(page)
  if (collapsed === null) throw new Error('the chat dock published no clearance')

  // The dock's top is the bar's top, so the collapsed bar already sits above the plain composer.
  const barTop = (await boxOf(bar)).y
  const cardTop = (await boxOf(composerCard(page))).y
  expect(barTop).toBeLessThan(cardTop)
  const toast = await raiseAttachToast(page)
  await expectToastFollowsClearance(toast)
  await expectToastClear(toast, async () => (await boxOf(bar)).y)
  await expectReachableUnder(toast, git, 'the Git action')

  // Expanding the bar adds rows: the dock top moves up and the variable follows
  // in the same frame. A fresh toast then rests at the new, higher offset.
  await dismissToast(toast)
  await bar.tap()
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('button', { name: /src\/auth\.ts/ })).toBeVisible()
  await expect.poll(() => clearanceError(dock)).toBe(0)
  const expanded = await publishedClearance(page)
  expect(expanded).toBeGreaterThan(collapsed)
  const toastAgain = await raiseAttachToast(page)
  await expectToastFollowsClearance(toastAgain)
  await expectToastClear(toastAgain, async () => (await boxOf(bar)).y)
  await expectReachableUnder(toastAgain, git, 'the Git action')

  // Collapsing it gives the height back.
  await bar.tap()
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => publishedClearance(page)).toBe(collapsed)
  await expect.poll(() => clearanceError(dock)).toBe(0)
})

test('a queued prompt grows the dock and removing it gives the height back', async ({ page }) => {
  await launchChat(page, `${LONG} queue`)
  const dock = chatDock(page)
  await expect.poll(() => clearanceError(dock)).toBe(0)
  const empty = await publishedClearance(page)
  if (empty === null) throw new Error('the chat dock published no clearance')

  await chatEditor(page).tap()
  await page.keyboard.insertText('first queued note')
  await page.keyboard.press('Enter')
  const trigger = dock.getByRole('button', { name: '1 Queued', exact: true })
  await expect(trigger).toBeVisible()
  await expect.poll(() => clearanceError(dock)).toBe(0)
  const queued = await publishedClearance(page)
  expect(queued).toBeGreaterThan(empty)

  const toast = await raiseAttachToast(page)
  await expectToastFollowsClearance(toast)
  await expectToastClear(toast, async () => (await boxOf(trigger)).y)

  // Expanding the queue grows the dock again; removing the only row drops back.
  await trigger.tap()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => clearanceError(dock)).toBe(0)
  expect(await publishedClearance(page)).toBeGreaterThan(queued as number)
  await page.getByRole('button', { name: 'Remove from queue: first queued note' }).tap()
  await expect(page.getByRole('button', { name: /Queued/ })).toHaveCount(0)
  await expect.poll(() => publishedClearance(page)).toBe(empty)
})

test('an elicitation replaces the composer in the dock and its toast clears every button', async ({
  page
}) => {
  await launchChat(page, `[ASK:elicitation] ${LONG} elicitation`)
  const heading = page.getByRole('heading', { level: 2, name: 'Request from the agent' })
  await expect(heading).toBeVisible()
  const dock = chatDock(page)
  // The prompt branch fills the same wrapper: the composer is gone, the form is in.
  await expect(
    dock.getByRole('heading', { level: 2, name: 'Request from the agent' })
  ).toBeVisible()
  await expect(composerCard(page)).toHaveCount(0)
  await expect.poll(() => clearanceError(dock)).toBe(0)

  // Required field empty: the existing toast and an inline alert say the same thing.
  await page.getByRole('button', { name: 'Submit', exact: true }).tap()
  await expect(page.getByRole('alert')).toHaveText('branch is required.')
  const toast = toastWith(page, 'branch is required.')
  await expect(toast).toBeVisible()
  await expectToastFollowsClearance(toast)

  const promptTop = (await boxOf(page.locator('[data-approval-prompt^="elicitation:"]'))).y
  await expectToastClear(toast, promptTop)
  for (const name of ['Cancel', 'Decline', 'Submit']) {
    await expectReachableUnder(toast, page.getByRole('button', { name, exact: true }), name)
  }
})

test('the keyboard rising moves the dock up and the variable grows by the keyboard height', async ({
  page
}) => {
  await installFakeKeyboard(page)
  await launchChat(page, `${LONG} keyboard`)
  const dock = chatDock(page)
  await expect.poll(() => clearanceError(dock)).toBe(0)
  const closed = await publishedClearance(page)
  if (closed === null) throw new Error('the chat dock published no clearance')
  const topBefore = (await boxOf(dock)).y

  const keyboardPx = 300
  await setKeyboardHeight(page, keyboardPx)
  // The panel pads its bottom by the keyboard, so the dock moves up without
  // resizing itself; the parent's resize (or the visual-viewport event) re-measures.
  await expectNear(async () => topBefore - (await boxOf(dock)).y, keyboardPx)
  await expect.poll(() => clearanceError(dock)).toBe(0)
  await expect.poll(async () => (await publishedClearance(page)) ?? 0).toBe(closed + keyboardPx)

  const toast = await raiseAttachToast(page)
  await expectToastFollowsClearance(toast)
  await expectToastClear(toast, async () => (await boxOf(composerCard(page))).y)

  // The keyboard going away gives the height back.
  await setKeyboardHeight(page, 0)
  await expect.poll(() => publishedClearance(page)).toBe(closed)
  await expect.poll(() => clearanceError(dock)).toBe(0)
})

test('a chat hidden behind an editor tab releases the clearance and it returns with the chat', async ({
  page
}) => {
  const project = await registerProject({
    'src/auth.ts': "export const authMarker = 'e2e-auth-file'"
  })
  await launchChat(page, `[DOCK] ${LONG} hidden chat`, { project })
  const dock = chatDock(page)
  await expect.poll(() => clearanceError(dock)).toBe(0)

  // A changed-files row opens the file in an editor tab: the chat stays mounted
  // but is no longer visible, so it stops reporting its dock.
  await dock.getByRole('button', { name: 'Changed files 3 +17 −2', exact: true }).tap()
  await page.getByRole('button', { name: /src\/auth\.ts/ }).tap()
  await expect(page.getByText('e2e-auth-file')).toBeVisible()
  await expect.poll(() => publishedClearance(page)).toBeNull()
  await expect(dock).toHaveCount(1)

  // Back on the chat tab the dock reports itself again. The drawer opens on
  // Editors (the editor is active): switch it to Chats, then pick the chat.
  await page.getByRole('button', { name: 'Open menu' }).tap()
  const drawer = page.locator('#mobile-shell-drawer')
  await drawer
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: /^Chats/ })
    .tap()
  await drawer
    .getByRole('button', { name: /hidden chat/ })
    .first()
    .tap()
  await expect(composerCard(page)).toBeVisible()
  await expect.poll(() => clearanceError(dock)).toBe(0)
})

// ---------------------------------------------------------------------------
// No dock: editor tab
// ---------------------------------------------------------------------------

/**
 * A Windows termul-server lists directory entries with the canonical verbatim
 * prefix (`\\?\C:\...`) while the project root is the plain `C:\...`, so the
 * Files sheet cannot place an entry under its root there. A pre-existing
 * server path-format quirk outside this goal (a POSIX server never emits it):
 * strip the prefix from listings so the same assertions hold on every host.
 */
async function normalizeListingPaths(page: Page): Promise<void> {
  await page.route(/\/fs\/ls(\?|$)/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { success?: boolean; data?: Array<{ path?: string }> }
    if (body.success && Array.isArray(body.data)) {
      for (const entry of body.data) {
        if (typeof entry.path === 'string') entry.path = entry.path.replace(/^\\\\\?\\/, '')
      }
    }
    await route.fulfill({ response, json: body })
  })
}

test('with no dock on screen the property is absent and the toast sits 12px above the viewport bottom', async ({
  page
}) => {
  const project = await registerProject({ 'notes.md': '# Notes\n\nplain notes' })
  await normalizeListingPaths(page)
  await bootWorkspace(page, project, { settleWarmup: true })
  // The empty pane shows the launcher, which is a dock of its own.
  await expect.poll(() => publishedClearance(page)).not.toBeNull()

  // Open the file from the Files sheet (header ⋯ → Files → the file row).
  await page.getByRole('button', { name: 'More', exact: true }).tap()
  await page
    .getByRole('dialog', { name: 'Termul' })
    .getByRole('button', { name: 'Files', exact: true })
    .tap()
  const files = page.getByRole('dialog', { name: project.name })
  await files.getByRole('button', { name: 'Open notes.md', exact: true }).tap()
  await expect(files).toBeHidden()
  const save = page.getByRole('button', { name: 'Save notes.md', exact: true })
  await expect(save).toBeVisible()
  // The launcher is gone with the empty pane and nothing else registers.
  await expect.poll(() => publishedClearance(page)).toBeNull()
  await expect(page.locator('[data-chat-dock="true"]')).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Terminal keys' })).toHaveCount(0)

  // Edit the file and save it: the existing "saved" toast rises from the
  // safe-area fallback (0 in this emulation) plus the 12px gap.
  await page.getByRole('textbox').last().tap()
  await page.keyboard.insertText('edited ')
  await expect(save).toBeEnabled()
  await save.tap()
  const toast = toastWith(page, 'notes.md saved')
  await expect(toast).toBeVisible()
  await expect.poll(() => publishedClearance(page)).toBeNull()
  await expectToastFollowsClearance(toast)
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')
  await expectNear(async () => {
    const box = await boxOf(toast)
    return viewport.height - (box.y + box.height)
  }, TOAST_GAP)
})

// ---------------------------------------------------------------------------
// Agent launcher
// ---------------------------------------------------------------------------

test('the launcher composer column is a dock: the unsupported-attachment toast clears its controls', async ({
  page
}) => {
  const project = await registerProject()
  await bootWorkspace(page, project)
  const group = page.locator('[data-agent-launcher-composer-group]')
  await expect(group).toBeVisible()
  // The column is the group's parent: it also holds the context strip.
  const column = group.locator('xpath=..')
  // The workspace scales in at boot (an ancestor runs 0.977 to 1 over ~300ms), and
  // a transform moves a rect without a resize, so the hook can publish the value
  // of a frame mid-animation. The column sits higher mid-animation, so that value
  // is the larger one: the error is a few px at most and on the safe side (the
  // toast clears more, never less). Assert it never under-reports and stays
  // within a few px, instead of the exact match the later docks keep.
  await expect
    .poll(async () => {
      const error = await clearanceError(column)
      return error === 'absent' ? error : error >= 0 && error <= BOOT_ANIMATION_SLACK_PX
    })
    .toBe(true)

  const attach = page.getByRole('button', { name: 'Attach files' })
  const start = page.getByRole('button', { name: 'Start agent chat' })
  await expect(attach).toBeEnabled()
  const chooserOpened = page.waitForEvent('filechooser')
  await attach.tap()
  const chooser = await chooserOpened
  await chooser.setFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello')
  })
  const toast = toastWith(page, UNSUPPORTED_TOAST)
  await expect(toast).toBeVisible()
  await expectToastFollowsClearance(toast)

  const columnTop = (await boxOf(column)).y
  await expectToastClear(toast, columnTop)
  await expectReachableUnder(toast, attach, 'Attach files')
  // Start stays disabled with an empty prompt (a disabled button takes no hits),
  // so its clearance is a rect comparison.
  await expect(start).toBeDisabled()
  expect(await gapAbove(toast, (await boxOf(start)).y)).toBeGreaterThanOrEqual(MIN_CLEARANCE)
})

// ---------------------------------------------------------------------------
// Terminal key bar
// ---------------------------------------------------------------------------

/** Boot the shell on a fresh project and open a terminal; the key bar is the dock. */
async function openTerminalWithBar(page: Page): Promise<Locator> {
  const project = await registerProject()
  await bootWorkspace(page, project, { settleWarmup: true })
  // New terminal is the drawer's Terminals pill: switch the drawer to Terminals first.
  await page.getByRole('button', { name: 'Open menu' }).tap()
  const drawer = page.locator('#mobile-shell-drawer')
  await drawer
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: /^Terminals/ })
    .tap()
  await drawer.getByRole('button', { name: 'New terminal' }).tap()
  const group = page.getByRole('group', { name: 'Terminal keys' })
  await expect(group).toBeVisible()
  return group
}

/**
 * Close the active terminal through the header: ⋯ Terminal actions → Close
 * terminal → the existing confirm dialog's Close.
 */
async function closeTerminal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Terminal actions', exact: true }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Close terminal' }).tap()
  await page
    .locator('[data-sibling-dialog]')
    .getByRole('button', { name: 'Close', exact: true })
    .tap()
}

/** The bar root: the group's parent, which carries the border, padding and safe-area inset. */
function barRootOf(group: Locator): Locator {
  return group.locator('xpath=..')
}

test('the key bar is the dock: the Paste-failure toast ends 12px above the two-row bar and covers no key', async ({
  page,
  context
}) => {
  // No clipboard-read grant: the browser denies readText().
  await context.clearPermissions()
  const group = await openTerminalWithBar(page)
  const bar = barRootOf(group)
  const toggle = group.getByRole('button', { name: 'Show/hide key bar' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => clearanceError(bar)).toBe(0)
  const twoRows = await publishedClearance(page)
  if (twoRows === null) throw new Error('the key bar published no clearance')
  // The two-row bar is about 104px tall at 390px; it ends at the viewport bottom.
  expect(twoRows).toBeGreaterThan(96)
  expect(twoRows).toBeLessThan(120)

  await group.getByRole('button', { name: 'Paste', exact: true }).tap()
  const toast = toastWith(page, /^Clipboard read failed: /)
  await expect(toast).toBeVisible()
  await expectToastFollowsClearance(toast)
  const barTop = (await boxOf(bar)).y
  await expectToastClear(toast, barTop)
  // No key sits under the toast: each visible control takes the tap itself.
  const buttons = group.getByRole('button')
  const count = await buttons.count()
  expect(count).toBe(11)
  for (let i = 0; i < count; i++) {
    const name = (await buttons.nth(i).getAttribute('aria-label')) ?? 'Paste'
    await expectReachableUnder(toast, buttons.nth(i), name)
  }
})

test('collapsing the key bar re-measures the one-row bar and the toast follows it down', async ({
  page,
  context
}) => {
  await context.clearPermissions()
  const group = await openTerminalWithBar(page)
  const bar = barRootOf(group)
  const toggle = group.getByRole('button', { name: 'Show/hide key bar' })
  await expect.poll(() => clearanceError(bar)).toBe(0)
  const twoRows = await publishedClearance(page)
  if (twoRows === null) throw new Error('the key bar published no clearance')

  // One row: the toggle collapses the nine keys; the bar's height drops and so does the variable.
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(group.getByRole('button', { name: 'Tab', exact: true })).toBeHidden()
  await expect.poll(() => clearanceError(bar)).toBe(0)
  const oneRow = await publishedClearance(page)
  if (oneRow === null) throw new Error('the collapsed key bar published no clearance')
  expect(oneRow).toBeLessThan(twoRows)

  await group.getByRole('button', { name: 'Paste', exact: true }).tap()
  const toast = toastWith(page, /^Clipboard read failed: /)
  await expect(toast).toBeVisible()
  await expectToastFollowsClearance(toast)
  const barTop = (await boxOf(bar)).y
  await expectToastClear(toast, barTop)
  await expectReachableUnder(toast, toggle, 'the toggle')
  await expectReachableUnder(
    toast,
    group.getByRole('button', { name: 'Paste', exact: true }),
    'Paste'
  )

  // Expanding it again restores the two-row value.
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => publishedClearance(page)).toBe(twoRows)
  await expect.poll(() => clearanceError(bar)).toBe(0)
})

test('closing the terminal hands the clearance from the key bar to the launcher', async ({
  page
}) => {
  const group = await openTerminalWithBar(page)
  const bar = barRootOf(group)
  await expect.poll(() => clearanceError(bar)).toBe(0)

  await closeTerminal(page)
  await expect(page.getByRole('group', { name: 'Terminal keys' })).toHaveCount(0)
  // The empty pane shows the launcher again, a dock of its own: the value now
  // follows its composer column, not the closed bar.
  const column = page.locator('[data-agent-launcher-composer-group]').locator('xpath=..')
  await expect(column).toBeVisible()
  await expect.poll(() => clearanceError(column)).toBe(0)
})

// ---------------------------------------------------------------------------
// Desktop browser keeps the baseline
// ---------------------------------------------------------------------------

test.describe('desktop browser', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  })

  test('writes no variable, keeps the display: contents dock and the 20px toast offset', async ({
    page
  }) => {
    await launchChat(page, `${LONG} desktop`, { mouse: true })
    await expect(composerCard(page)).toBeVisible()
    await expect(chatDock(page)).toHaveCount(1)

    // The wrapper does not take part in the layout: the panel lays out as before.
    await expect(chatDock(page)).toHaveCSS('display', 'contents')
    expect(await publishedClearance(page)).toBeNull()

    // A toast keeps the desktop offset of 20px above the viewport bottom.
    const chooserOpened = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Attach files' }).click()
    const chooser = await chooserOpened
    await chooser.setFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello')
    })
    const toast = toastWith(page, UNSUPPORTED_TOAST)
    await expect(toast).toBeVisible()
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('no viewport')
    await expectNear(async () => {
      const box = await boxOf(toast)
      return viewport.height - (box.y + box.height)
    }, 20)
    expect(await publishedClearance(page)).toBeNull()
  })
})
