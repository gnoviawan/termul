import { randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page, WebSocket } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'
import { launchChat, openWorkspace } from './ui'

/**
 * Mobile overlay back stack E2E (spec-mobile-overlay-back-stack): a phone-sized
 * browser drives the web client's mobile shell and checks what jsdom cannot,
 * against REAL browser history:
 *
 * - every overlay opened on the phone shell takes exactly one history entry,
 *   so system back closes only the topmost overlay and never leaves the page;
 * - closing an overlay by its own control (the X, Cancel, Esc, the scrim)
 *   gives the entry back, so the next back press is a real back press;
 * - a swap in one tap (drawer to Settings, palette to a sub-modal, row actions
 *   to the delete confirm) keeps one entry;
 * - a drawer row or a chat launch that navigates leaves no dead press on the
 *   way back;
 * - the overlays a chat message hangs off (the external-link confirm, the image
 *   lightbox, the subagent details dialog) are on the stack too;
 * - a reload with an overlay open leaves a stale entry the shell steps off;
 * - a History API that throws (`pushState`) or drops a traversal (`back`) never
 *   breaks an overlay, and the retry stops after three misses;
 * - the desktop shell pushes and consumes nothing for these overlays.
 *
 * The browser's history is read through the Navigation API (`index` of the
 * current entry) plus `history.state`, the `termulOverlay` marker the app puts
 * on its sentinel entries. A system back is a real history traversal
 * (`page.goBack()`), the same thing Android's back button does. The Navigation
 * API is Chromium-only, which is the only engine this suite runs on.
 *
 * Every test registers its own project, so no layout or chat state is shared
 * with other suites. Chat content comes from the fake agent's `[RICH]` prompt
 * marker (tests/e2e/fake-longrun-agent.ts).
 *
 * Not covered here, by design: the SSH password prompt (it needs a reachable
 * SSH server; the unit tests drive it), a vetoed close (no overlay reachable
 * from the fake agent refuses its own close; the store tests drive it) and the
 * real Android hardware back key (`page.goBack()` is the same history
 * traversal, but not the OS gesture).
 */

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
})

test.setTimeout(90_000)

/**
 * The launcher's agent and model pill: a bottom sheet on the phone shell, a popover
 * on desktop. Found by role, which skips the copy mounted in a hidden pane.
 */
const AGENT_SELECTOR_PILL = 'Agent and model. Currently Fake Longrun'
const AGENT_SELECTOR_SHEET = 'Model and agent'

interface HistoryPosition {
  /** Index of the current entry in this tab's history (Navigation API). */
  index: number
  hash: string
  /** `termulOverlayDepth` of the current entry; 0 when it is not a sentinel. */
  sentinelDepth: number
}

/**
 * Register a throwaway project under the suite's workspace root and make it
 * the web client's active project, so the app boots straight into it. The name
 * is unique per call: layouts persist per project id.
 */
async function registerActiveProject(
  files: readonly string[] = []
): Promise<{ name: string; path: string }> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-ovl-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  for (const file of files) await writeFile(join(path, file), `${file}\n`)
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
  return { name, path }
}

/** Boot the mobile shell on a fresh project and return where history stands. */
async function bootMobileShell(
  page: Page,
  files: readonly string[] = []
): Promise<{ name: string; path: string; base: HistoryPosition }> {
  const project = await registerActiveProject(files)
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  // The header subtitle names the active project: seeing it proves the shell
  // booted into our fresh project.
  await expect(projectSubtitle(page)).toContainText(project.name)
  const base = await historyPosition(page)
  expect(base.hash).toBe('#/')
  expect(base.sentinelDepth).toBe(0)
  return { ...project, base }
}

const WARMUP_TIMEOUT_MS = 45_000

/** One websocket frame as JSON, or null for a binary or non-JSON frame. */
function parseFrame(payload: string | Buffer): { id?: string; type?: string; ok?: boolean } | null {
  try {
    const parsed: unknown = JSON.parse(String(payload))
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as { id?: string; type?: string; ok?: boolean })
      : null
  } catch {
    return null
  }
}

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session, and that session
 * creation re-activates the pane. A terminal opened BEFORE it lands is swapped
 * out from under the test (a test-only race: a person needs seconds to reach
 * the drawer). An agent that fails to start also ends the warm-up.
 */
