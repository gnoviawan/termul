import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page, WebSocket, WebSocketRoute } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'
import { launchChat, openWorkspace } from './ui'

/**
 * Mobile back-stack tail E2E (spec-mobile-back-stack-tail, G11, L-31 to L-34):
 * a phone-sized browser drives the web client's mobile shell and checks, against
 * REAL browser history, what jsdom cannot:
 *
 * - the Restore and Delete snapshot modals are on the overlay stack: system back
 *   closes the modal, keeps the Snapshots route and leaves no sentinel behind;
 *   while a restore or delete is in flight, back leaves the modal open and a fresh
 *   entry is armed (the page's own guard vetoes the close);
 * - Esc closes one layer at a time: the directory picker over the New project
 *   modal, and the agent selector over the agent launcher overlay (on the phone
 *   and, because the guards are shell-independent, on the desktop shell too),
 *   while an Esc pressed as the project sheet animates out still closes New project;
 * - a route push while an overlay stays open re-arms the overlay's history
 *   entry, so ONE back press closes the overlay and keeps the route;
 * - crossing the mobile to desktop breakpoint with overlays open consumes the
 *   stranded entries once (no dead back press afterwards), and keeps one entry
 *   for an overlay that stays open on desktop;
 * - the desktop shell registers none of the new overlays and makes no history call.
 *
 * The browser's history is read through the Navigation API (`index` of the
 * current entry) plus `history.state`, the `termulOverlay` marker the app puts
 * on its sentinel entries. A system back is a real history traversal
 * (`page.goBack()`), the same thing Android's back button does. The Navigation
 * API is Chromium-only, which is the only engine this suite runs on.
 *
 * Every test registers its own project, so no layout, chat or snapshot state is
 * shared with other suites. Snapshots are seeded through the server's store
 * (the key the web client reads them from). Two tests hold a websocket reply
 * with `page.routeWebSocket` to keep an operation in flight on purpose.
 *
 * Not covered here, by design:
 * - What's New: the modal is gated behind `isTauriContext()` in the web app, so
 *   it cannot open on the mobile web shell (the Vitest suite drives it);
 * - the SSH editor's unsaved-changes confirm: it needs a reachable SSH server
 *   and an edited remote file (the Vitest suite drives it);
 * - the real Android back key, iOS Safari and Firefox (`page.goBack()` is the
 *   same history traversal but not the OS gesture; Chromium only).
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

/** The launcher's agent and model pill: a bottom sheet on the phone shell, a popover on desktop. */
const AGENT_SELECTOR_PILL = 'Agent and model. Currently Fake Longrun'
const AGENT_SELECTOR_SHEET = 'Model and agent'

/** A viewport the desktop shell takes over at (the phone breakpoint is 767px wide). */
const DESKTOP_VIEWPORT = { width: 1024, height: 768 } as const

interface HistoryPosition {
  /** Index of the current entry in this tab's history (Navigation API). */
  index: number
  hash: string
  /** `termulOverlayDepth` of the current entry; 0 when it is not a sentinel. */
  sentinelDepth: number
}

interface ProjectOptions {
  /** Names of snapshots to seed in the project's snapshot list. */
  snapshots?: readonly string[]
}

interface RegisteredProject {
  id: string
  name: string
  path: string
}

/**
 * Register a throwaway project under the suite's workspace root and make it
 * the web client's active project, so the app boots straight into it. The name
 * is unique per call: layouts and snapshot lists persist per project id.
 */
