import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Locator, Page, WebSocketRoute } from 'playwright/test'
import { chromium, expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'
import { openWorkspace } from './ui'

/**
 * Mobile drawer and Files sheet gaps E2E (spec-mobile-drawer-and-files-gaps,
 * triage G5): a phone-sized browser drives the web client's mobile shell and
 * checks what jsdom cannot, against a real layout, a real overlay stack and a
 * real focus model.
 *
 * Covered here (the spec's L-15, L-16, L-18, L-20, L-35, V-12, V-13):
 * - L-15  the drawer's footer Git history, the Terminals New terminal pill, the
 *         header New terminal, the more-sheet New terminal and a file opened
 *         from Files leave /snapshots for `/`; on `/` and `/c/<id>` the route is
 *         left alone.
 * - L-16  a drawer close that raises a confirm (terminal, dirty editor) hands
 *         the drawer off, the confirm is tappable, and Cancel, Esc, Close and
 *         Discard leave focus on the menu button; a clean editor keeps the
 *         drawer open.
 * - L-18  closing a section row or ending a rename keeps focus inside the drawer.
 * - L-20  the Files breadcrumb on a Windows-hosted termul-server, whose
 *         listings carry the verbatim `\\?\C:\...` prefix (no response shim).
 * - L-35  a fully clipped breadcrumb ancestor leaves the tab order.
 * - V-12  the drawer footer reads `Connected · {host}` (the StatusBar lamp keeps
 *         its own "Connected").
 * - V-13  the bottom project sheet's "Set as host default" control.
 * - V-14  the drawer search filters the Recents chat list only, and the
 *         Editors list has no search at all.
 *
 * Not automated here, and why: L-17 (the canvas row): the phone shell has no
 * way to open a canvas (the palette hides it there and the workspace manifest
 * never restores one), so a canvas row cannot be produced in a browser; the
 * Vitest suites of MobileDrawerSectionList own it. The UNC form of L-20
 * (`//?/UNC/...`) needs a UNC share, so the unit tests of
 * lib/mobile-file-paths own it. Hand-off with the Close confirm switched off
 * is a host-wide setting, so it stays with the WorkspaceLayout Vitest suite.
 *
 * Every test registers its own project (fresh workspace, no state shared with
 * other suites) and closes the terminals it opens.
 */

/**
 * Playwright's bundled Chromium is the default. A machine that never ran
 * `playwright install chromium` falls back to the system Chrome;
 * E2E_BROWSER_CHANNEL forces a channel (for example `msedge`).
 */
const browserChannel =
  process.env.E2E_BROWSER_CHANNEL || (existsSync(chromium.executablePath()) ? undefined : 'chrome')

test.use({
  channel: browserChannel,
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
})

test.setTimeout(120_000)

const AUTH_HEADERS = {
  Authorization: `Bearer ${E2E_TOKEN}`,
  'content-type': 'application/json'
} as const

/** The footer's healthy reading: the status and the host this client talks to (V-12). */
const CONNECTED_TEXT = `Connected · ${new URL(E2E_BASE_URL).host}`

/** Server store key holding the web client's last selected project. */
const ACTIVE_PROJECT_KEY = 'web-active-project'

/**
 * Every test pins the selected project, and the store outlives this file: put
 * back whatever the suites before it left, so the suites after it see the same
 * server they would without us.
 */
let activeProjectBefore: unknown = null

test.beforeAll(async () => {
  const reply = await wsRequest<{ value?: unknown }>(E2E_BASE_URL, 'store_read', {
    key: ACTIVE_PROJECT_KEY
  })
  activeProjectBefore = reply?.value ?? null
})

test.afterAll(async () => {
  if (activeProjectBefore === null) {
    await wsRequest(E2E_BASE_URL, 'store_delete', { key: ACTIVE_PROJECT_KEY })
  } else {
    await wsRequest(E2E_BASE_URL, 'store_write', {
      key: ACTIVE_PROJECT_KEY,
      value: activeProjectBefore
    })
  }
})

// ---------------------------------------------------------------------------
// Helpers (kept in this file: sibling suites add specs in parallel)
// ---------------------------------------------------------------------------

interface Project {
  id: string
  name: string
  path: string
}

/**
 * Register a throwaway project under the suite's workspace root, create its
 * folders and files, and make it the web client's active project so the app
 * boots straight into it. The name is unique per call: layouts and persisted
 * folders are keyed by project id, so a reused id would restore an earlier
 * run's state. The prefix is not `proj-a`..`proj-x`: other suites select those
 * by name prefix.
 */
async function createProject(
  files: Record<string, string> = {},
  options: { select?: boolean } = {}
): Promise<Project> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-gaps-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  // /fs/write does not create parents, so lay the tree out on disk first.
  for (const file of Object.keys(files)) await mkdir(dirname(join(path, file)), { recursive: true })

  const api = await request.newContext()
  try {
    const registered = await api.post(`${E2E_BASE_URL}/projects`, {
      headers: AUTH_HEADERS,
      data: { id, name, path, color: 'blue' }
    })
    if (!registered.ok()) throw new Error(`project registration failed: ${registered.status()}`)
    for (const [relative, content] of Object.entries(files)) {
      const written = await api.post(`${E2E_BASE_URL}/fs/write`, {
        headers: AUTH_HEADERS,
        data: { path: join(path, relative), content }
      })
      if (!written.ok()) throw new Error(`fs/write ${relative} failed: ${written.status()}`)
    }
  } finally {
    await api.dispose()
  }
  if (options.select !== false) {
    await wsRequest(E2E_BASE_URL, 'store_write', {
      key: ACTIVE_PROJECT_KEY,
      value: { _version: 1, data: id }
    })
  }
  return { id, name, path }
}

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session, and that session
 * creation re-activates the pane. A tab opened BEFORE it lands is swapped out
 * from under the test (a test-only race: a person needs seconds to reach the
 * drawer). An agent that fails to start also ends the warm-up. Bounded so a
 * boot with no warm-up cannot hang the test.
 */
