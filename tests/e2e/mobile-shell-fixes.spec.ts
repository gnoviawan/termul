import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'
import { openWorkspace } from './ui'

/**
 * Mobile shell fixes E2E (spec-mobile-shell-fixes): a phone-sized browser
 * drives the web client's mobile shell and checks what jsdom cannot — the real
 * layout of the Files breadcrumb (44px vertical hit-slop, left clip, no header
 * growth), the single rendered leaf of a split tree synced from desktop, the
 * route the drawer returns to, and a PTY surviving a pane switch.
 *
 * Every test registers its own project (fresh workspace, no state shared with
 * other suites). Desktop parity is pinned by one test at the bottom that runs a
 * 1440px context against the same server.
 *
 * Not automated here (unit tests own them, see the spec's matrix): the
 * first-leaf fallback warning (the manifest restore repairs a dangling active
 * pane before the hook can see it), the disabled breadcrumb while a create
 * request is in flight, drive-root and casing normalisation, and the
 * navigateTo guard log.
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

const AUTH_HEADERS = {
  Authorization: `Bearer ${E2E_TOKEN}`,
  'content-type': 'application/json'
} as const

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
 * run's state.
 */
async function createProject(
  files: Record<string, string> = {},
  folders: string[] = []
): Promise<Project> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-shellfix-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  // /fs/write does not create parents, so lay the tree out on disk first.
  for (const folder of folders) await mkdir(join(path, folder), { recursive: true })
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
  await wsRequest(E2E_BASE_URL, 'store_write', {
    key: 'web-active-project',
    value: { _version: 1, data: id }
  })
  return { id, name, path }
}

/**
 * Seed a split workspace the way a desktop client leaves it: two leaves, one
 * editor each, `leaf-b` active. The host stores one manifest per project and
 * every client restores its tree from it.
 */
async function seedSplitWorkspace(
  project: Project,
  leafAFile: string,
  leafBFile: string
): Promise<void> {
  const portable = (file: string) => join(project.path, file).replace(/\\/g, '/')
  const aPath = portable(leafAFile)
  const bPath = portable(leafBFile)
  const manifest = {
    projectId: project.id,
    revision: 0,
    updatedAt: Date.now(),
    topology: {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'leaf',
          id: 'leaf-a',
          terminalIds: [],
          editorIds: [`edit-${aPath}`],
          activeTabId: `edit-${aPath}`
        },
        {
          type: 'leaf',
          id: 'leaf-b',
          terminalIds: [],
          editorIds: [`edit-${bPath}`],
          activeTabId: `edit-${bPath}`
        }
      ]
    },
    activePaneId: 'leaf-b',
    terminals: [],
    editors: [
      { editorId: `edit-${aPath}`, filePath: aPath },
      { editorId: `edit-${bPath}`, filePath: bPath }
    ]
  }
  const api = await request.newContext()
  try {
    const res = await api.post(`${E2E_BASE_URL}/workspace/${project.id}/write`, {
      headers: AUTH_HEADERS,
      data: { basedRevision: null, manifest }
    })
    const body = (await res.json()) as { success?: boolean; data?: { status?: string } }
    if (!res.ok() || !body.success || body.data?.status !== 'updated') {
      throw new Error(`workspace manifest write failed: ${JSON.stringify(body)}`)
    }
  } finally {
    await api.dispose()
  }
}

interface ServerManifest {
  topology?: {
    type: string
    children?: Array<{ type: string; id: string }>
  }
  editors?: Array<{ filePath: string }>
}

async function readManifest(project: Project): Promise<ServerManifest | null> {
  const api = await request.newContext()
  try {
    const res = await api.get(`${E2E_BASE_URL}/workspace/${project.id}`, { headers: AUTH_HEADERS })
    const body = (await res.json()) as { success?: boolean; data?: ServerManifest | null }
    return body.success ? (body.data ?? null) : null
  } finally {
    await api.dispose()
  }
}

