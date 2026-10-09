import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Terminal screen reader mode E2E (spec-mobile-terminal-screen-reader-mode,
 * L-28): a phone-sized browser drives the web client's mobile shell against a
 * REAL termul-server and a REAL PTY, and checks what jsdom cannot — the
 * Switch row in App Preferences at 390px, the setting travelling through the
 * server-side `settings/app` store (the web half of the shared persistence
 * facade), and a genuine xterm instance growing (or not growing) its
 * `.xterm-accessibility` tree depending on the setting at construction.
 *
 * Terminal OUTPUT is fed to the page as a server `data` frame on the
 * `/terminal/ws` wire (see `routeTerminalOutput`) instead of being produced by
 * the host shell: on Windows, with the harness' redirected stdio, cmd.exe
 * writes to the server's stdout rather than the PTY, so a shell echo never
 * reaches xterm there. Everything from the wire into xterm and its
 * accessibility tree is real.
 *
 * Not observable here, by design: what TalkBack / VoiceOver actually speak,
 * and whether typed characters are doubled on a real on-screen keyboard
 * (xterm.js #3467 / repo #267). That needs a physical device; the typing test
 * below only pins that a synthetic keyboard writes each character once.
 *
 * Every test registers its own project (fresh terminal layout) and resets the
 * server-side setting to its default around the run: `settings/app` is shared
 * by every spec on the one server, and a leaked "on" would put later suites'
 * terminals in screen reader mode.
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

const SETTINGS_KEY = 'settings/app'
const SWITCH_NAME = 'Screen reader mode'
const PREFERENCES_NAME = 'Application Preferences'
/** The line of terminal output the tests feed in and then look for. */
const OUTPUT_MARKER = 'srm-e2e-marker'

interface StoredBlob {
  _version?: number
  data?: Record<string, unknown>
}

/** The persisted app-settings object as the web client wrote it (or null). */
async function readStoredSettings(): Promise<Record<string, unknown> | null> {
  const reply = await wsRequest<{ value: StoredBlob | null }>(E2E_BASE_URL, 'store_read', {
    key: SETTINGS_KEY
  })
  return reply.value?.data ?? null
}

/**
 * Put the server-side setting in a known state without touching the UI. The
 * rest of the blob is preserved: the loader merges it over the defaults, and
 * nothing else about the stored settings matters to this suite.
 */
async function seedScreenReaderMode(enabled: boolean): Promise<void> {
  const current = (await readStoredSettings()) ?? {}
  await wsRequest(E2E_BASE_URL, 'store_write', {
    key: SETTINGS_KEY,
    value: { _version: 1, data: { ...current, terminalScreenReaderMode: enabled } }
  })
}

/**
 * The persistence write is debounced (500ms) in the page, so "the store
 * follows the switch" is polled against the server, never assumed.
 */
async function expectPersistedScreenReaderMode(expected: boolean): Promise<void> {
  await expect
    .poll(async () => (await readStoredSettings())?.terminalScreenReaderMode, { timeout: 15_000 })
    .toBe(expected)
}

/**
 * Register a throwaway project under the suite's workspace root and make it
 * the web client's active project, so the app boots straight into it. The
 * name is unique per call: terminal layouts persist per project id.
 */
async function registerActiveProject(): Promise<string> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-srm-${randomUUID().slice(0, 8)}`
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

/**
 * Collects what the page writes to the PTY over `/terminal/ws`. xterm's own
 * focus reports (`ESC [ I` / `ESC [ O`) are not input, so they are left out.
 */
function trackPtyWrites(page: Page): { sent: () => string[]; clear: () => void } {
  const writes: string[] = []
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/terminal/ws')) return
    socket.on('framesent', (frame) => {
      const message = JSON.parse(String(frame.payload)) as {
        type?: string
        payload?: { data?: string }
      }
      const data = message.payload?.data
      if (message.type !== 'write' || data === undefined) return
      if (data === '\u001b[I' || data === '\u001b[O') return
      writes.push(data)
    })
  })
  return { sent: () => [...writes], clear: () => writes.splice(0) }
}

interface BoundaryLog {
  level?: string
  source?: string
  message?: string
}

/**
 * The renderer's boundary logs for this setting, as the page POSTs them to the
 * server's `/log/frontend-error` route (the web half of `logFrontendError`).
 */
function trackBoundaryLogs(page: Page): () => BoundaryLog[] {
  const logs: BoundaryLog[] = []
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().endsWith('/log/frontend-error')) return
    const body = req.postDataJSON() as BoundaryLog | null
    if (body?.source === 'AppPreferences.terminalScreenReaderMode') logs.push(body)
  })
  return () => [...logs]
}

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session, and that session
 * creation re-activates the pane. A terminal opened BEFORE it lands is
 * swapped out from under the test (a test-only race: a person needs seconds
 * to reach the drawer). An agent that fails to start also ends the warm-up.
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

/** Boot the mobile shell into a fresh project and let the warm-up settle. */
async function bootMobileShell(page: Page): Promise<void> {
  const warmedUp = watchAgentWarmup(page)
  const projectName = await registerActiveProject()
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  // The header names the active project until a terminal takes over: seeing
  // it proves the shell booted into our fresh project.
  await expect(
    page.getByRole('heading', { level: 1, name: projectName, exact: true })
  ).toBeVisible()
  await warmedUp
}

/** Drawer -> Settings: the phone's way into App Preferences. */
async function openAppPreferences(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  await page.getByRole('button', { name: 'Settings', exact: true }).tap()
  const dialog = page.getByRole('dialog', { name: PREFERENCES_NAME })
  await expect(dialog).toBeVisible()
  return dialog
}

async function closeAppPreferences(page: Page): Promise<void> {
  await page.getByRole('button', { name: `Close ${PREFERENCES_NAME}` }).tap()
  await expect(page.getByRole('dialog', { name: PREFERENCES_NAME })).toBeHidden()
}

function screenReaderSwitch(dialog: Locator): Locator {
  return dialog.getByRole('switch', { name: SWITCH_NAME })
}

/** Drawer -> New terminal; resolves once the terminal's key bar is on screen. */
async function openNewTerminal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  await page.getByRole('button', { name: 'New terminal' }).tap()
  await expect(page.getByRole('group', { name: 'Terminal keys' })).toBeVisible()
}

/** xterm's accessibility container: present only in screen reader mode. */
function accessibilityTree(page: Page): Locator {
  return page.locator('.xterm-accessibility')
}

/**
 * Proxy `/terminal/ws` untouched, but remember which terminal the page
 * attached to so `write` can push a server `data` frame (the protocol's own
 * output frame) into it. Must be set up before the page opens its terminal
 * socket, i.e. before the first navigation.
 */
async function routeTerminalOutput(
  page: Page
): Promise<{ write: (text: string) => Promise<void> }> {
  let attachedTerminalId: string | null = null
  let push: ((frame: string) => void) | null = null
  await page.routeWebSocket(/\/terminal\/ws$/, (client) => {
    const server = client.connectToServer()
    push = (frame) => client.send(frame)
    client.onMessage((message) => {
      const frame = JSON.parse(String(message)) as {
        type?: string
        payload?: { terminalId?: string }
      }
      if (frame.type === 'attach' && typeof frame.payload?.terminalId === 'string') {
        attachedTerminalId = frame.payload.terminalId
      }
      server.send(message)
    })
    server.onMessage((message) => client.send(message))
  })
  return {
    write: async (text) => {
      await expect.poll(() => attachedTerminalId, { timeout: 15_000 }).not.toBeNull()
      push?.(
        JSON.stringify({
          type: 'data',
          terminalId: attachedTerminalId,
          data: Array.from(new TextEncoder().encode(text))
        })
      )
    }
  }
}

/**
 * Print the marker as a line of its own on the active terminal, retrying until
 * `isShown` passes. The page ignores a terminal's output until its spawn call
 * has returned, so the first attempt can race that window; each retry only
 * adds one more marker line.
 */
async function printOutputMarkerUntil(
  feed: { write: (text: string) => Promise<void> },
  isShown: () => Promise<void>
): Promise<void> {
  await expect(async () => {
    await feed.write(`

${OUTPUT_MARKER}

`)
    await isShown()
  }).toPass({ timeout: 20_000 })
}

test.beforeEach(async () => {
  await seedScreenReaderMode(false)
})

// Hygiene: every terminal test opens shells, and the server caps live PTYs
// (30 per process) — close ours. And always leave the shared server-side
// setting off, whatever the test did, so later specs build ordinary terminals.
test.afterEach(async ({ page }) => {
  try {
    const dialog = page.getByRole('dialog', { name: PREFERENCES_NAME })
    if (await dialog.isVisible()) {
      await page.getByRole('button', { name: `Close ${PREFERENCES_NAME}` }).tap()
      await expect(dialog).toBeHidden()
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const close = page.getByRole('button', { name: 'Close terminal' })
      if ((await close.count()) === 0) break
      await close.tap()
      await page
        .locator('[data-sibling-dialog]')
        .getByRole('button', { name: 'Close', exact: true })
        .tap()
      await expect(page.locator('[data-sibling-dialog]')).toBeHidden()
    }
  } finally {
    await seedScreenReaderMode(false)
  }
})

test('Screen reader mode is an off switch in Terminal Appearance, between Terminal Renderer and Preview', async ({
  page
}) => {
  await bootMobileShell(page)
  const dialog = await openAppPreferences(page)
  const toggle = screenReaderSwitch(dialog)

  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(toggle).not.toBeChecked()

  // The description is announced with the switch and carries the existing
  // "applies to new terminals" string plus the duplicate-input caveat.
  await expect(toggle).toHaveAccessibleDescription(/Changes apply to new terminals\./)
  await expect(toggle).toHaveAccessibleDescription(/Can repeat typed characters in some setups\./)

  // Order inside Terminal Appearance, in the DOM and on screen.
  const renderer = dialog.getByText('Terminal Renderer', { exact: true })
  const preview = dialog.getByText('Preview', { exact: true })
  const toggleHandle = await toggle.elementHandle()
  const rendererHandle = await renderer.elementHandle()
  const previewHandle = await preview.elementHandle()
  if (!toggleHandle || !rendererHandle || !previewHandle) throw new Error('rows not rendered')
  const domOrder = await page.evaluate(
    ([sw, before, after]) => ({
      afterRenderer: Boolean(before.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING),
      beforePreview: Boolean(sw.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING)
    }),
    [toggleHandle, rendererHandle, previewHandle]
  )
  expect(domOrder).toEqual({ afterRenderer: true, beforePreview: true })
  const rendererBox = await renderer.boundingBox()
  const toggleBox = await toggle.boundingBox()
  const previewBox = await preview.boundingBox()
  if (!rendererBox || !toggleBox || !previewBox) throw new Error('rows have no layout box')
  expect(toggleBox.y).toBeGreaterThan(rendererBox.y)
  expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(previewBox.y)

  // The row is a 44px-tall touch row that stays inside the 390px viewport.
  const row = toggle.locator('xpath=..')
  const rowBox = await row.boundingBox()
  if (!rowBox) throw new Error('row has no layout box')
  expect(rowBox.height).toBeGreaterThanOrEqual(44)
  expect(rowBox.x).toBeGreaterThanOrEqual(0)
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(390)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('tapping the switch or its label toggles it, and the store and boundary log follow each change', async ({
  page
}) => {
  const boundaryLogs = trackBoundaryLogs(page)
  await bootMobileShell(page)
  const dialog = await openAppPreferences(page)
  const toggle = screenReaderSwitch(dialog)
  await toggle.scrollIntoViewIfNeeded()

  // The label is wired to the switch: tapping the words turns it on.
  await dialog.getByText(SWITCH_NAME, { exact: true }).tap()
  await expect(toggle).toBeChecked()
  await expectPersistedScreenReaderMode(true)
  // One info boundary log per toggle, naming the new state.
  await expect.poll(() => boundaryLogs()).toHaveLength(1)
  expect(boundaryLogs()[0]).toMatchObject({
    level: 'info',
    source: 'AppPreferences.terminalScreenReaderMode',
    message: expect.stringContaining('enabled')
  })

  // Tapping the switch itself turns it back off and persists false.
  await toggle.tap()
  await expect(toggle).not.toBeChecked()
  await expectPersistedScreenReaderMode(false)
  await expect.poll(() => boundaryLogs()).toHaveLength(2)
  expect(boundaryLogs()[1]).toMatchObject({
    level: 'info',
    source: 'AppPreferences.terminalScreenReaderMode',
    message: expect.stringContaining('disabled')
  })
})

test('a persisted "on" survives a reload and the switch comes back checked', async ({ page }) => {
  await bootMobileShell(page)
  const dialog = await openAppPreferences(page)
  await screenReaderSwitch(dialog).tap()
  await expect(screenReaderSwitch(dialog)).toBeChecked()
  await expectPersistedScreenReaderMode(true)
  await closeAppPreferences(page)

  const warmedUpAgain = watchAgentWarmup(page)
  await page.reload()
  await warmedUpAgain

  const reopened = await openAppPreferences(page)
  const toggle = screenReaderSwitch(reopened)
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toBeChecked()
})

test('the settings search finds Screen reader mode by name, "talkback" and "voiceover"', async ({
  page
}) => {
  await bootMobileShell(page)
  const dialog = await openAppPreferences(page)
  const search = dialog.getByRole('textbox', { name: 'Search settings' })
  const results = dialog.getByRole('navigation', { name: 'Settings categories' })

  for (const query of ['screen reader', 'talkback', 'voiceover']) {
    await search.fill(query)
    const first = results.getByRole('button').first()
    // Result = the setting's label over its category.
    await expect(first).toContainText(SWITCH_NAME)
    await expect(first).toContainText('Terminal Appearance')
  }

  // Choosing the result scrolls the Terminal Appearance section into view.
  await results.getByRole('button').first().tap()
  await expect(dialog.getByRole('heading', { name: 'Terminal Appearance' })).toBeInViewport()
})

test('Reset to Defaults turns an enabled Screen reader mode back off', async ({ page }) => {
  await seedScreenReaderMode(true)
  await bootMobileShell(page)
  const dialog = await openAppPreferences(page)
  const toggle = screenReaderSwitch(dialog)
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toBeChecked()

  await dialog.getByRole('button', { name: 'Reset to Defaults' }).tap()
  await page
    .locator('[data-sibling-dialog]')
    .getByRole('button', { name: 'Reset', exact: true })
    .tap()

  await expect(toggle).not.toBeChecked()
  await expectPersistedScreenReaderMode(false)
})

test('with the default setting a new terminal builds no accessibility tree', async ({ page }) => {
  const feed = await routeTerminalOutput(page)
  await bootMobileShell(page)
  await openNewTerminal(page)

  // The output reaches the visible terminal screen, and there is no screen
  // reader tree beside it.
  await printOutputMarkerUntil(feed, () =>
    expect(page.locator('.xterm-rows')).toContainText(OUTPUT_MARKER, { timeout: 1_500 })
  )
  await expect(accessibilityTree(page)).toHaveCount(0)
})

test('turning the switch on makes the next new terminal expose its output as a readable list', async ({
  page
}) => {
  const feed = await routeTerminalOutput(page)
  await bootMobileShell(page)
  const dialog = await openAppPreferences(page)
  await screenReaderSwitch(dialog).tap()
  await expect(screenReaderSwitch(dialog)).toBeChecked()
  await expectPersistedScreenReaderMode(true)
  await closeAppPreferences(page)

  await openNewTerminal(page)
  const tree = accessibilityTree(page)
  await expect(tree).toHaveCount(1)
  // xterm's screen reader surface: a list of rows plus an assertive live region.
  await expect(tree.getByRole('list')).toHaveCount(1)
  await expect(tree.locator('[aria-live="assertive"]')).toHaveCount(1)

  // The output line is exposed as a list row of its own.
  const markerRows = tree
    .getByRole('listitem')
    .filter({ hasText: new RegExp(`^\\s*${OUTPUT_MARKER}\\s*$`) })
  await printOutputMarkerUntil(feed, () =>
    expect(markerRows.first()).toBeAttached({ timeout: 1_500 })
  )
})

test('a persisted "on" gives new terminals the tree on the phone shell, no gating on platform', async ({
  page
}) => {
  await seedScreenReaderMode(true)
  await bootMobileShell(page)
  await openNewTerminal(page)

  await expect(accessibilityTree(page)).toHaveCount(1)
  await expect(accessibilityTree(page).getByRole('list')).toHaveCount(1)
})

test('flipping the switch leaves an open terminal as it was built and only affects new ones', async ({
  page
}) => {
  await bootMobileShell(page)
  await openNewTerminal(page)
  // Built while the setting was off.
  await expect(accessibilityTree(page)).toHaveCount(0)

  const dialog = await openAppPreferences(page)
  await screenReaderSwitch(dialog).tap()
  await expect(screenReaderSwitch(dialog)).toBeChecked()
  await expectPersistedScreenReaderMode(true)
  await closeAppPreferences(page)

  // Same live terminal: not rebuilt, not given a tree.
  await expect(page.getByRole('group', { name: 'Terminal keys' })).toBeVisible()
  await expect(accessibilityTree(page)).toHaveCount(0)

  // A terminal opened afterwards is built with the setting on.
  await openNewTerminal(page)
  await expect(accessibilityTree(page).filter({ visible: true })).toHaveCount(1)
})

test('turning the switch off does not strip the tree from a terminal built while it was on', async ({
  page
}) => {
  await seedScreenReaderMode(true)
  await bootMobileShell(page)
  await openNewTerminal(page)
  await expect(accessibilityTree(page)).toHaveCount(1)

  const dialog = await openAppPreferences(page)
  await screenReaderSwitch(dialog).tap()
  await expect(screenReaderSwitch(dialog)).not.toBeChecked()
  await expectPersistedScreenReaderMode(false)
  await closeAppPreferences(page)

  await expect(page.getByRole('group', { name: 'Terminal keys' })).toBeVisible()
  await expect(accessibilityTree(page)).toHaveCount(1)
})

test('typing in a screen-reader-mode terminal writes each character to the PTY once', async ({
  page
}) => {
  await seedScreenReaderMode(true)
  const pty = trackPtyWrites(page)
  await bootMobileShell(page)
  await openNewTerminal(page)
  await expect(accessibilityTree(page)).toHaveCount(1)

  const input = page.getByRole('textbox', { name: 'Terminal input' })
  await input.focus()
  await expect(input).toBeFocused()
  pty.clear()

  await page.keyboard.type('abc')
  // A key-bar tap after the typing is a sentinel: anything doubled by the
  // accessibility path would land on the wire before the Tab does.
  await page
    .getByRole('group', { name: 'Terminal keys' })
    .getByRole('button', { name: 'Tab', exact: true })
    .tap()

  await expect.poll(() => pty.sent().join('')).toBe('abc\t')
})