function watchAgentWarmup(page: Page): Promise<void> {
  return new Promise<void>((resolve) => {
    const giveUp = setTimeout(resolve, 20_000)
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
        if (kind === 'create_session' || (kind === 'spawn_agent' && reply.ok === false)) {
          clearTimeout(giveUp)
          resolve()
        }
      })
    })
  })
}

/**
 * Boot the mobile shell on the project. `settleAgentWarmup` is for projects
 * that start with an empty workspace (the launcher warm-up runs there).
 */
async function openShell(
  page: Page,
  project: Project,
  options: { settleAgentWarmup?: boolean } = {}
): Promise<void> {
  const warmedUp = options.settleAgentWarmup ? watchAgentWarmup(page) : Promise.resolve()
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN,
    { timeout: 60_000 }
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  // The header's subtitle names the active project: seeing it proves the shell
  // booted into our fresh project.
  await expect(page.getByRole('button', { name: /, switch project$/ })).toContainText(project.name)
  // The empty pane's launcher, with its agent loaded, is the last piece of the
  // project's hydration. Acting earlier races the workspace restore, which can
  // replace a tab the test just opened.
  if (options.settleAgentWarmup) {
    await expect(
      page.getByRole('button', { name: 'Agent and model. Currently Fake Longrun' })
    ).toBeVisible()
  }
  await warmedUp
}

/** ☰, even while a modal drawer hides it from the accessibility tree. */
function menuButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Open menu', includeHidden: true })
}

function drawerOf(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Termul', exact: true })
}

/** Tap ☰ and wait for the drawer to be on screen and settled. */
async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  const drawer = drawerOf(page)
  await expect(drawer).toBeVisible()
  // The sheet slides in from the left: act only once it has landed.
  await expect
    .poll(async () => (await drawer.boundingBox())?.x ?? Number.NEGATIVE_INFINITY)
    .toBeGreaterThanOrEqual(-0.5)
  return drawer
}

/** The drawer's section nav row (Chats, Terminals, Editors). */
function sectionNav(drawer: Locator, section: 'Chats' | 'Terminals' | 'Editors'): Locator {
  return drawer
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: new RegExp(`^${section}`) })
}

/** Open the drawer and switch it to `section` with its nav row (the drawer stays open). */
async function openDrawerOn(
  page: Page,
  section: 'Chats' | 'Terminals' | 'Editors'
): Promise<Locator> {
  const drawer = await openDrawer(page)
  await sectionNav(drawer, section).tap()
  await expect(sectionNav(drawer, section)).toHaveAttribute('aria-current', 'true')
  await expect(drawer).toBeVisible()
  return drawer
}

/** The Terminals section's rows. */
function terminalRows(drawer: Locator): Locator {
  return drawer.getByRole('group', { name: 'Terminals' }).getByRole('button', {
    name: /^Terminal \d+$/
  })
}

/** The Editors section's rows (select buttons only, not their close buttons). */
function tabRows(drawer: Locator): Locator {
  return drawer.getByRole('group', { name: 'Editors' }).getByRole('button', { name: /^(?!Close )/ })
}

const terminalInput = (page: Page): Locator => page.getByRole('textbox', { name: 'Terminal input' })
const snapshotsHeading = (page: Page): Locator =>
  page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })

/** Open a new terminal from the drawer's Terminals "New terminal" pill; the drawer closes. */
async function newTerminalFromDrawer(page: Page): Promise<void> {
  const drawer = await openDrawerOn(page, 'Terminals')
  await drawer.getByRole('button', { name: 'New terminal', exact: true }).tap()
  await expect(drawer).toBeHidden()
  await expect(terminalInput(page)).toBeVisible()
}

/** The Files sheet: the header has no Files button of its own, the ⋯ sheet lists it. */
async function openFilesSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More', exact: true }).tap()
  await page
    .locator('#mobile-header-more-sheet')
    .getByRole('button', { name: 'Files', exact: true })
    .tap()
  await expect(page.getByRole('button', { name: 'Back to parent folder' })).toBeVisible()
}