/**
 * A termul-server on Windows lists directory entries with the canonical
 * verbatim prefix (`\\?\C:\...`) while the project root is the plain
 * `C:\...`, so the Files sheet cannot place an entry under its root there.
 * That is a pre-existing server path-format quirk outside these fixes (a
 * POSIX server never emits it); strip the prefix from listings so the same
 * assertions hold on every host.
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

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session, and that session
 * creation re-activates the pane. A tab opened BEFORE it lands is swapped out
 * from under the test (a test-only race: a person needs seconds to reach the
 * drawer). An agent that fails to start also ends the warm-up.
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

/** Counts of the frames the page sends over `/terminal/ws`, by message type. */
function trackTerminalFrames(page: Page): { count: (type: string) => number } {
  const counts = new Map<string, number>()
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/terminal/ws')) return
    socket.on('framesent', (frame) => {
      const message = JSON.parse(String(frame.payload)) as { type?: string }
      if (message.type) counts.set(message.type, (counts.get(message.type) ?? 0) + 1)
    })
  })
  return { count: (type) => counts.get(type) ?? 0 }
}

/**
 * Boot the mobile shell on the project. `settleAgentWarmup` is for projects
 * that start with an empty workspace (the launcher warm-up runs there); a
 * restored workspace has no launcher, so there is nothing to wait for.
 */
async function openShell(
  page: Page,
  project: Project,
  options: { settleAgentWarmup?: boolean } = {}
): Promise<void> {
  const warmedUp = watchAgentWarmup(page)
  await normalizeListingPaths(page)
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  // The header names the active project until a tab takes over: seeing it
  // proves the shell booted into our fresh project.
  await expect(
    page.getByRole('heading', { level: 1, name: project.name, exact: true })
  ).toBeVisible()
  if (options.settleAgentWarmup) await Promise.race([warmedUp, sleep(10_000)])
}

function drawerOf(page: Page): Locator {
  return page.locator('#mobile-chat-drawer')
}

async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  const drawer = drawerOf(page)
  await expect(drawer).toBeVisible()
  return drawer
}

/** Tap a drawer row (a tab or terminal), which closes the drawer. */
async function tapDrawerRow(page: Page, name: string | RegExp): Promise<void> {
  const drawer = await openDrawer(page)
  await drawer.getByRole('button', { name, exact: typeof name === 'string' }).tap()
  await expect(drawer).toBeHidden()
}

/** Open a file from the header's Files sheet (the sheet closes on open). */
async function openFileFromFiles(page: Page, fileName: string): Promise<void> {
  await page.getByRole('button', { name: 'Browse files' }).tap()
  await page.getByRole('button', { name: `Open ${fileName}`, exact: true }).tap()
}