function watchAgentWarmup(page: Page): Promise<void> {
  const warmup = new Promise<void>((resolve, reject) => {
    const cleanups: Array<() => void> = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (settle: () => void): void => {
      clearTimeout(timer)
      for (const cleanup of cleanups) cleanup()
      settle()
    }
    timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `watchAgentWarmup: the agent warm-up did not settle in ${WARMUP_TIMEOUT_MS}ms`
            )
          )
        ),
      WARMUP_TIMEOUT_MS
    )

    const onWebSocket = (socket: WebSocket): void => {
      if (socket.url().endsWith('/terminal/ws')) return
      const watched = new Map<string, string>()
      const onFrameSent = (frame: { payload: string | Buffer }): void => {
        const message = parseFrame(frame.payload)
        if (message?.id && (message.type === 'create_session' || message.type === 'spawn_agent')) {
          watched.set(message.id, message.type)
        }
      }
      const onFrameReceived = (frame: { payload: string | Buffer }): void => {
        const reply = parseFrame(frame.payload)
        const kind = reply?.id ? watched.get(reply.id) : undefined
        if (kind === 'create_session' || (kind === 'spawn_agent' && reply?.ok === false)) {
          finish(resolve)
        }
      }
      socket.on('framesent', onFrameSent)
      socket.on('framereceived', onFrameReceived)
      cleanups.push(() => {
        socket.off('framesent', onFrameSent)
        socket.off('framereceived', onFrameReceived)
      })
    }
    page.on('websocket', onWebSocket)
    cleanups.push(() => page.off('websocket', onWebSocket))
  })
  // A test that has not reached its `await` yet must not turn a late timeout
  // into an unhandled rejection; the `await` still sees the rejection.
  warmup.catch(() => undefined)
  return warmup
}

async function historyPosition(page: Page): Promise<HistoryPosition> {
  return page.evaluate(() => {
    const navigation = (window as unknown as { navigation: { currentEntry: { index: number } } })
      .navigation
    const state = history.state as { termulOverlay?: boolean; termulOverlayDepth?: number } | null
    return {
      index: navigation.currentEntry.index,
      hash: location.hash,
      sentinelDepth: state?.termulOverlay === true ? (state.termulOverlayDepth ?? 1) : 0
    }
  })
}

/** Poll until history reaches `expected` (a consume traversal is asynchronous). */
async function expectHistory(page: Page, expected: Partial<HistoryPosition>): Promise<void> {
  await expect.poll(() => historyPosition(page)).toMatchObject(expected)
}

/**
 * Let the back stack's coalesced reconcile (it runs on an animation frame) and
 * any history traversal it starts run before asserting that NOTHING changed.
 */
async function settleBackStack(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0
        const next = (): void => {
          frames += 1
          if (frames >= 4) resolve()
          else requestAnimationFrame(next)
        }
        requestAnimationFrame(next)
      })
  )
}

/** The phone's system back: a real history traversal, like Android's back key. */
async function pressSystemBack(page: Page): Promise<void> {
  await page.goBack()
}

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  await expect(page.getByRole('dialog', { name: 'Termul', exact: true })).toBeVisible()
}

/**
 * Open the drawer on its Chats section (it opens on the active tab's section,
 * Terminals from a terminal), where the New chat pill lives.
 */
async function openDrawerOnChats(page: Page): Promise<void> {
  await openDrawer(page)
  await page
    .locator('#mobile-shell-drawer')
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: /^Chats/ })
    .tap()
}

/**
 * The header subtitle button (project, branch, Local or Worktree): it names the
 * active project and opens the project sheet. Its accessible name ends in
 * "switch project".
 */
function projectSubtitle(page: Page): Locator {
  return page.getByRole('button', { name: /, switch project$/ })
}

/** Choose a row of the header ⋯ sheet (chat or tab context): Files, Command palette, ... */
async function chooseMoreRow(page: Page, row: string): Promise<void> {
  await page.getByRole('button', { name: 'More', exact: true }).tap()
  await page.getByRole('button', { name: row, exact: true }).tap()
}

/** Choose a row of the terminal ⋯ sheet (terminal context): Close terminal, ... */
async function chooseTerminalRow(page: Page, row: string): Promise<void> {
  await page.getByRole('button', { name: 'Terminal actions', exact: true }).tap()
  await page.getByRole('button', { name: row, exact: true }).tap()
}

/** The project sheet's "Add project" row: the phone shell's entry to the New project modal. */
async function openNewProjectModal(page: Page): Promise<void> {
  await projectSubtitle(page).tap()
  await page.getByRole('button', { name: 'Add project', exact: true }).tap()
}

/**
 * Start a chat from the launcher composer with the fake agent's `[RICH]`
 * marker: the turn answers at once with an external link, an image and a
 * subagent call, so the chat route is on top and its content is ready.
 * Resolves with where history stands once the chat route entry is on top.
 */