/** Open a file from the Files sheet (the sheet closes on open). */
async function openFileFromFiles(page: Page, fileName: string): Promise<void> {
  await openFilesSheet(page)
  await page.getByRole('button', { name: `Open ${fileName}`, exact: true }).tap()
  // The header names the active tab: the file is open and showing.
  await expect(page.getByRole('heading', { level: 1, name: fileName, exact: true })).toBeVisible()
}

async function goToSnapshots(page: Page): Promise<void> {
  const drawer = await openDrawer(page)
  await drawer.getByRole('button', { name: 'Snapshots', exact: true }).tap()
  await expect(page).toHaveURL(/#\/snapshots$/)
  await expect(snapshotsHeading(page)).toBeVisible()
}

/** The close confirm's root: it carries no dialog role, only `data-sibling-dialog`. */
function confirmOf(page: Page): Locator {
  return page.locator('[data-sibling-dialog]')
}

/** ✕ on a terminal row (the first one by default): the drawer hands off to the "Close Terminal" confirm. */
async function tapTerminalClose(
  page: Page,
  closeName: string | RegExp = /^Close Terminal \d+$/
): Promise<Locator> {
  const drawer = await openDrawerOn(page, 'Terminals')
  await drawer.getByRole('button', { name: closeName }).first().tap()
  await expect(drawer).toBeHidden()
  const confirm = confirmOf(page)
  await expect(confirm.getByRole('heading', { name: 'Close Terminal', exact: true })).toBeVisible()
  return confirm
}

/** Close a terminal through its row's ✕ and the confirm (frees its PTY slot). */
async function closeTerminal(
  page: Page,
  closeName: string | RegExp = /^Close Terminal \d+$/
): Promise<void> {
  const confirm = await tapTerminalClose(page, closeName)
  await confirm.getByRole('button', { name: 'Close', exact: true }).tap()
  await expect(confirm).toBeHidden()
}

// ---------------------------------------------------------------------------
// L-15: return to the workspace from /snapshots
// ---------------------------------------------------------------------------

test('L-15: footer Git history, Terminals New terminal and a file from Files leave /snapshots for the workspace', async ({
  page
}) => {
  const project = await createProject({ 'notes.md': 'snapshots entry content' })
  await openShell(page, project, { settleAgentWarmup: true })

  // The Terminals New terminal pill: with a terminal on screen the drawer lists
  // Terminals, and from Snapshots the new terminal is shown, not Snapshots.
  await newTerminalFromDrawer(page)
  await goToSnapshots(page)
  const terminalsDrawer = await openDrawer(page)
  await terminalsDrawer.getByRole('button', { name: 'New terminal', exact: true }).tap()
  await expect(terminalsDrawer).toBeHidden()
  await expect(page).toHaveURL(/#\/$/)
  await expect(snapshotsHeading(page)).toBeHidden()
  await expect(terminalInput(page)).toBeVisible()
  await closeTerminal(page)
  await closeTerminal(page)

  // A file opened from the Files sheet: the editor tab is active and the route is `/`.
  await goToSnapshots(page)
  await openFilesSheet(page)
  await page.getByRole('button', { name: 'Open notes.md', exact: true }).tap()
  await expect(page).toHaveURL(/#\/$/)
  await expect(snapshotsHeading(page)).toBeHidden()
  await expect(page.getByRole('button', { name: 'Save notes.md', exact: true })).toBeVisible()

  // The drawer footer's Git history: the history tab is shown, not Snapshots.
  await goToSnapshots(page)
  const drawer = await openDrawer(page)
  await drawer.getByRole('button', { name: 'Git history', exact: true }).tap()
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(/#\/$/)
  await expect(snapshotsHeading(page)).toBeHidden()
  await expect(page.getByRole('button', { name: 'Refresh history' })).toBeVisible()
})

test('on /snapshots the drawer opens on the active section, switches sections in place, and a row returns to the workspace', async ({
  page
}) => {
  const project = await createProject({ 'notes.md': 'drawer nav entry content' })
  await openShell(page, project, { settleAgentWarmup: true })
  await openFileFromFiles(page, 'notes.md')

  await goToSnapshots(page)
  // The editor was active: Editors is preselected.
  let drawer = await openDrawer(page)
  await expect(sectionNav(drawer, 'Editors')).toHaveAttribute('aria-current', 'true')
  // Switching sections keeps the drawer open and the route where it is.
  await sectionNav(drawer, 'Terminals').tap()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByText('No open terminals')).toBeVisible()
  await expect(page).toHaveURL(/#\/snapshots$/)
  await sectionNav(drawer, 'Editors').tap()
  await drawer.getByRole('button', { name: 'notes.md', exact: true }).tap()
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(/#\/$/)
  await expect(snapshotsHeading(page)).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: 'notes.md', exact: true })).toBeVisible()

  // Reopened on the workspace, it preselects Editors again.
  drawer = await openDrawer(page)
  await expect(sectionNav(drawer, 'Editors')).toHaveAttribute('aria-current', 'true')
})

test('L-15: the header New terminal and the more-sheet New terminal leave /snapshots too', async ({
  page
}) => {
  const project = await createProject({ 'notes.md': 'header entry content' })
  await openShell(page, project, { settleAgentWarmup: true })

  // The header ✎ on a terminal: from Snapshots it creates a second terminal
  // and lands on the workspace route with that terminal showing.
  await newTerminalFromDrawer(page)
  await goToSnapshots(page)
  await page.getByRole('button', { name: 'New terminal', exact: true }).tap()
  await expect(page).toHaveURL(/#\/$/)
  await expect(snapshotsHeading(page)).toBeHidden()
  await expect(terminalInput(page)).toBeVisible()
  const drawer = await openDrawerOn(page, 'Terminals')
  await expect(terminalRows(drawer)).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await closeTerminal(page)
  await closeTerminal(page)

  // The ⋯ sheet's New terminal, from a non-terminal tab (an open file).
  await openFileFromFiles(page, 'notes.md')
  await goToSnapshots(page)
  await page.getByRole('button', { name: 'More', exact: true }).tap()
  await page
    .locator('#mobile-header-more-sheet')
    .getByRole('button', { name: 'New terminal', exact: true })
    .tap()
  await expect(page).toHaveURL(/#\/$/)
  await expect(snapshotsHeading(page)).toBeHidden()
  await expect(terminalInput(page)).toBeVisible()

  await closeTerminal(page)
})

test('L-15: on `/` and on a chat route the route is left alone', async ({ page }) => {
  const project = await createProject()
  await openShell(page, project, { settleAgentWarmup: true })

  // On `/`: New terminal from the drawer keeps the hash.
  await expect(page).toHaveURL(/#\/$/)
  await newTerminalFromDrawer(page)
  await expect(page).toHaveURL(/#\/$/)
  await closeTerminal(page)

  // On a chat route: the same, and the hash is exactly what it was.
  const prompt = `[DURATION:3] gaps chat ${randomUUID().slice(0, 6)}`
  const composer = page.getByRole('textbox', { name: 'Agent prompt' }).first()
  await composer.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/c\/sess-[\w-]+$/)
  const chatHash = new URL(page.url()).hash
  await newTerminalFromDrawer(page)
  expect(new URL(page.url()).hash).toBe(chatHash)
  await closeTerminal(page)
  expect(new URL(page.url()).hash).toBe(chatHash)
})

// ---------------------------------------------------------------------------
// L-16: the close confirm of a drawer row
// ---------------------------------------------------------------------------

test('L-16: a terminal ✕ hands off to its confirm; Cancel, Esc and Close each leave focus on the menu button', async ({
  page
}) => {
  const project = await createProject()
  await openShell(page, project, { settleAgentWarmup: true })
  await newTerminalFromDrawer(page)

  // Cancel keeps the terminal.
  let confirm = await tapTerminalClose(page)
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).tap()
  await expect(confirm).toBeHidden()
  await expect(terminalInput(page)).toBeVisible()
  await expect(menuButton(page)).toBeFocused()

  // Esc keeps it too.
  confirm = await tapTerminalClose(page)
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(terminalInput(page)).toBeVisible()
  await expect(menuButton(page)).toBeFocused()

  // Close removes it, and focus is on the menu button again.
  await closeTerminal(page)
  await expect(terminalInput(page)).toHaveCount(0)
  await expect(menuButton(page)).toBeFocused()
})

test('L-16: a dirty editor ✕ hands off to its confirm (Cancel keeps the file, Discard drops it); a clean editor ✕ keeps the drawer open', async ({
  page
}) => {
  const project = await createProject({ 'dirty.txt': 'original', 'clean.txt': 'clean' })
  await openShell(page, project, { settleAgentWarmup: true })

  await openFileFromFiles(page, 'clean.txt')
  await openFileFromFiles(page, 'dirty.txt')
  // The open file's editor is the one accessible textbox (the other tab is hidden).
  const editor = page.getByRole('textbox')
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.type(' edited')
  // The row carries the unsaved cue for screen readers.
  let drawer = await openDrawer(page)
  await expect(
    drawer.getByRole('button', { name: /^dirty\.txt\s*, unsaved changes$/ })
  ).toBeVisible()

  // ✕ on the clean file: no confirm, the drawer stays open, the row is gone.
  await drawer.getByRole('button', { name: 'Close clean.txt', exact: true }).tap()
  await expect(drawer.getByRole('button', { name: 'clean.txt', exact: true })).toHaveCount(0)
  await expect(drawer).toBeVisible()
  await expect(confirmOf(page)).toHaveCount(0)

  // ✕ on the dirty file: the drawer closes and the confirm is tappable.
  await drawer.getByRole('button', { name: 'Close dirty.txt', exact: true }).tap()
  await expect(drawer).toBeHidden()
  let confirm = confirmOf(page)
  await expect(confirm.getByRole('heading', { name: 'Unsaved Changes' })).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).tap()
  await expect(confirm).toBeHidden()
  await expect(menuButton(page)).toBeFocused()
  drawer = await openDrawer(page)
  await expect(
    drawer.getByRole('button', { name: /^dirty\.txt\s*, unsaved changes$/ })
  ).toBeVisible()

  // Discard drops the tab without saving; focus is on the menu button.
  await drawer.getByRole('button', { name: 'Close dirty.txt', exact: true }).tap()
  await expect(drawer).toBeHidden()
  confirm = confirmOf(page)
  await confirm.getByRole('button', { name: 'Discard', exact: true }).tap()
  await expect(confirm).toBeHidden()
  await expect(menuButton(page)).toBeFocused()
  expect(await readFile(join(project.path, 'dirty.txt'), 'utf8')).toBe('original')
  drawer = await openDrawer(page)
  await expect(drawer.getByRole('button', { name: /^dirty\.txt/ })).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// L-18: focus stays inside the drawer
// ---------------------------------------------------------------------------

test('L-18: closing an Editors row moves focus to the next row, else the section heading', async ({
  page
}) => {
  const project = await createProject({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' })
  await openShell(page, project, { settleAgentWarmup: true })
  for (const file of ['a.txt', 'b.txt', 'c.txt']) await openFileFromFiles(page, file)

  const drawer = await openDrawerOn(page, 'Editors')
  const rows = tabRows(drawer)
  await expect(rows).toHaveText(['a.txt', 'b.txt', 'c.txt'])

  // A middle-of-the-list close: focus lands on the row that followed it.
  const closeB = drawer.getByRole('button', { name: 'Close b.txt', exact: true })
  await closeB.tap()
  await expect(rows).toHaveText(['a.txt', 'c.txt'])
  await expect(drawer.getByRole('button', { name: 'c.txt', exact: true })).toBeFocused()

  // The last row: the section heading.
  await drawer.getByRole('button', { name: 'Close c.txt', exact: true }).tap()
  await expect(rows).toHaveText(['a.txt'])
  await expect(drawer.getByRole('heading', { name: 'Editors', exact: true })).toBeFocused()

  // The last row of all: the list empties, but the drawer keeps listing
  // Editors while it is open, and its heading keeps focus (never `<body>`).
  await drawer.getByRole('button', { name: 'Close a.txt', exact: true }).tap()
  await expect(drawer.getByRole('group', { name: 'Editors' })).toHaveCount(0)
  await expect(drawer.getByText('No open editors')).toBeVisible()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('heading', { name: 'Editors', exact: true })).toBeFocused()
})

test('L-18: a rename ended by Enter or Escape returns focus to its pencil; a blur commit leaves focus alone', async ({
  page
}) => {
  const project = await createProject()
  await openShell(page, project, { settleAgentWarmup: true })
  await newTerminalFromDrawer(page)

  const drawer = await openDrawerOn(page, 'Terminals')
  const renameInput = (name: string | RegExp): Locator =>
    drawer.getByRole('textbox', { name, exact: typeof name === 'string' })
  const renameButton = (name: string): Locator =>
    drawer.getByRole('button', { name: `Rename ${name}`, exact: true })

  // Enter commits and hands focus back to the row's Rename button.
  await drawer.getByRole('button', { name: /^Rename Terminal \d+$/ }).tap()
  const input = renameInput(/^Rename Terminal \d+$/)
  await expect(input).toBeFocused()
  await input.fill('build')
  await input.press('Enter')
  await expect(drawer.getByRole('button', { name: 'build', exact: true })).toBeVisible()
  await expect(renameButton('build')).toBeFocused()

  // Escape cancels (the name stays) and returns focus the same way.
  await renameButton('build').tap()
  await expect(renameInput('Rename build')).toBeFocused()
  await renameInput('Rename build').fill('discarded')
  await renameInput('Rename build').press('Escape')
  // Escape ends the rename, not the drawer (a dismissed sheet flips to
  // `closed` at once, long before its exit animation unmounts it).
  await expect(drawer).toHaveAttribute('data-state', 'open')
  await expect(drawer.getByRole('button', { name: 'build', exact: true })).toBeVisible()
  await expect(renameButton('build')).toBeFocused()

  // A blur commit (the user moved on) commits and does not take focus back to
  // the pencil. Where focus lands instead is the browser's and the drawer's
  // focus trap's business: the rename code must not choose it.
  await renameButton('build').tap()
  await renameInput('Rename build').fill('kept')
  await drawer.getByRole('heading', { level: 2, name: 'Terminals', exact: true }).tap()
  await expect(drawer.getByRole('button', { name: 'kept', exact: true })).toBeVisible()
  await expect(renameInput(/^Rename /)).toHaveCount(0)
  await expect(renameButton('kept')).not.toBeFocused()
  expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true)

  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await closeTerminal(page, 'Close kept')
})

// ---------------------------------------------------------------------------
// L-20: a Windows-hosted server lists verbatim (`\\?\C:\...`) entries
// ---------------------------------------------------------------------------

const folderPath = (page: Page): Locator => page.getByRole('navigation', { name: 'Folder path' })

test('L-20: the Files breadcrumb, an ancestor tap, Back and opening a file work on the host as it lists paths', async ({
  page
}) => {
  const project = await createProject({ 'src/lib/deep.md': 'deep content' })
  // Remember what the host lists: on Windows every entry carries the verbatim
  // prefix, so this run exercises the L-20 strip against the real server.
  const listedPaths: string[] = []
  page.on('response', async (response) => {
    if (!/\/fs\/ls(\?|$)/.test(response.url())) return
    try {
      const body = (await response.json()) as { data?: Array<{ path?: string }> }
      for (const entry of body.data ?? []) if (entry.path) listedPaths.push(entry.path)
    } catch {
      // not a JSON listing: nothing to record
    }
  })
  await openShell(page, project)

  await openFilesSheet(page)
  await expect(page.getByText('Project files', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open folder src', exact: true }).tap()
  await page.getByRole('button', { name: 'Open folder lib', exact: true }).tap()

  // Real segments: the project, then `src`, with `lib` current. A verbatim
  // path left unstripped would never sit under the root, so no breadcrumb.
  const path = folderPath(page)
  await expect(path).toBeVisible()
  await expect(path.getByRole('button')).toHaveText([project.name, 'src'])
  await expect(path.locator('[aria-current="page"]')).toHaveText('lib')
  await expect(path).toHaveAttribute('title', /\/src\/lib$/)
  await expect(path).not.toHaveAttribute('title', /\?/)
  await expect(page.getByRole('list', { name: 'Files in lib' })).toBeVisible()
  if (process.platform === 'win32') {
    expect(
      listedPaths.some((entry) => entry.startsWith('\\\\?\\')),
      'a Windows host lists verbatim paths'
    ).toBe(true)
  }

  // Tapping an ancestor navigates there.
  await path.getByRole('button', { name: 'src', exact: true }).tap()
  await expect(path.locator('[aria-current="page"]')).toHaveText('src')
  await expect(page.getByRole('list', { name: 'Files in src' })).toBeVisible()

  // Back steps up one level, not to the root.
  await page.getByRole('button', { name: 'Open folder lib', exact: true }).tap()
  await page.getByRole('button', { name: 'Back to parent folder' }).tap()
  await expect(path.locator('[aria-current="page"]')).toHaveText('src')
  await expect(page.getByRole('list', { name: 'Files in src' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to parent folder' }).tap()
  await expect(path).toHaveCount(0)
  await expect(page.getByText('Project files', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to parent folder' })).toBeDisabled()

  // A file listed under that path opens as an editor tab.
  await page.getByRole('button', { name: 'Open folder src', exact: true }).tap()
  await page.getByRole('button', { name: 'Open folder lib', exact: true }).tap()
  await page.getByRole('button', { name: 'Open deep.md', exact: true }).tap()
  await expect(page.getByRole('button', { name: 'Save deep.md', exact: true })).toBeVisible()
  const drawer = await openDrawerOn(page, 'Editors')
  await expect(drawer.getByRole('button', { name: 'deep.md', exact: true })).toBeVisible()
})

// ---------------------------------------------------------------------------
// L-35: a clipped breadcrumb ancestor leaves the tab order
// ---------------------------------------------------------------------------

const LONG_FOLDERS = [
  'aaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbb',
  'cccccccccccccccccccc',
  'dddddddddddddddddddd',
  'current-folder'
]

interface CrumbReading {
  name: string
  tabIndex: number
  /** Entirely outside the nav's clip box, with a margin for the IntersectionObserver edge. */
  clipped: boolean
  /** Clearly inside it. */
  visible: boolean
}

/** Every ancestor button of the breadcrumb with its tab index and where it sits against the nav. */
async function readCrumbs(page: Page): Promise<CrumbReading[]> {
  return folderPath(page)
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const nav = button.closest('nav')?.getBoundingClientRect()
        const box = button.getBoundingClientRect()
        return {
          name: button.textContent?.trim() ?? '',
          tabIndex: (button as HTMLElement).tabIndex,
          clipped: nav ? box.right < nav.left - 1 || box.left > nav.right + 1 : false,
          visible: nav ? box.right > nav.left + 1 && box.left < nav.right - 1 : false
        }
      })
    )
}

async function openLongPath(page: Page, project: Project): Promise<void> {
  await openShell(page, project)
  await openFilesSheet(page)
  for (const folder of LONG_FOLDERS) {
    await page.getByRole('button', { name: `Open folder ${folder}`, exact: true }).tap()
  }
  await expect(folderPath(page).locator('[aria-current="page"]')).toHaveText('current-folder')
}

test('L-35: Tab skips a fully clipped ancestor and stops on the visible ones; shortening the path restores them', async ({
  page
}) => {
  const project = await createProject({ [`${LONG_FOLDERS.join('/')}/x.md`]: 'long path' })
  await openLongPath(page, project)

  // The clipped ones are out of the tab order, the visible ones are in it.
  await expect
    .poll(async () => {
      const crumbs = await readCrumbs(page)
      return {
        hasClipped: crumbs.some((crumb) => crumb.clipped),
        hasVisible: crumbs.some((crumb) => crumb.visible),
        clippedSkipped: crumbs
          .filter((crumb) => crumb.clipped)
          .every((crumb) => crumb.tabIndex < 0),
        visibleTabbable: crumbs
          .filter((crumb) => crumb.visible)
          .every((crumb) => crumb.tabIndex >= 0)
      }
    })
    .toEqual({ hasClipped: true, hasVisible: true, clippedSkipped: true, visibleTabbable: true })

  // Walking the sheet with Tab from the Back button never lands on a clipped crumb.
  const crumbs = await readCrumbs(page)
  const clippedNames = crumbs.filter((crumb) => crumb.clipped).map((crumb) => crumb.name)
  const visibleNames = crumbs.filter((crumb) => crumb.visible).map((crumb) => crumb.name)
  await page.getByRole('button', { name: 'Back to parent folder' }).focus()
  const reached: string[] = []
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press('Tab')
    const label = await page.evaluate(
      () =>
        document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent
    )
    if (label === 'Refresh current folder') break
    reached.push(label?.trim() ?? '')
  }
  for (const name of clippedNames)
    expect(reached, `Tab reached clipped "${name}"`).not.toContain(name)
  expect(reached).toEqual(visibleNames)

  // Back up the whole path: a short path has nothing clipped, so every crumb is tabbable again.
  for (let level = 0; level < LONG_FOLDERS.length - 1; level++) {
    await page.getByRole('button', { name: 'Back to parent folder' }).tap()
  }
  await expect(folderPath(page).locator('[aria-current="page"]')).toHaveText(LONG_FOLDERS[0])
  await expect
    .poll(async () =>
      (await readCrumbs(page)).every((crumb) => crumb.visible && crumb.tabIndex >= 0)
    )
    .toBe(true)
})

test.describe('without IntersectionObserver', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'IntersectionObserver')
    })
  })

  test('L-35: every breadcrumb segment stays tabbable, clipped or not', async ({ page }) => {
    const project = await createProject({ [`${LONG_FOLDERS.join('/')}/x.md`]: 'long path' })
    await openLongPath(page, project)
    expect(await page.evaluate(() => typeof window.IntersectionObserver)).toBe('undefined')

    const crumbs = await readCrumbs(page)
    // The premise: a path this long really clips its first ancestor.
    expect(crumbs.some((crumb) => crumb.clipped)).toBe(true)
    expect(crumbs.every((crumb) => crumb.tabIndex >= 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// V-12: the drawer footer names the host
// ---------------------------------------------------------------------------

test('V-12: the drawer footer reads Connected · host, fully inside the drawer', async ({
  page
}) => {
  const project = await createProject()
  await openShell(page, project)

  const drawer = await openDrawer(page)
  const status = drawer.getByRole('status')
  await expect(status).toHaveText(CONNECTED_TEXT)
  const drawerBox = await drawer.boundingBox()
  const statusBox = await status.boundingBox()
  if (!drawerBox || !statusBox) throw new Error('missing layout box')
  expect(statusBox.x).toBeGreaterThanOrEqual(drawerBox.x)
  expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(drawerBox.x + drawerBox.width + 0.5)
  // The longer reading widens nothing: the drawer does not scroll sideways.
  expect(await drawer.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
})

test('V-12: a degraded channel keeps its own text, with no host in it', async ({ page }) => {
  // Proxy the control socket so the test can drop it. While the channel is
  // "down" a reconnect is accepted but its handshake never answered, so the
  // client keeps reporting "reconnecting" instead of flapping back to "connected".
  let channelDown = false
  const liveSockets: WebSocketRoute[] = []
  await page.routeWebSocket(
    (url) => url.pathname === '/ws',
    (socket) => {
      if (channelDown) return
      socket.connectToServer()
      liveSockets.push(socket)
    }
  )
  const project = await createProject()
  await openShell(page, project)

  const drawer = await openDrawer(page)
  const status = drawer.getByRole('status')
  await expect(status).toHaveText(CONNECTED_TEXT)

  channelDown = true
  for (const socket of liveSockets) await socket.close()
  await expect(status).toHaveText(/^Control channel: (reconnecting|disconnected)$/)
  await expect(status).not.toContainText(new URL(E2E_BASE_URL).host)
})

test.describe('desktop layout', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  })

  test('V-12: the StatusBar lamp keeps its plain Connected reading', async ({ page }) => {
    await openWorkspace(page)
    const statusBar = page.locator('[data-status-bar]')
    await expect(statusBar).toBeVisible()
    const lamp = statusBar.getByRole('status')
    await expect(lamp).toHaveAccessibleName('Connected')
    await expect(lamp).not.toContainText('·')
    await expect(statusBar).not.toContainText(new URL(E2E_BASE_URL).host)
  })
})

// ---------------------------------------------------------------------------
// V-13: Set as host default, V-14: the drawer search scope
// ---------------------------------------------------------------------------

test('V-13: the project sheet offers ⌂ for a project with a path, at the touch floor, and calls the default-project route', async ({
  page
}) => {
  const current = await createProject()
  const other = await createProject({}, { select: false })
  await openShell(page, current)
  // The host default is shared by every suite on this server: the route is
  // stubbed, so the tap proves the request without changing it.
  const bodies: unknown[] = []
  await page.route('**/projects/default', async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ json: { success: true } })
  })

  await page.getByRole('button', { name: /, switch project$/ }).tap()
  const sheet = page.getByRole('dialog', { name: 'Projects' })
  await expect(sheet).toBeVisible()
  const control = sheet.getByRole('button', { name: `Set "${other.name}" as host default` })
  await expect(control).toBeVisible()
  const box = await control.boundingBox()
  if (!box) throw new Error('control has no layout box')
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)

  // A row that carries the Default badge never offers the control.
  for (const row of await sheet
    .getByRole('listitem')
    .filter({ has: page.locator('[title^="Host default"]') })
    .all()) {
    await expect(row.getByRole('button', { name: /as host default$/ })).toHaveCount(0)
  }

  await control.tap()
  await expect(page.getByText(`"${other.name}" is now the host default`)).toBeVisible()
  expect(bodies).toEqual([{ projectId: other.id }])
  // Setting a default is not a switch: the current project is unchanged.
  await expect(
    sheet.getByRole('button', { name: new RegExp(`^${current.name} Current`) })
  ).toBeDisabled()
})

test('V-13: ⌂ is offered for a non-default, unarchived project with a path, and for no other row', async ({
  page
}) => {
  const home = await createProject()
  const plain = await createProject({}, { select: false })
  const hostDefault = await createProject({}, { select: false })
  const archived = await createProject({}, { select: false })
  const pathless = await createProject({}, { select: false })
  // The host default is shared by every suite on this server, and a real
  // archived or pathless project cannot be made on cue: the list the client
  // reads is patched per row kind (the server's own list is left alone).
  await page.route(/\/projects(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = (await response.json()) as {
      data?: { projects: Array<Record<string, unknown>>; defaultProjectId: string | null }
    }
    if (body.data) {
      body.data.defaultProjectId = hostDefault.id
      body.data.projects = body.data.projects.map((project) => ({
        ...project,
        isDefault: project.id === hostDefault.id,
        isArchived: project.id === archived.id ? true : project.isArchived,
        path: project.id === pathless.id ? null : project.path
      }))
    }
    return route.fulfill({ response, json: body })
  })
  await openShell(page, home)

  await page.getByRole('button', { name: /, switch project$/ }).tap()
  const sheet = page.getByRole('dialog', { name: 'Projects' })
  await expect(sheet).toBeVisible()
  const control = (project: Project): Locator =>
    sheet.getByRole('button', { name: `Set "${project.name}" as host default` })

  // Every kind of row is listed, so an absent control is not a not-yet-rendered one.
  for (const project of [home, plain, hostDefault, archived, pathless]) {
    await expect(
      sheet.getByRole('button', { name: new RegExp(`^${project.name}( |$)`) })
    ).toBeVisible()
  }
  await expect(control(plain)).toBeVisible()
  await expect(control(home)).toBeVisible()
  await expect(control(hostDefault)).toHaveCount(0)
  await expect(control(archived)).toHaveCount(0)
  await expect(control(pathless)).toHaveCount(0)
})

test('V-14: the drawer search lives with the Recents chat list, never the Editors list', async ({
  page
}) => {
  const project = await createProject({ 'notes.txt': 'search scope' })
  await openShell(page, project, { settleAgentWarmup: true })
  await openFileFromFiles(page, 'notes.txt')

  // Editors lists the file and offers no chat search.
  let drawer = await openDrawerOn(page, 'Editors')
  await expect(drawer.getByRole('button', { name: 'notes.txt', exact: true })).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: 'Search chats' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  // Chats: the search filters Recents, and the file is never in that list.
  drawer = await openDrawerOn(page, 'Chats')
  await expect(drawer.getByRole('heading', { name: 'Recents', exact: true })).toBeVisible()
  await drawer.getByRole('textbox', { name: 'Search chats' }).fill('zzz-no-such-chat')
  await expect(drawer.getByRole('button', { name: 'notes.txt', exact: true })).toHaveCount(0)
})