async function goToSnapshots(page: Page): Promise<void> {
  const drawer = await openDrawer(page)
  await drawer.getByRole('button', { name: 'Snapshots', exact: true }).tap()
  await expect(page).toHaveURL(/#\/snapshots$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeVisible()
}

/**
 * Close the shell's terminal through the header control (every test that opens
 * one frees its PTY slot). The drawer's own close button is not used: the
 * confirm dialog it raises renders under the drawer's overlay.
 */
async function closeTerminal(page: Page): Promise<void> {
  await tapDrawerRow(page, /^Terminal \d+$/)
  await page.getByRole('button', { name: 'Close terminal', exact: true }).tap()
  // The confirm dialog is the one holding the "Don't ask again" checkbox.
  const confirm = page
    .getByText("Don't ask again when closing terminals")
    .locator('xpath=ancestor::div[.//button[normalize-space()="Close"]][1]')
    .getByRole('button', { name: 'Close', exact: true })
  await confirm.tap()
  await expect(confirm).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toHaveCount(0)
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

/**
 * The palette's Pinned and Recent groups are read from the server store (one
 * list for the whole host), so a test that looks at them seeds both itself and
 * puts them back empty afterwards.
 */
async function seedPaletteLists(commandIds: string[]): Promise<void> {
  for (const key of ['settings/pinned-commands', 'settings/recent-commands']) {
    await wsRequest(E2E_BASE_URL, 'store_write', { key, value: { _version: 1, data: commandIds } })
  }
}

test('palette lists New Project, never Open Shortcut Menu, and New Project opens its modal', async ({
  page
}) => {
  const project = await createProject()
  // "Open Shortcut Menu" is pinned and recent from an earlier desktop session:
  // the stale ids must not bring the command back under either group.
  await seedPaletteLists(['open-shortcut-menu', 'new-terminal'])
  try {
    await openShell(page, project)

    await page.getByRole('button', { name: 'Command palette' }).tap()
    const search = page.getByPlaceholder('Search commands, projects, settings...')
    await expect(search).toBeVisible()

    // The groups are rendered with the surviving command in them, so the
    // absence below is not a not-yet-rendered artefact.
    // (cmdk gives a group no accessible name, so a group is found by its heading.)
    for (const heading of ['Pinned', 'Recent']) {
      const group = page
        .locator('[cmdk-group]')
        .filter({ has: page.getByText(heading, { exact: true }) })
      await expect(group.getByRole('option', { name: /^New Terminal/ })).toBeVisible()
      await expect(group.getByRole('option')).toHaveCount(1)
    }
    await expect(page.getByRole('option', { name: /^New Project/ })).toHaveCount(1)
    await expect(page.getByRole('option', { name: /Open Shortcut Menu/ })).toHaveCount(0)

    // Search cannot surface it either: nothing matches the command's own name.
    await search.fill('open shortcut menu')
    await expect(page.getByText('No commands found.')).toBeVisible()
    await search.fill('')

    await page.getByRole('option', { name: /^New Project/ }).tap()

    // Selecting closes the palette and opens the New Project modal.
    await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()
    await expect(search).toBeHidden()
  } finally {
    await seedPaletteLists([])
  }
})

// ---------------------------------------------------------------------------
// Editor toolbar
// ---------------------------------------------------------------------------

// FIX 7 (a TOC button on a phone where the TOC is disabled) is superseded by
// the editor redesign (#943): the outline now renders on the mobile shell as a
// tick strip, so the toolbar's outline toggle drives something real there. The
// toggle stays and this row pins that it is not a dead control.
test('the editor toolbar keeps Source/Preview, Save and a live outline toggle on a phone', async ({
  page
}) => {
  const project = await createProject({ 'notes.md': '# Notes\n\nmobile toolbar content' })
  await openShell(page, project, { settleAgentWarmup: true })

  await openFileFromFiles(page, 'notes.md')

  const save = page.getByRole('button', { name: 'Save notes.md', exact: true })
  const sourceToggle = page.getByRole('radio', { name: 'Source', exact: true })
  const outlineToggle = page.getByRole('button', { name: 'Outline', exact: true })
  const strip = page.locator('[data-outline-strip]')
  await expect(save).toBeVisible()
  await expect(sourceToggle).toBeVisible()
  await expect(outlineToggle).toBeVisible()

  // The outline preference is host-wide (shared server store): the toggle is
  // driven both ways and put back, so no other test sees the change.
  const wasPressed = (await outlineToggle.getAttribute('aria-pressed')) === 'true'
  try {
    await expect(strip).toHaveCount(wasPressed ? 1 : 0)
    await outlineToggle.tap()
    await expect(outlineToggle).toHaveAttribute('aria-pressed', String(!wasPressed))
    await expect(strip).toHaveCount(wasPressed ? 0 : 1)
  } finally {
    if (((await outlineToggle.getAttribute('aria-pressed')) === 'true') !== wasPressed) {
      await outlineToggle.tap()
    }
  }
  await expect(outlineToggle).toHaveAttribute('aria-pressed', String(wasPressed))

  // Switching the view mode keeps the toolbar intact.
  await sourceToggle.tap()
  await expect(page.getByRole('radio', { name: 'Preview', exact: true })).toBeVisible()
  await expect(save).toBeVisible()
  await expect(outlineToggle).toBeVisible()
})

// ---------------------------------------------------------------------------
// /snapshots return
// ---------------------------------------------------------------------------

test('a drawer row for a non-chat tab returns from /snapshots to the workspace', async ({
  page
}) => {
  const project = await createProject({ 'notes.md': 'snapshots return content' })
  await openShell(page, project, { settleAgentWarmup: true })

  // One tab of each non-chat kind the drawer lists on a plain project: an
  // editor, a terminal and git history.
  await openFileFromFiles(page, 'notes.md')
  await expect(page.getByRole('button', { name: 'Save notes.md', exact: true })).toBeVisible()
  const drawer = await openDrawer(page)
  await drawer.getByRole('button', { name: 'New terminal', exact: true }).tap()
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible()
  const drawerAgain = await openDrawer(page)
  await drawerAgain.getByRole('button', { name: 'Git history', exact: true }).tap()
  await expect(page.getByRole('button', { name: 'Refresh history' })).toBeVisible()

  const rows: Array<{ row: string | RegExp; landed: Locator }> = [
    {
      row: 'notes.md',
      landed: page.getByRole('button', { name: 'Save notes.md', exact: true })
    },
    { row: /^Terminal \d+$/, landed: page.getByRole('textbox', { name: 'Terminal input' }) },
    { row: 'Git History', landed: page.getByRole('button', { name: 'Refresh history' }) }
  ]
  for (const { row, landed } of rows) {
    await goToSnapshots(page)
    // Snapshots has no tab picker of its own: the drawer row is the chooser.
    // The tab is activated, the drawer closes and the route goes back to `/`.
    await tapDrawerRow(page, row)
    await expect(page).toHaveURL(/#\/$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeHidden()
    await expect(landed).toBeVisible()
  }

  // On the workspace route a row only switches tabs: the route is unchanged.
  await tapDrawerRow(page, 'notes.md')
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.getByRole('button', { name: 'Save notes.md', exact: true })).toBeVisible()

  await closeTerminal(page)
})

test('a drawer row for a chat returns from /snapshots to that chat route, not to /', async ({
  page
}) => {
  const project = await createProject()
  await openShell(page, project, { settleAgentWarmup: true })

  // [DURATION:3] ends the fake agent's turn quickly; the chat tab title is the
  // first prompt, which names its drawer row.
  const prompt = `[DURATION:3] shellfix chat ${randomUUID().slice(0, 6)}`
  const composer = page.locator('[data-composer-editor="true"][aria-label="Agent prompt"]').first()
  await composer.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/c\/sess-[\w-]+$/)
  const chatRoute = new URL(page.url()).hash

  await goToSnapshots(page)
  await tapDrawerRow(page, prompt)

  // Chat rows already route through setActiveTab to /c/<id>; the return to `/`
  // must not run for them.
  await expect(page).toHaveURL(/#\/c\/sess-[\w-]+$/)
  expect(new URL(page.url()).hash).toBe(chatRoute)
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })).toBeHidden()
})