async function launchRichChat(page: Page, label: string): Promise<HistoryPosition> {
  const prompt = `[RICH] ${label}`
  await page.getByRole('textbox', { name: 'Agent prompt' }).tap()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  // The header names the open chat after its first prompt.
  await expect(page.getByRole('heading', { level: 1, name: prompt, exact: true })).toBeVisible()
  await settleBackStack(page)
  const position = await historyPosition(page)
  expect(position.hash).toMatch(/^#\/c\//)
  expect(position.sentinelDepth).toBe(0)
  return position
}

/** A real shell in the pane, so the pane has a tab and the launcher becomes an overlay. */
async function openTerminalTab(page: Page, warmedUp: Promise<void>): Promise<void> {
  await warmedUp
  await openDrawer(page)
  // New terminal is the drawer's Terminals pill: switch the drawer to Terminals first.
  const drawer = page.locator('#mobile-shell-drawer')
  await drawer
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: /^Terminals/ })
    .tap()
  await drawer.getByRole('button', { name: 'New terminal' }).tap()
  await expect(page.getByRole('button', { name: 'Terminal actions', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible()
}

// ---------------------------------------------------------------------------
// The chat drawer: one registered sheet, and the three ways to close it
// ---------------------------------------------------------------------------

test('system back closes the open drawer and leaves the page where it was', async ({ page }) => {
  const { base } = await bootMobileShell(page)

  await openDrawer(page)
  // One sentinel entry on top of the page entry.
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

  await pressSystemBack(page)

  await expect(page.getByRole('dialog', { name: 'Termul', exact: true })).toBeHidden()
  // Back landed on the page entry itself: same hash, no sentinel on top.
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

// The drawer is full-screen: there is no scrim to tap.
for (const method of ['its close button', 'Esc'] as const) {
  test(`closing the drawer by ${method} gives its history entry back, so the next back is a real back`, async ({
    page
  }) => {
    const { base } = await bootMobileShell(page)
    const drawer = page.getByRole('dialog', { name: 'Termul', exact: true })
    await openDrawer(page)
    await expectHistory(page, { index: base.index + 1, sentinelDepth: 1 })

    if (method === 'its close button') {
      await drawer.getByRole('button', { name: 'Close', exact: true }).tap()
    } else {
      await page.keyboard.press('Escape')
    }

    await expect(drawer).toBeHidden()
    // The sentinel was consumed by exactly one traversal: history is back on
    // the page entry, not stranded on a leftover sentinel.
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

    // The first back press now leaves the page entry for the one before it,
    // instead of being swallowed by a dead sentinel.
    await pressSystemBack(page)
    await expectHistory(page, { index: base.index - 1 })
  })
}

test('a drawer row that navigates leaves no dead back press on the way back', async ({ page }) => {
  const { base } = await bootMobileShell(page)

  await openDrawer(page)
  await page.getByRole('button', { name: 'Snapshots', exact: true }).tap()
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeVisible()
  // The route entry sits on top of the drawer's leftover sentinel.
  await expectHistory(page, { index: base.index + 2, hash: '#/snapshots', sentinelDepth: 0 })

  await pressSystemBack(page)

  // One back press reached the previous page: the skip traversal passed the
  // leftover sentinel instead of stopping on it.
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

// ---------------------------------------------------------------------------
// Swaps in one tap keep one history entry
// ---------------------------------------------------------------------------

test('drawer to Settings swaps in one tap: one entry, back closes Settings', async ({ page }) => {
  const { base } = await bootMobileShell(page)
  const settings = page.getByRole('dialog', { name: 'Application Preferences' })

  await openDrawer(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).tap()
  await expect(settings).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Termul', exact: true })).toBeHidden()
  await settleBackStack(page)
  // The drawer's sentinel now serves Settings: no traversal, no second push.
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

  await pressSystemBack(page)

  await expect(settings).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

test('closing Application Preferences by its close button consumes its entry', async ({ page }) => {
  const { base } = await bootMobileShell(page)
  const settings = page.getByRole('dialog', { name: 'Application Preferences' })

  await openDrawer(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).tap()
  await expect(settings).toBeVisible()

  await settings.getByRole('button', { name: 'Close Application Preferences' }).tap()

  await expect(settings).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

test('command palette to Change Color Theme and to Command History each swap one entry', async ({
  page
}) => {
  const { base } = await bootMobileShell(page)
  const suggestions = page.getByRole('listbox', { name: 'Suggestions' })

  // Change Color Theme: the palette closes and the picker opens in one tap.
  // (The header ⋯ sheet hands off to the palette in one tap too: one entry.)
  await chooseMoreRow(page, 'Command palette')
  await expect(suggestions).toBeVisible()
  await expectHistory(page, { index: base.index + 1, sentinelDepth: 1 })
  await page.getByRole('option', { name: /^Change Color Theme/ }).tap()
  const picker = page.getByRole('dialog', { name: 'Color theme picker' })
  await expect(picker).toBeVisible()
  await expect(suggestions).toBeHidden()
  await settleBackStack(page)
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })
  await pressSystemBack(page)
  await expect(picker).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

  // Command History: the same swap for the other palette sub-modal.
  await chooseMoreRow(page, 'Command palette')
  await expect(suggestions).toBeVisible()
  await page.getByRole('option', { name: /^Command History/ }).tap()
  const history = page.getByPlaceholder('Search commands...')
  await expect(history).toBeVisible()
  await expect(suggestions).toBeHidden()
  await settleBackStack(page)
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })
  await pressSystemBack(page)
  await expect(history).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

// ---------------------------------------------------------------------------
// The agent launcher and its agent and model sheet
// ---------------------------------------------------------------------------

test('an empty pane shows the launcher as the pane body, not as an overlay: no history entry', async ({
  page
}) => {
  const { base } = await bootMobileShell(page)
  const composer = page.getByRole('textbox', { name: 'Agent prompt' })
  await expect(composer).toBeVisible()

  await page.getByRole('button', { name: 'New chat' }).tap()

  await expect(composer).toBeVisible()
  await settleBackStack(page)
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

test('the agent selector sheet closes on back and on Esc, and focus returns to its pill', async ({
  page
}) => {
  const { base } = await bootMobileShell(page)
  const chip = page.getByRole('button', { name: AGENT_SELECTOR_PILL })
  const modal = page.getByRole('dialog', { name: AGENT_SELECTOR_SHEET })

  await chip.tap()
  await expect(modal).toBeVisible()
  await expectHistory(page, { index: base.index + 1, sentinelDepth: 1 })
  await pressSystemBack(page)
  await expect(modal).toBeHidden()
  await expect(chip).toBeFocused()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

  // Esc is handled by the modal itself; the entry still comes back.
  await chip.tap()
  await expect(modal).toBeVisible()
  await expectHistory(page, { index: base.index + 1, sentinelDepth: 1 })
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  await expect(chip).toBeFocused()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

test.describe('with a terminal tab open', () => {
  // Every test here opens a shell, and the server caps live PTYs (30 per
  // process). Close ours so this file never starves later specs of slots.
  test.afterEach(async ({ page }) => {
    try {
      const actions = page.getByRole('button', { name: 'Terminal actions', exact: true })
      if ((await actions.count()) === 0) return
      await chooseTerminalRow(page, 'Close terminal')
      await page
        .locator('[data-sibling-dialog]')
        .getByRole('button', { name: 'Close', exact: true })
        .tap()
      await expect(actions).toBeHidden()
    } catch {
      // The test already failed on this page; do not mask its error.
    }
  })

  test('the launcher is an overlay over a tab: back closes it, and Esc closes it with focus outside the editor', async ({
    page
  }) => {
    const warmedUp = watchAgentWarmup(page)
    const { base } = await bootMobileShell(page)
    await openTerminalTab(page, warmedUp)
    // The drawer's own entry was consumed when it closed.
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
    const launcher = page.getByRole('dialog', { name: 'Agent launcher' })

    // Drawer to launcher is a swap in one tap: still one entry.
    await openDrawerOnChats(page)
    await page.getByRole('button', { name: 'New chat', exact: true }).tap()
    await expect(launcher).toBeVisible()
    await settleBackStack(page)
    await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

    await pressSystemBack(page)
    await expect(launcher).toBeHidden()
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

    // Open it again; nothing in the launcher has focus (the editor does not
    // autofocus), so Esc reaches no handler of its own and the back stack
    // closes it.
    await openDrawerOnChats(page)
    await page.getByRole('button', { name: 'New chat', exact: true }).tap()
    await expect(launcher).toBeVisible()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await expect(launcher).toBeHidden()
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
  })

  test('the agent selector sheet over the launcher: back closes the sheet, then the launcher, then it is a real back', async ({
    page
  }) => {
    const warmedUp = watchAgentWarmup(page)
    const { base } = await bootMobileShell(page)
    await openTerminalTab(page, warmedUp)
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
    const launcher = page.getByRole('dialog', { name: 'Agent launcher' })
    const chip = page.getByRole('button', { name: AGENT_SELECTOR_PILL })
    const modal = page.getByRole('dialog', { name: AGENT_SELECTOR_SHEET })

    await openDrawerOnChats(page)
    await page.getByRole('button', { name: 'New chat', exact: true }).tap()
    await expect(launcher).toBeVisible()
    await chip.tap()
    await expect(modal).toBeVisible()
    // Two overlays, two entries.
    await expectHistory(page, { index: base.index + 2, sentinelDepth: 2 })

    await pressSystemBack(page)
    await expect(modal).toBeHidden()
    await expect(launcher).toBeVisible()
    await expect(chip).toBeFocused()
    await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

    await pressSystemBack(page)
    await expect(launcher).toBeHidden()
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

    // No overlay is left: the third back is the browser's, not ours.
    await pressSystemBack(page)
    await expectHistory(page, { index: base.index - 1 })
  })

  test('the close-terminal confirm is on the stack: back keeps the terminal, Cancel consumes the entry', async ({
    page
  }) => {
    const warmedUp = watchAgentWarmup(page)
    const { base } = await bootMobileShell(page)
    await openTerminalTab(page, warmedUp)
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
    // ConfirmDialog carries no role; `data-sibling-dialog` is the hook the app
    // itself uses to find an open confirm.
    const confirm = page.locator('[data-sibling-dialog]')
    const terminalActions = page.getByRole('button', { name: 'Terminal actions', exact: true })

    // The terminal ⋯ sheet hands off to the confirm in one tap: one entry.
    await chooseTerminalRow(page, 'Close terminal')
    await expect(confirm).toBeVisible()
    await expect(confirm.getByRole('heading', { name: 'Close Terminal' })).toBeVisible()
    await settleBackStack(page)
    await expectHistory(page, { index: base.index + 1, sentinelDepth: 1 })
    await pressSystemBack(page)
    await expect(confirm).toBeHidden()
    // Back cancelled the confirm: the terminal is still there.
    await expect(terminalActions).toBeVisible()
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

    await chooseTerminalRow(page, 'Close terminal')
    await expect(confirm).toBeVisible()
    await settleBackStack(page)
    await expectHistory(page, { index: base.index + 1, sentinelDepth: 1 })
    await confirm.getByRole('button', { name: 'Cancel' }).tap()
    await expect(confirm).toBeHidden()
    await expect(terminalActions).toBeVisible()
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
  })
})

// ---------------------------------------------------------------------------
// A chat: launching one from the launcher overlay, and the overlays in a message
// ---------------------------------------------------------------------------

test('launching a chat from the launcher overlay leaves no dead back press on the way back', async ({
  page
}) => {
  const warmedUp = watchAgentWarmup(page)
  await bootMobileShell(page)
  await warmedUp
  // A first chat gives the pane a tab, so the launcher is an overlay from now on.
  const first = await launchRichChat(page, 'first chat')

  await page.getByRole('button', { name: 'New chat' }).tap()
  const launcher = page.getByRole('dialog', { name: 'Agent launcher' })
  await expect(launcher).toBeVisible()
  await settleBackStack(page)
  // The header's New chat takes the app to the home route first, so the overlay's
  // entry sits on top of a route entry of its own.
  const opened = await historyPosition(page)
  expect(opened.sentinelDepth).toBe(1)
  expect(opened.index).toBeGreaterThan(first.index)

  // Launching closes the overlay and pushes the second chat's route entry on
  // top of the overlay's entry. No traversal may run: it would revert the route.
  const second = await launchRichChat(page, 'second chat')
  await expect(launcher).toBeHidden()
  expect(second.index).toBe(opened.index + 1)

  // One back press leaves the second chat: the closed launcher's leftover entry
  // is passed over instead of swallowing the press, so history lands on the
  // route entry beneath it, not on a stale overlay entry.
  await pressSystemBack(page)
  await expectHistory(page, { index: opened.index - 1, hash: opened.hash, sentinelDepth: 0 })
  await expect(launcher).toBeHidden()
})

test.describe('overlays inside a chat message', () => {
  test('the external link confirm: back closes it without opening the link, Cancel and Esc give its entry back', async ({
    page
  }) => {
    const warmedUp = watchAgentWarmup(page)
    await bootMobileShell(page)
    await warmedUp
    const chat = await launchRichChat(page, 'link confirm')
    const link = page.getByRole('button', { name: 'Example docs' })
    const confirm = page.getByRole('alertdialog', { name: 'Open external link?' })
    let popups = 0
    page.on('popup', () => {
      popups += 1
    })

    await link.tap()
    await expect(confirm).toBeVisible()
    await expectHistory(page, { index: chat.index + 1, hash: chat.hash, sentinelDepth: 1 })
    await pressSystemBack(page)
    await expect(confirm).toBeHidden()
    // Back closed the confirm and stayed in the chat.
    await expectHistory(page, { index: chat.index, hash: chat.hash, sentinelDepth: 0 })

    await link.tap()
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Cancel' }).tap()
    await expect(confirm).toBeHidden()
    await expectHistory(page, { index: chat.index, hash: chat.hash, sentinelDepth: 0 })

    await link.tap()
    await expect(confirm).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(confirm).toBeHidden()
    await expectHistory(page, { index: chat.index, hash: chat.hash, sentinelDepth: 0 })

    // Dismissing is never "Open": no window was opened along the way.
    expect(popups).toBe(0)
  })

  test('the image lightbox: back closes it and focus returns to the thumbnail, its close button gives the entry back', async ({
    page
  }) => {
    const warmedUp = watchAgentWarmup(page)
    await bootMobileShell(page)
    await warmedUp
    const chat = await launchRichChat(page, 'lightbox')
    const thumbnail = page.getByRole('button', { name: 'Open image: Image' })
    const lightbox = page.getByRole('dialog', { name: 'Image' })

    await thumbnail.tap()
    await expect(lightbox).toBeVisible()
    await expectHistory(page, { index: chat.index + 1, hash: chat.hash, sentinelDepth: 1 })
    await pressSystemBack(page)
    await expect(lightbox).toBeHidden()
    await expect(thumbnail).toBeFocused()
    await expectHistory(page, { index: chat.index, hash: chat.hash, sentinelDepth: 0 })

    await thumbnail.tap()
    await expect(lightbox).toBeVisible()
    await lightbox.getByRole('button', { name: 'Close image' }).tap()
    await expect(lightbox).toBeHidden()
    await expect(thumbnail).toBeFocused()
    await expectHistory(page, { index: chat.index, hash: chat.hash, sentinelDepth: 0 })
  })

  test('the subagent details dialog: back and Esc close it and give its entry back', async ({
    page
  }) => {
    const warmedUp = watchAgentWarmup(page)
    await bootMobileShell(page)
    await warmedUp
    const chat = await launchRichChat(page, 'subagent')
    // Tool calls sit behind the turn's "Worked for" disclosure.
    await page.getByRole('button', { name: /^Worked for/ }).tap()
    const row = page.getByRole('button', { name: 'Review the overlay change' })
    const details = page.getByRole('dialog', { name: 'Review the overlay change' })

    await row.tap()
    await expect(details).toBeVisible()
    await expectHistory(page, { index: chat.index + 1, hash: chat.hash, sentinelDepth: 1 })
    await pressSystemBack(page)
    await expect(details).toBeHidden()
    await expectHistory(page, { index: chat.index, hash: chat.hash, sentinelDepth: 0 })

    await row.tap()
    await expect(details).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(details).toBeHidden()
    await expectHistory(page, { index: chat.index, hash: chat.hash, sentinelDepth: 0 })
  })
})

// ---------------------------------------------------------------------------
// Files sheet: row actions, the delete confirm and a stack that unwinds in order
// ---------------------------------------------------------------------------

test('Files sheet, row actions, delete confirm: back unwinds one overlay per press and cancels the delete', async ({
  page
}) => {
  const { base, path } = await bootMobileShell(page, ['alpha.txt'])
  const files = page.getByRole('dialog', { name: /^proj-ovl-/ })
  const actions = page.getByRole('dialog', { name: 'alpha.txt' })
  const confirm = page.getByRole('alertdialog', { name: 'Delete alpha.txt' })

  // The header ⋯ sheet hands off to the Files sheet in one tap: one entry.
  await chooseMoreRow(page, 'Files')
  await expect(page.getByRole('button', { name: 'Actions for alpha.txt' })).toBeVisible()
  await settleBackStack(page)
  await expectHistory(page, { index: base.index + 1, sentinelDepth: 1 })

  await page.getByRole('button', { name: 'Actions for alpha.txt' }).tap()
  await expect(actions).toBeVisible()
  await expectHistory(page, { index: base.index + 2, sentinelDepth: 2 })

  // Row actions swap for the delete confirm in one tap: still two entries.
  await actions.getByRole('button', { name: 'Delete', exact: true }).tap()
  await expect(confirm).toBeVisible()
  await expect(actions).toBeHidden()
  await settleBackStack(page)
  await expectHistory(page, { index: base.index + 2, sentinelDepth: 2 })

  // First back closes only the confirm; the file is still listed and on disk.
  await pressSystemBack(page)
  await expect(confirm).toBeHidden()
  await expect(files).toBeVisible()
  await expect(page.getByRole('button', { name: 'Actions for alpha.txt' })).toBeVisible()
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })
  await access(join(path, 'alpha.txt'))

  // Second back closes the Files sheet.
  await pressSystemBack(page)
  await expect(files).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

  // The third back is no longer ours.
  await pressSystemBack(page)
  await expectHistory(page, { index: base.index - 1 })
})

test('Esc over the delete confirm closes only the confirm, and Cancel consumes its entry', async ({
  page
}) => {
  const { base, path } = await bootMobileShell(page, ['alpha.txt'])
  const files = page.getByRole('dialog', { name: /^proj-ovl-/ })
  const confirm = page.getByRole('alertdialog', { name: 'Delete alpha.txt' })

  await chooseMoreRow(page, 'Files')
  await page.getByRole('button', { name: 'Actions for alpha.txt' }).tap()
  await page
    .getByRole('dialog', { name: 'alpha.txt' })
    .getByRole('button', { name: 'Delete', exact: true })
    .tap()
  await expect(confirm).toBeVisible()
  await expectHistory(page, { index: base.index + 2, sentinelDepth: 2 })

  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(files).toBeVisible()
  // The confirm's entry came back; the Files sheet keeps its own.
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

  // Open the confirm again and use the visible Cancel button.
  await page.getByRole('button', { name: 'Actions for alpha.txt' }).tap()
  await page
    .getByRole('dialog', { name: 'alpha.txt' })
    .getByRole('button', { name: 'Delete', exact: true })
    .tap()
  await expect(confirm).toBeVisible()
  await expectHistory(page, { index: base.index + 2, sentinelDepth: 2 })
  await confirm.getByRole('button', { name: 'Cancel' }).tap()
  await expect(confirm).toBeHidden()
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })
  await access(join(path, 'alpha.txt'))
})

// ---------------------------------------------------------------------------
// New project: a custom modal, and the web-only directory picker above it
// ---------------------------------------------------------------------------

test('New project modal: back, Cancel and Esc each close it and give its entry back', async ({
  page
}) => {
  const { base } = await bootMobileShell(page)
  const modal = page.getByRole('heading', { name: 'Create New Project' })

  // Entry: the project sheet's "Add project" row (a swap in one tap), system back.
  await openNewProjectModal(page)
  await expect(modal).toBeVisible()
  await settleBackStack(page)
  await expectHistory(page, { index: base.index + 1, sentinelDepth: 1 })
  await pressSystemBack(page)
  await expect(modal).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

  // Its own Cancel button.
  await openNewProjectModal(page)
  await expect(modal).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).tap()
  await expect(modal).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

  // Esc.
  await openNewProjectModal(page)
  await expect(modal).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

test('the directory picker over New project: back closes the picker first, then the modal', async ({
  page
}) => {
  const { base } = await bootMobileShell(page)
  const modal = page.getByRole('heading', { name: 'Create New Project' })
  const picker = page.getByRole('heading', { name: 'Select Project Folder' })

  await openNewProjectModal(page)
  await expect(modal).toBeVisible()
  await page.getByRole('button', { name: 'Browse', exact: true }).tap()
  await expect(picker).toBeVisible()
  await expectHistory(page, { index: base.index + 2, sentinelDepth: 2 })

  await pressSystemBack(page)
  await expect(picker).toBeHidden()
  await expect(modal).toBeVisible()
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

  await pressSystemBack(page)
  await expect(modal).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

// ---------------------------------------------------------------------------
// Create snapshot modal, on the route a drawer row navigates to
// ---------------------------------------------------------------------------

test('Create Snapshot modal on the Snapshots page: back and Cancel close it without leaving the page', async ({
  page
}) => {
  const { base } = await bootMobileShell(page)
  const modal = page.getByRole('heading', { name: 'Create Snapshot' })

  await openDrawer(page)
  await page.getByRole('button', { name: 'Snapshots', exact: true }).tap()
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeVisible()
  await expectHistory(page, { index: base.index + 2, hash: '#/snapshots', sentinelDepth: 0 })

  await page.getByRole('button', { name: 'Create First Snapshot' }).tap()
  await expect(modal).toBeVisible()
  await expectHistory(page, { index: base.index + 3, hash: '#/snapshots', sentinelDepth: 1 })
  await pressSystemBack(page)
  await expect(modal).toBeHidden()
  // Back closed the modal and stayed on the Snapshots page.
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeVisible()
  await expectHistory(page, { index: base.index + 2, hash: '#/snapshots', sentinelDepth: 0 })

  await page.getByRole('button', { name: 'Create First Snapshot' }).tap()
  await expect(modal).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).tap()
  await expect(modal).toBeHidden()
  await expectHistory(page, { index: base.index + 2, hash: '#/snapshots', sentinelDepth: 0 })
})

// ---------------------------------------------------------------------------
// A stale sentinel, and a History API that misbehaves
// ---------------------------------------------------------------------------

test('a reload with an overlay open lands on a stale sentinel and the shell steps back off it', async ({
  page
}) => {
  const { name, base } = await bootMobileShell(page)
  await openDrawer(page)
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

  await page.reload()

  // The reloaded page has no overlay open, but the entry it reloaded on is a
  // leftover sentinel of ours: the shell traverses back to the page entry
  // instead of leaving it for a dead back press.
  await expect(projectSubtitle(page)).toContainText(name)
  await expect(page.getByRole('dialog', { name: 'Termul', exact: true })).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

test.describe('a History API that misbehaves', () => {
  /** What the shell logged under its own source, as the server received it. */
  function collectOverlayLogs(page: Page): string[] {
    const messages: string[] = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/log/frontend-error')) return
      try {
        const body = request.postDataJSON() as { source?: string; message?: string }
        if (body.source === 'overlay-stack') messages.push(body.message ?? '')
      } catch {
        // Not a JSON log line: not ours.
      }
    })
    return messages
  }

  function collectPageErrors(page: Page): Error[] {
    const errors: Error[] = []
    page.on('pageerror', (error) => errors.push(error))
    return errors
  }

  test('pushState throwing (an iOS rate cap) never breaks an overlay: it closes by its own control', async ({
    page
  }) => {
    const logs = collectOverlayLogs(page)
    const errors = collectPageErrors(page)
    await page.addInitScript(() => {
      History.prototype.pushState = () => {
        throw new DOMException('History rate cap', 'SecurityError')
      }
    })
    const { base } = await bootMobileShell(page)
    const drawer = page.getByRole('dialog', { name: 'Termul', exact: true })

    await openDrawer(page)
    await expect
      .poll(() => logs.some((message) => message.includes('history push failed')))
      .toBe(true)
    // No entry was pushed, and the drawer is open all the same.
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

    await drawer.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(drawer).toBeHidden()
    await settleBackStack(page)
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

    // Nothing was left armed, so back is the browser's.
    await pressSystemBack(page)
    await expectHistory(page, { index: base.index - 1 })
    expect(errors).toEqual([])
  })

  test('a consume traversal that never produces a popstate is retried, then given up on', async ({
    page
  }) => {
    const logs = collectOverlayLogs(page)
    const errors = collectPageErrors(page)
    // The app's own `history.back()` goes nowhere; the test's `page.goBack()`
    // is a browser-level traversal and is not affected.
    await page.addInitScript(() => {
      History.prototype.back = () => {}
    })
    const { base } = await bootMobileShell(page)
    const drawer = page.getByRole('dialog', { name: 'Termul', exact: true })
    const misses = (): number => logs.filter((message) => message.includes('no popstate')).length

    await openDrawer(page)
    await expectHistory(page, { index: base.index + 1, sentinelDepth: 1 })
    await drawer.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(drawer).toBeHidden()

    // Three misses of 1s each, then the shell stops asking.
    await expect.poll(misses, { timeout: 10_000 }).toBe(3)
    await page.waitForTimeout(2_500)
    expect(misses()).toBe(3)
    expect(errors).toEqual([])
    // The entry could not be consumed, so it is still ours and the overlay is closed.
    await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })
    await expect(drawer).toBeHidden()
  })
})

// ---------------------------------------------------------------------------
// Desktop shell: the mobile-only registrations are inert
// ---------------------------------------------------------------------------

test.describe('desktop shell', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  })

  /** A fresh project, so the pane is empty and no earlier suite's tabs are restored. */
  async function openFreshDesktopWorkspace(page: Page): Promise<void> {
    const warmedUp = watchAgentWarmup(page)
    await registerActiveProject()
    await openWorkspace(page)
    await warmedUp
  }

  /** Open an overlay, check it left no history behind, close it with Esc, check again. */
  async function expectInertOverlay(
    page: Page,
    open: () => Promise<void>,
    overlay: Locator
  ): Promise<void> {
    const before = await historyPosition(page)
    await open()
    await expect(overlay).toBeVisible()
    await settleBackStack(page)
    await expect(historyPosition(page)).resolves.toEqual(before)
    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()
    await settleBackStack(page)
    await expect(historyPosition(page)).resolves.toEqual(before)
  }

  test('New project modal, the theme picker and the agent selector push no history entry and traverse nothing', async ({
    page
  }) => {
    await openFreshDesktopWorkspace(page)

    await expectInertOverlay(
      page,
      () => page.getByRole('button', { name: 'Create new project from header' }).click(),
      page.getByRole('heading', { name: 'Create New Project' })
    )
    await expectInertOverlay(
      page,
      () => page.getByRole('button', { name: 'Color themes' }).click(),
      page.getByRole('dialog', { name: 'Color theme picker' })
    )
    await expectInertOverlay(
      page,
      () => page.getByRole('button', { name: AGENT_SELECTOR_PILL }).click(),
      page.getByTestId('agent-model-selector-panel')
    )
  })

  test('the external link confirm and the image lightbox push no history entry and traverse nothing', async ({
    page
  }) => {
    await openFreshDesktopWorkspace(page)
    await launchChat(page, '[RICH] desktop')
    await expect(page.getByRole('button', { name: 'Example docs' })).toBeVisible()

    await expectInertOverlay(
      page,
      () => page.getByRole('button', { name: 'Example docs' }).click(),
      page.getByRole('alertdialog', { name: 'Open external link?' })
    )
    await expectInertOverlay(
      page,
      () => page.getByRole('button', { name: 'Open image: Image' }).click(),
      page.getByRole('dialog', { name: 'Image' })
    )
  })
})