async function registerActiveProject(options: ProjectOptions = {}): Promise<RegisteredProject> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-tail-${randomUUID().slice(0, 8)}`
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
  if (options.snapshots && options.snapshots.length > 0) {
    const createdAt = new Date().toISOString()
    await wsRequest(E2E_BASE_URL, 'store_write', {
      key: `snapshots/${id}`,
      value: {
        _version: 1,
        data: {
          updatedAt: createdAt,
          snapshots: options.snapshots.map((snapshotName) => ({
            id: `snap-${randomUUID().slice(0, 8)}`,
            projectId: id,
            name: snapshotName,
            createdAt,
            terminals: [],
            activeTerminalId: null
          }))
        }
      }
    })
  }
  return { id, name, path }
}

/** Boot the mobile shell on a fresh project and return where history stands. */
async function bootMobileShell(
  page: Page,
  options: ProjectOptions = {}
): Promise<RegisteredProject & { base: HistoryPosition }> {
  const project = await registerActiveProject(options)
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

/** The project sheet's "Add project" row: the phone shell's entry to the New project modal. */
async function openNewProjectModal(page: Page): Promise<void> {
  await projectSubtitle(page).tap()
  await page.getByRole('button', { name: 'Add project', exact: true }).tap()
}

/** The drawer's Snapshots footer button: a route push to `/snapshots`. */
async function openSnapshotsPage(page: Page): Promise<void> {
  await openDrawer(page)
  await page.getByRole('button', { name: 'Snapshots', exact: true }).tap()
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeVisible()
}

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

// ---------------------------------------------------------------------------
// A websocket reply held on purpose, to keep an operation in flight
// ---------------------------------------------------------------------------

interface RelayFrame {
  id?: string
  type?: string
  payload?: { key?: unknown }
}

interface ReplyGate {
  /** From now on, hold the reply to every request the matcher accepts. */
  arm: () => void
  /** Deliver every held reply and stop holding. */
  release: () => void
  /** True while a reply is being held back. */
  isHolding: () => boolean
}

function parseRelayFrame(message: string | Buffer): RelayFrame | null {
  try {
    const parsed: unknown = JSON.parse(String(message))
    return parsed !== null && typeof parsed === 'object' ? (parsed as RelayFrame) : null
  } catch {
    return null
  }
}

/**
 * Proxy the page's `/ws` relay sockets (the app's store and ACP connections) and,
 * once armed, withhold the reply to every request `matches` accepts until
 * `release()`. Install it BEFORE the page opens its sockets (before `goto`).
 * The terminal socket (`/terminal/ws`) is left alone.
 */
async function installReplyGate(
  page: Page,
  matches: (frame: RelayFrame) => boolean
): Promise<ReplyGate> {
  let armed = false
  const heldIds = new Set<string>()
  const queued: Array<() => void> = []
  await page.routeWebSocket(
    (url) => url.pathname === '/ws',
    (client: WebSocketRoute) => {
      const server = client.connectToServer()
      client.onMessage((message) => {
        const frame = parseRelayFrame(message)
        if (armed && frame?.id !== undefined && matches(frame)) heldIds.add(frame.id)
        server.send(message)
      })
      server.onMessage((message) => {
        const frame = parseRelayFrame(message)
        if (frame?.id !== undefined && heldIds.has(frame.id)) {
          queued.push(() => client.send(message))
          return
        }
        client.send(message)
      })
      client.onClose((code, reason) => void server.close({ code, reason }))
      server.onClose((code, reason) => void client.close({ code, reason }))
    }
  )
  return {
    arm: () => {
      armed = true
    },
    release: () => {
      armed = false
      heldIds.clear()
      for (const deliver of queued.splice(0)) deliver()
    },
    isHolding: () => queued.length > 0 || heldIds.size > 0
  }
}

function isSnapshotStoreFrame(frame: RelayFrame, type: 'store_read' | 'store_write'): boolean {
  return (
    frame.type === type &&
    typeof frame.payload?.key === 'string' &&
    frame.payload.key.startsWith('snapshots/')
  )
}

// ---------------------------------------------------------------------------
// The launcher tests: wait for the boot warm-up, open a terminal tab
// ---------------------------------------------------------------------------

const WARMUP_TIMEOUT_MS = 45_000

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
        const message = parseRelayFrame(frame.payload)
        if (message?.id && (message.type === 'create_session' || message.type === 'spawn_agent')) {
          watched.set(message.id, message.type)
        }
      }
      const onFrameReceived = (frame: { payload: string | Buffer }): void => {
        const reply = parseRelayFrame(frame.payload) as (RelayFrame & { ok?: boolean }) | null
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
// L-31: the Restore and Delete snapshot modals are on the stack
// ---------------------------------------------------------------------------

for (const kind of ['Restore', 'Delete'] as const) {
  test(`${kind} Snapshot modal: back closes it, keeps the Snapshots page and leaves no entry behind`, async ({
    page
  }) => {
    const { base } = await bootMobileShell(page, { snapshots: ['Before refactor'] })
    const modal = page.getByRole('heading', { name: `${kind} Snapshot` })
    await openSnapshotsPage(page)
    // The route entry sits on top of the drawer's leftover entry.
    await expectHistory(page, { index: base.index + 2, hash: '#/snapshots', sentinelDepth: 0 })

    await page
      .getByRole('button', { name: kind === 'Restore' ? 'Restore' : 'Delete snapshot' })
      .tap()
    await expect(modal).toBeVisible()
    // One entry for the modal, on the Snapshots route.
    await expectHistory(page, { index: base.index + 3, hash: '#/snapshots', sentinelDepth: 1 })

    await pressSystemBack(page)

    await expect(modal).toBeHidden()
    // Back closed the modal and stayed on the page; nothing was restored or deleted.
    await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Before refactor' })).toBeVisible()
    await expectHistory(page, { index: base.index + 2, hash: '#/snapshots', sentinelDepth: 0 })

    // No sentinel is left: the next back leaves the page for the one before it
    // (the drawer's leftover entry below is stepped over, not stopped on).
    await pressSystemBack(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeHidden()
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
  })
}

test('Delete Snapshot modal in flight: back leaves it open and arms a fresh entry, then it closes when the delete lands', async ({
  page
}) => {
  const gate = await installReplyGate(page, (frame) => isSnapshotStoreFrame(frame, 'store_write'))
  const { base } = await bootMobileShell(page, { snapshots: ['Slow delete'] })
  const modal = page.getByRole('heading', { name: 'Delete Snapshot' })
  await openSnapshotsPage(page)
  await page.getByRole('button', { name: 'Delete snapshot' }).tap()
  await expect(modal).toBeVisible()
  await expectHistory(page, { index: base.index + 3, hash: '#/snapshots', sentinelDepth: 1 })

  // The delete's write to the store never answers: the delete stays in flight.
  gate.arm()
  await page.getByRole('button', { name: 'Delete', exact: true }).tap()
  await expect(page.getByRole('button', { name: 'Deleting...' })).toBeVisible()
  await expect.poll(() => gate.isHolding()).toBe(true)

  await pressSystemBack(page)

  // The page's guard vetoed the close: the modal stays and the entry is armed again.
  await expect(modal).toBeVisible()
  await expect(page.getByRole('button', { name: 'Deleting...' })).toBeVisible()
  await expectHistory(page, { index: base.index + 3, hash: '#/snapshots', sentinelDepth: 1 })

  gate.release()

  // The delete landed: the modal closes by itself and gives its entry back.
  await expect(modal).toBeHidden()
  await expect(page.getByRole('heading', { name: 'No snapshots yet' })).toBeVisible()
  await expectHistory(page, { index: base.index + 2, hash: '#/snapshots', sentinelDepth: 0 })
})

test('Restore Snapshot modal in flight: back leaves it open, and the restore that lands pushes the workspace route with no dead back press', async ({
  page
}) => {
  const gate = await installReplyGate(page, (frame) => isSnapshotStoreFrame(frame, 'store_read'))
  const { base } = await bootMobileShell(page, { snapshots: ['Slow restore'] })
  const modal = page.getByRole('heading', { name: 'Restore Snapshot' })
  await openSnapshotsPage(page)
  await page.getByRole('button', { name: 'Restore' }).tap()
  await expect(modal).toBeVisible()
  await expectHistory(page, { index: base.index + 3, hash: '#/snapshots', sentinelDepth: 1 })

  // The restore's read of the snapshot never answers: the restore stays in flight.
  // (The card's own Restore button is first in the page, the modal's is last.)
  gate.arm()
  await page.getByRole('button', { name: 'Restore', exact: true }).last().tap()
  await expect(page.getByRole('button', { name: 'Restoring...' })).toBeVisible()
  await expect.poll(() => gate.isHolding()).toBe(true)

  await pressSystemBack(page)

  await expect(modal).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restoring...' })).toBeVisible()
  await expectHistory(page, { index: base.index + 3, hash: '#/snapshots', sentinelDepth: 1 })

  gate.release()

  // The restore landed: the page navigates to the workspace and the modal is gone.
  await expect(modal).toBeHidden()
  await expectHistory(page, { hash: '#/' })
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeHidden()

  // One back press goes back to the Snapshots page: the modal's leftover entry
  // under the new route is stepped over, not stopped on.
  await pressSystemBack(page)
  await expectHistory(page, { index: base.index + 2, hash: '#/snapshots', sentinelDepth: 0 })
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeVisible()
})

// ---------------------------------------------------------------------------
// L-32: Esc closes one layer at a time
// ---------------------------------------------------------------------------

test('Esc over the directory picker closes only the picker, a second Esc closes New project', async ({
  page
}) => {
  const { base } = await bootMobileShell(page)
  const modal = page.getByRole('heading', { name: 'Create New Project' })
  const picker = page.getByRole('heading', { name: 'Select Project Folder' })

  await openNewProjectModal(page)
  await expect(modal).toBeVisible()
  // Browse keeps focus (the picker never takes it), so the Esc starts inside the modal.
  await page.getByRole('button', { name: 'Browse', exact: true }).tap()
  await expect(picker).toBeVisible()
  await expectHistory(page, { index: base.index + 2, hash: '#/', sentinelDepth: 2 })

  await page.keyboard.press('Escape')

  await expect(picker).toBeHidden()
  await expect(modal).toBeVisible()
  await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

  await page.keyboard.press('Escape')

  await expect(modal).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

test('Esc right after the project sheet hands off to New project still closes it', async ({
  page
}) => {
  const { base } = await bootMobileShell(page)
  const modal = page.getByRole('heading', { name: 'Create New Project' })

  await openNewProjectModal(page)
  await expect(modal).toBeVisible()
  // No wait on purpose: the project sheet is still animating out and prevents the
  // Esc it receives. That Esc is the modal's own, not one a layer above took.
  await page.keyboard.press('Escape')

  await expect(modal).toBeHidden()
  await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
})

test.describe('with a terminal tab open', () => {
  // Every test here opens a shell, and the server caps live PTYs (30 per
  // process). Close ours so this file never starves later specs of slots.
  test.afterEach(async ({ page }) => {
    try {
      const actions = page.getByRole('button', { name: 'Terminal actions', exact: true })
      if ((await actions.count()) === 0) return
      await page.getByRole('button', { name: 'Terminal actions', exact: true }).tap()
      await page.getByRole('button', { name: 'Close terminal', exact: true }).tap()
      await page
        .locator('[data-sibling-dialog]')
        .getByRole('button', { name: 'Close', exact: true })
        .tap()
      await expect(actions).toBeHidden()
    } catch {
      // The test already failed on this page; do not mask its error.
    }
  })

  test('Esc over the agent selector sheet closes only the sheet; Esc in the launcher hides the launcher', async ({
    page
  }) => {
    const warmedUp = watchAgentWarmup(page)
    const { base } = await bootMobileShell(page)
    await openTerminalTab(page, warmedUp)
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
    const launcher = page.getByRole('dialog', { name: 'Agent launcher' })
    const chip = page.getByRole('button', { name: AGENT_SELECTOR_PILL })
    const sheet = page.getByRole('dialog', { name: AGENT_SELECTOR_SHEET })

    await openDrawerOnChats(page)
    await page.getByRole('button', { name: 'New chat', exact: true }).tap()
    await expect(launcher).toBeVisible()
    await chip.tap()
    await expect(sheet).toBeVisible()
    await expectHistory(page, { index: base.index + 2, sentinelDepth: 2 })

    // The sheet is a portaled layer: its Esc must not reach the launcher below it.
    await page.keyboard.press('Escape')

    await expect(sheet).toBeHidden()
    await expect(launcher).toBeVisible()
    await expect(chip).toBeFocused()
    await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

    // Focus is on the pill, inside the launcher: a plain Esc hides the launcher, once.
    await page.keyboard.press('Escape')

    await expect(launcher).toBeHidden()
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
    // No overlay is left: the next back is the browser's.
    await pressSystemBack(page)
    await expectHistory(page, { index: base.index - 1 })
  })

  test('Esc in the launcher composer hides the launcher once and gives its entry back', async ({
    page
  }) => {
    const warmedUp = watchAgentWarmup(page)
    const { base } = await bootMobileShell(page)
    await openTerminalTab(page, warmedUp)
    const launcher = page.getByRole('dialog', { name: 'Agent launcher' })

    await openDrawerOnChats(page)
    await page.getByRole('button', { name: 'New chat', exact: true }).tap()
    await expect(launcher).toBeVisible()
    await settleBackStack(page)
    await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

    // Focus in the composer: the launcher's own key handler takes this Esc.
    await launcher.getByRole('textbox', { name: 'Agent prompt' }).tap()
    await page.keyboard.press('Escape')

    await expect(launcher).toBeHidden()
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
  })
})

// ---------------------------------------------------------------------------
// L-33: a route push while an overlay stays open
// ---------------------------------------------------------------------------

test('a route pushed under an open drawer re-arms its entry: one back closes the drawer and keeps the route', async ({
  page
}) => {
  const logs = collectOverlayLogs(page)
  // A chat launched without a prepared session opens on a placeholder route, and
  // pushes the real session's route once the agent has created it. Hold that reply
  // (the boot warm-up's included, so nothing is prepared) to open the drawer in
  // between: the route push then lands while the drawer is open.
  const gate = await installReplyGate(page, (frame) => frame.type === 'create_session')
  gate.arm()
  const { base } = await bootMobileShell(page)
  const drawer = page.getByRole('dialog', { name: 'Termul', exact: true })

  // The launcher is still settling (no warm-up can be waited for with its reply
  // held): a remount can swallow the text, so type until the Start button takes it.
  // Focus, not a tap: a second tap on selected text raises the browser's own
  // selection menu over the page.
  const composer = page.getByRole('textbox', { name: 'Agent prompt' })
  const start = page.getByRole('button', { name: 'Start agent chat' })
  await expect(async () => {
    await composer.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('[RICH] adopt')
    await expect(start).toBeEnabled({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Chat' })).toBeVisible()
  await expect.poll(() => gate.isHolding()).toBe(true)
  await settleBackStack(page)
  const placeholder = await historyPosition(page)
  expect(placeholder.hash).toMatch(/^#\/c\/launch-/)
  expect(placeholder.index).toBe(base.index + 1)

  await openDrawer(page)
  await expectHistory(page, {
    index: placeholder.index + 1,
    hash: placeholder.hash,
    sentinelDepth: 1
  })

  gate.release()

  // The adopted session's route lands on top of the drawer's entry (a route push
  // fires no popstate), and the drawer is still open: its entry is re-armed on the
  // new route entry within a frame.
  await expect.poll(async () => (await historyPosition(page)).hash).not.toBe(placeholder.hash)
  const adopted = (await historyPosition(page)).hash
  expect(adopted).toMatch(/^#\/c\//)
  await expectHistory(page, { index: placeholder.index + 3, hash: adopted, sentinelDepth: 1 })
  await expect(drawer).toBeVisible()
  await expect
    .poll(() =>
      logs.some((message) =>
        message.includes(
          'Route changed with 1 overlay(s) open: re-arming overlay history sentinels (depth 0 -> 1)'
        )
      )
    )
    .toBe(true)

  // One back press closes the drawer and keeps the new route: it did not land on
  // the stale entry under the route, which would have left the drawer open.
  await pressSystemBack(page)

  await expect(drawer).toBeHidden()
  await expectHistory(page, { index: placeholder.index + 2, hash: adopted, sentinelDepth: 0 })
})

// ---------------------------------------------------------------------------
// L-34: crossing the breakpoint to desktop with overlays open
// ---------------------------------------------------------------------------

test.describe('the viewport crosses to the desktop shell', () => {
  test('two overlays open: their stranded entries are consumed once, and the next back is a real back', async ({
    page
  }) => {
    const logs = collectOverlayLogs(page)
    const errors = collectPageErrors(page)
    const { base } = await bootMobileShell(page)
    const modal = page.getByRole('heading', { name: 'Create New Project' })
    const picker = page.getByRole('heading', { name: 'Select Project Folder' })

    await openNewProjectModal(page)
    await page.getByRole('button', { name: 'Browse', exact: true }).tap()
    await expect(picker).toBeVisible()
    await expectHistory(page, { index: base.index + 2, hash: '#/', sentinelDepth: 2 })

    await page.setViewportSize(DESKTOP_VIEWPORT)

    // Both registrations were mobile-only: one traversal takes history back to the
    // page entry, and the route did not change.
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
    await expect
      .poll(() =>
        logs.some((message) =>
          message.includes(
            'Breakpoint crossed to desktop: consuming 2 stranded overlay history sentinel(s) (0 overlay(s) still registered)'
          )
        )
      )
      .toBe(true)
    await settleBackStack(page)
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

    // Neither layer was closed by the cleanup: both are plain desktop modals now,
    // and Esc closes one layer at a time without touching history.
    await expect(picker).toBeVisible()
    await expect(modal).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
    await expect(modal).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    await settleBackStack(page)
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })

    // The next back is the browser's: no dead press on a stranded entry.
    await pressSystemBack(page)
    await expectHistory(page, { index: base.index - 1 })
    expect(errors).toEqual([])
  })

  test('a cleanup traversal the browser drops once is retried and lands', async ({ page }) => {
    const logs = collectOverlayLogs(page)
    const errors = collectPageErrors(page)
    // The first `history.go` of the page goes nowhere (no popstate follows); later
    // ones are the browser's own. The test's `page.goBack()` is not affected.
    await page.addInitScript(() => {
      const realGo = History.prototype.go
      let calls = 0
      History.prototype.go = function go(this: History, delta?: number): void {
        calls += 1
        if (calls > 1) realGo.call(this, delta)
      }
    })
    const { base } = await bootMobileShell(page)

    await openNewProjectModal(page)
    await page.getByRole('button', { name: 'Browse', exact: true }).tap()
    await expect(page.getByRole('heading', { name: 'Select Project Folder' })).toBeVisible()
    await expectHistory(page, { index: base.index + 2, hash: '#/', sentinelDepth: 2 })

    await page.setViewportSize(DESKTOP_VIEWPORT)

    // The lost traversal is logged, retried, and the entries are consumed in the end.
    await expectHistory(page, { index: base.index, hash: '#/', sentinelDepth: 0 })
    expect(
      logs.filter((message) => message.includes('produced no popstate within 1000ms (miss 1)'))
    ).toHaveLength(1)
    expect(errors).toEqual([])
  })

  test('a cleanup traversal that throws is logged and never breaks the page', async ({ page }) => {
    const logs = collectOverlayLogs(page)
    const errors = collectPageErrors(page)
    await page.addInitScript(() => {
      History.prototype.go = () => {
        throw new DOMException('History traversal blocked', 'SecurityError')
      }
    })
    const { base } = await bootMobileShell(page)
    const modal = page.getByRole('heading', { name: 'Create New Project' })
    const picker = page.getByRole('heading', { name: 'Select Project Folder' })

    await openNewProjectModal(page)
    await page.getByRole('button', { name: 'Browse', exact: true }).tap()
    await expect(picker).toBeVisible()

    await page.setViewportSize(DESKTOP_VIEWPORT)

    await expect
      .poll(() => logs.some((message) => message.includes('Overlay history traversal failed')))
      .toBe(true)
    await settleBackStack(page)
    // The entries could not be consumed, and nothing else moved.
    await expectHistory(page, { index: base.index + 2, hash: '#/', sentinelDepth: 2 })
    // The overlays are plain desktop modals: they still close by Esc, one layer at a time.
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    expect(errors).toEqual([])
  })

  test('an overlay that stays open on desktop keeps its entry: no history call, and one back closes it', async ({
    page
  }) => {
    const logs = collectOverlayLogs(page)
    const { base } = await bootMobileShell(page)
    const settings = page.getByRole('dialog', { name: 'Application Preferences' })

    await openDrawer(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).tap()
    await expect(settings).toBeVisible()
    await settleBackStack(page)
    await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })

    await page.setViewportSize(DESKTOP_VIEWPORT)
    await settleBackStack(page)

    // Settings is not mobile-only: it is still open on desktop, and keeps its one entry.
    await expect(settings).toBeVisible()
    await expectHistory(page, { index: base.index + 1, hash: '#/', sentinelDepth: 1 })
    expect(logs.filter((message) => message.includes('Breakpoint crossed'))).toEqual([])

    // The desktop back handler closes the open overlay with that entry, and the
    // route is untouched. (What the desktop handler leaves behind afterwards is the
    // legacy re-arm hazard the spec defers, so history is not asserted past this.)
    await pressSystemBack(page)
    await expect(settings).toBeHidden()
    expect((await historyPosition(page)).hash).toBe('#/')
  })
})

// ---------------------------------------------------------------------------
// Desktop shell: the new registrations are inert, the Esc guards still hold
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
  async function openFreshDesktopWorkspace(
    page: Page,
    options: ProjectOptions = {}
  ): Promise<void> {
    const warmedUp = watchAgentWarmup(page)
    await registerActiveProject(options)
    await openWorkspace(page)
    await warmedUp
  }

  test('the Restore and Delete snapshot modals push no history entry and traverse nothing', async ({
    page
  }) => {
    await openFreshDesktopWorkspace(page, { snapshots: ['Desktop snapshot'] })
    await page.goto(`${E2E_BASE_URL}/#/snapshots`)
    await expect(page.getByRole('heading', { level: 1, name: /Workspace Snapshots/ })).toBeVisible()
    const before = await historyPosition(page)

    for (const [opener, modal] of [
      [
        page.getByRole('button', { name: 'Restore' }),
        page.getByRole('heading', { name: 'Restore Snapshot' })
      ],
      [page.getByTitle('Delete'), page.getByRole('heading', { name: 'Delete Snapshot' })]
    ] as const) {
      await opener.click()
      await expect(modal).toBeVisible()
      await settleBackStack(page)
      await expect(historyPosition(page)).resolves.toEqual(before)
      await page.keyboard.press('Escape')
      await expect(modal).toBeHidden()
      await settleBackStack(page)
      await expect(historyPosition(page)).resolves.toEqual(before)
    }
  })

  test('Esc over the directory picker closes only the picker, a second Esc closes New project', async ({
    page
  }) => {
    await openFreshDesktopWorkspace(page)
    const before = await historyPosition(page)
    const modal = page.getByRole('heading', { name: 'Create New Project' })
    const picker = page.getByRole('heading', { name: 'Select Project Folder' })

    await page.getByRole('button', { name: 'Create new project from header' }).click()
    await expect(modal).toBeVisible()
    await page.getByRole('button', { name: 'Browse', exact: true }).click()
    await expect(picker).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
    await expect(modal).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    await settleBackStack(page)
    await expect(historyPosition(page)).resolves.toEqual(before)
  })

  test('Esc over the agent selector popover closes only the popover, the launcher stays open', async ({
    page
  }) => {
    await openFreshDesktopWorkspace(page)
    // A first chat gives the pane a tab, so the launcher is an overlay from now on.
    await launchChat(page, '[RICH] desktop esc')
    const launcher = page.getByRole('dialog', { name: 'Agent launcher' })
    const panel = page.getByTestId('agent-model-selector-panel')

    await page.getByRole('button', { name: 'New agent chat' }).first().click()
    await expect(launcher).toBeVisible()
    await page.getByRole('button', { name: AGENT_SELECTOR_PILL }).click()
    await expect(panel).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(panel).toBeHidden()
    await expect(launcher).toBeVisible()
  })
})