// ---------------------------------------------------------------------------
// Split collapse
// ---------------------------------------------------------------------------

test('a split tree synced from desktop collapses to the active leaf on a phone', async ({
  page
}) => {
  const project = await createProject({
    'a.md': 'LEAF-A-CONTENT',
    'b.md': 'LEAF-B-CONTENT'
  })
  await seedSplitWorkspace(project, 'a.md', 'b.md')
  const frames = trackTerminalFrames(page)
  await openShell(page, project)

  // Active leaf (leaf-b) only: no second leaf, no resizable split handle.
  await expect(page.getByText('LEAF-B-CONTENT')).toBeVisible()
  await expect(page.getByText('LEAF-A-CONTENT')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save b.md', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save a.md', exact: true })).toHaveCount(0)
  await expect(page.getByRole('separator')).toHaveCount(0)
  await expect(page.locator('[data-pane-content]')).toHaveCount(1)
  // The collapsed leaf reads as a single-leaf workspace: no active-pane ring.
  await expect(page.locator('[data-pane-content="leaf-b"]')).not.toHaveClass(/ring-1/)

  // The drawer still lists the tabs of both leaves.
  const drawer = await openDrawer(page)
  await expect(drawer.getByRole('button', { name: 'a.md', exact: true })).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'b.md', exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: 'New terminal', exact: true }).tap()
  const terminalInput = page.getByRole('textbox', { name: 'Terminal input' })
  await expect(terminalInput).toBeVisible()
  expect(frames.count('spawn')).toBe(1)

  // Tapping a row for a tab in the other leaf makes that leaf the only one
  // rendered; the terminal's leaf is unmounted, its PTY is not.
  await tapDrawerRow(page, 'a.md')
  await expect(page.getByText('LEAF-A-CONTENT')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save a.md', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save b.md', exact: true })).toHaveCount(0)
  await expect(page.locator('[data-pane-content]')).toHaveCount(1)
  await expect(page.locator('[data-pane-content="leaf-a"]')).toBeVisible()
  await expect(terminalInput).toHaveCount(0)

  // The shared tree is not modified by the collapse.
  const manifest = await readManifest(project)
  expect(manifest?.topology?.type).toBe('split')
  expect(manifest?.topology?.children?.map((child) => child.id)).toEqual(['leaf-a', 'leaf-b'])

  // Back to the terminal: it is shown again, and nothing was killed or
  // respawned along the way (one spawn for the whole test, no kill).
  await tapDrawerRow(page, /^Terminal \d+$/)
  await expect(terminalInput).toBeVisible()
  await expect(page.getByText('LEAF-A-CONTENT')).toHaveCount(0)
  expect(frames.count('kill')).toBe(0)
  expect(frames.count('spawn')).toBe(1)

  await closeTerminal(page)
})

// ---------------------------------------------------------------------------
// Files breadcrumb
// ---------------------------------------------------------------------------

const DEEP_FOLDERS = 'src/renderer/lib'

const folderPath = (page: Page): Locator => page.getByRole('navigation', { name: 'Folder path' })

test('the Files header path is tappable below the root: segments, back slide, persistence, root', async ({
  page
}) => {
  const project = await createProject({ [`${DEEP_FOLDERS}/deep.md`]: 'deep content' })
  await openShell(page, project)

  await page.getByRole('button', { name: 'Browse files' }).tap()
  // At the root the path is the plain "Project files" text, no segments.
  await expect(page.getByText('Project files', { exact: true })).toBeVisible()
  await expect(folderPath(page)).toHaveCount(0)

  await page.getByRole('button', { name: 'Open folder src', exact: true }).tap()
  await page.getByRole('button', { name: 'Open folder renderer', exact: true }).tap()
  await page.getByRole('button', { name: 'Open folder lib', exact: true }).tap()

  // proj > src > renderer > lib: ancestors are buttons, the current folder is
  // plain text marked as the current page, the separators are decorative.
  const path = folderPath(page)
  await expect(path).toBeVisible()
  await expect(path.getByRole('button')).toHaveText([project.name, 'src', 'renderer'])
  await expect(path.locator('[aria-current="page"]')).toHaveText('lib')
  await expect(path.getByRole('button', { name: 'lib' })).toHaveCount(0)
  await expect(path.locator('svg[aria-hidden="true"]')).toHaveCount(3)
  await expect(page.getByRole('list', { name: 'Files in lib' })).toBeVisible()

  // Tapping an ancestor jumps straight there, sliding back.
  await path.getByRole('button', { name: 'src', exact: true }).tap()
  await expect(path.locator('[aria-current="page"]')).toHaveText('src')
  await expect(path.getByRole('button')).toHaveText([project.name])
  await expect(page.getByTestId('mobile-folder-view')).toHaveAttribute(
    'data-navigation-direction',
    'back'
  )
  await expect(page.getByRole('list', { name: 'Files in src' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Open folder renderer', exact: true })
  ).toBeVisible()

  // The folder is persisted for the project (the server store holds it) ...
  await expect
    .poll(
      async () =>
        JSON.stringify(
          await wsRequest(E2E_BASE_URL, 'store_read', { key: `mobile-file-explorer/${project.id}` })
        ),
      { message: 'persisted Files folder' }
    )
    .toMatch(/\/src"/)
  // ... and restored on the next visit.
  await page.reload()
  await expect(
    page.getByRole('heading', { level: 1, name: project.name, exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Browse files' }).tap()
  await expect(folderPath(page).locator('[aria-current="page"]')).toHaveText('src')

  // The first segment is the project root: tapping it ends the breadcrumb.
  await folderPath(page).getByRole('button', { name: project.name, exact: true }).tap()
  await expect(folderPath(page)).toHaveCount(0)
  await expect(page.getByText('Project files', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to parent folder' })).toBeDisabled()
})

test('breadcrumb segments have a 44px vertical hit area without growing the header', async ({
  page
}) => {
  const project = await createProject({ [`${DEEP_FOLDERS}/deep.md`]: 'deep content' })
  await openShell(page, project)

  await page.getByRole('button', { name: 'Browse files' }).tap()
  const refresh = page.getByRole('button', { name: 'Refresh current folder' })
  await expect(refresh).toBeVisible()
  const rootToolbarY = (await refresh.boundingBox())?.y
  await page.getByRole('button', { name: 'Open folder src', exact: true }).tap()
  await page.getByRole('button', { name: 'Open folder renderer', exact: true }).tap()
  await page.getByRole('button', { name: 'Open folder lib', exact: true }).tap()

  const path = folderPath(page)
  await expect(path).toBeVisible()
  // The path row takes the place of "Project files": nothing below it moves.
  expect((await refresh.boundingBox())?.y).toBe(rootToolbarY)

  const renderer = path.getByRole('button', { name: 'renderer', exact: true })
  const box = await renderer.boundingBox()
  if (!box) throw new Error('breadcrumb segment has no layout box')
  expect(box.height).toBeLessThan(44)

  // The hit-slop is a vertical overlay: a point 18px above and below the text
  // row still lands on the segment (a clipped overlay would hit nothing), and
  // the segment's own width is not widened.
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  for (const offset of [-18, 18]) {
    const hit = await renderer.evaluate(
      (element, point) => {
        const target = document.elementFromPoint(point.x, point.y)
        return target !== null && element.contains(target)
      },
      { x: centerX, y: centerY + offset }
    )
    expect(hit, `point ${offset}px from the segment centre`).toBe(true)
  }

  // A real tap inside the slop, below the text row, navigates.
  await renderer.tap({ position: { x: box.width / 2, y: box.height / 2 + 18 } })
  await expect(path.locator('[aria-current="page"]')).toHaveText('renderer')
})

test('a long path clips from the left and keeps the current folder visible', async ({ page }) => {
  const longFolders = [
    'aaaaaaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbbbbbb',
    'cccccccccccccccccccc',
    'dddddddddddddddddddd',
    'current-folder'
  ]
  const project = await createProject({ [`${longFolders.join('/')}/x.md`]: 'long path' })
  await openShell(page, project)

  await page.getByRole('button', { name: 'Browse files' }).tap()
  for (const folder of longFolders) {
    await page.getByRole('button', { name: `Open folder ${folder}`, exact: true }).tap()
  }

  const path = folderPath(page)
  await expect(path.locator('[aria-current="page"]')).toHaveText('current-folder')
  const navBox = await path.boundingBox()
  const currentBox = await path.locator('[aria-current="page"]').boundingBox()
  const rootBox = await path.getByRole('button', { name: project.name, exact: true }).boundingBox()
  const viewport = page.viewportSize()
  if (!navBox || !currentBox || !rootBox || !viewport) throw new Error('missing layout box')

  // The current folder is fully visible inside the path row and the viewport;
  // the path overflows to the left (the project root sits left of the row).
  expect(currentBox.x).toBeGreaterThanOrEqual(navBox.x - 0.5)
  expect(currentBox.x + currentBox.width).toBeLessThanOrEqual(navBox.x + navBox.width + 0.5)
  expect(currentBox.x + currentBox.width).toBeLessThanOrEqual(viewport.width)
  expect(rootBox.x).toBeLessThan(navBox.x)
  // Nothing pushes the page sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)

  // The nearest ancestor stays tappable beside the current folder.
  await path.getByRole('button', { name: 'dddddddddddddddddddd', exact: true }).tap()
  await expect(path.locator('[aria-current="page"]')).toHaveText('dddddddddddddddddddd')
})

// ---------------------------------------------------------------------------
// Desktop stays as it was
// ---------------------------------------------------------------------------

test.describe('desktop layout is unchanged', () => {
  test('palette, outline and the split tree render as before at 1440px', async ({ browser }) => {
    const project = await createProject({
      'a.md': 'LEAF-A-CONTENT',
      'b.md': 'LEAF-B-CONTENT'
    })
    await seedSplitWorkspace(project, 'a.md', 'b.md')
    // A fresh desktop-sized context: the file-level phone options only apply
    // to the fixture context, not to contexts created from the browser.
    const context = await browser.newContext({
      baseURL: E2E_BASE_URL,
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark'
    })
    try {
      const page = await context.newPage()
      await openWorkspace(page)

      // Both leaves render, the active one carries its ring, each has its outline toggle.
      await expect(page.getByText('LEAF-A-CONTENT')).toBeVisible()
      await expect(page.getByText('LEAF-B-CONTENT')).toBeVisible()
      await expect(page.locator('[data-pane-content]')).toHaveCount(2)
      await expect(page.locator('[data-pane-content="leaf-b"]')).toHaveClass(/ring-1/)
      await expect(page.getByRole('button', { name: 'Outline', exact: true })).toHaveCount(2)

      // The palette keeps "Open Shortcut Menu" and has no "New Project".
      await page.keyboard.press('ControlOrMeta+k')
      await expect(page.getByPlaceholder('Search commands, projects, settings...')).toBeVisible()
      await expect(page.getByRole('option', { name: /^New Terminal/ })).toBeVisible()
      await expect(page.getByRole('option', { name: /^Open Shortcut Menu/ })).toBeVisible()
      await expect(page.getByRole('option', { name: /^New Project/ })).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})
