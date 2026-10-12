import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type APIRequestContext,
  chromium,
  expect,
  type Locator,
  type Page,
  test
} from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile header and palette parity E2E (spec-mobile-header-palette-parity) on
 * termul-server, on a phone-sized touch viewport.
 *
 * Two promises are checked against a real layout and a real relay:
 *
 * 1. One client-only project switch. The command palette's project entries run
 *    the same switch as the project sheet on the phone shell: the palette
 *    closes and the header lands on the picked project, with no `switch_project`
 *    frame on the wire (switching never reaches the host). A desktop-width
 *    shell keeps the plain client-side select.
 * 2. A terminal keeps its navigation. The terminal ⋯ sheet lists Git changes,
 *    Files, Command palette and Project settings after Command history and
 *    before a set-apart Close terminal, each row 44px tall, and each one opens
 *    its destination once and closes the sheet.
 *
 * Not observable here, by design (left to the unit tests): a project without a
 * path and the Tauri gates (the server refuses to register a pathless project,
 * and the browser is never Tauri), an archived target (the seeded server has no
 * archive operation), and the Cmd/Ctrl+1-9 shortcut.
 *
 * Every test builds its own project(s) under the workspace root, so it owns its
 * chats and terminals and never depends on another suite's state. Project names
 * start with `hpp-` on purpose: other suites select `proj-a`..`proj-x` by name
 * prefix. Sheets are modal (the header goes aria-hidden while one is open), so
 * header controls read while a sheet is open use `includeHidden`.
 */

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

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
  userAgent: MOBILE_USER_AGENT
})

test.setTimeout(120_000)

/** Server store key holding the web client's last selected project (issue #855). */
const ACTIVE_PROJECT_KEY = 'web-active-project'

/**
 * Every test pins the selected project, and the store outlives this file: put
 * back whatever the suites before it left, so the suites after it (which
 * assume the seeded default project) see the same server they would without us.
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

interface ProjectOptions {
  /** A git repo with one empty commit on `main`. */
  git?: boolean
  /** Files to create in the project folder (name to content). */
  files?: Record<string, string>
}

/** Register a project under the workspace root, so each test owns its chats and terminals. */
async function createProject(
  request: APIRequestContext,
  name: string,
  { git = false, files = {} }: ProjectOptions = {}
): Promise<void> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT unset — run under tests/e2e global-setup')
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(dir, fileName), content)
  }
  if (git) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    execFileSync(
      'git',
      [
        '-c',
        'user.email=e2e@termul',
        '-c',
        'user.name=e2e',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init'
      ],
      { cwd: dir }
    )
  }
  const res = await request.post(`${E2E_BASE_URL}/projects`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    data: { id: `e2e-${name}`, name, path: dir, color: 'blue' }
  })
  expect(res.ok(), `registering project ${name}`).toBe(true)
}

function header(page: Page, { hidden = false } = {}): Locator {
  return page.getByRole('banner', { includeHidden: hidden })
}

/** The header title: `h1#mobile-shell-title`. */
function title(page: Page): Locator {
  return header(page).getByRole('heading', { level: 1 })
}

/** The subtitle button (project · branch · Local/Worktree); its name ends in "switch project". */
function subtitle(page: Page): Locator {
  return page.getByRole('button', { name: /, switch project$/, includeHidden: true })
}

/**
 * A header control by exact accessible name. Always `includeHidden`: while a
 * modal sheet is open the header is aria-hidden, and these controls are still
 * read (their focus) in that window.
 */
function headerButton(page: Page, name: string): Locator {
  return header(page, { hidden: true }).getByRole('button', {
    name,
    exact: true,
    includeHidden: true
  })
}

/** The one visually hidden live region the shell announces through. */
function liveRegion(page: Page): Locator {
  return page.locator('[data-shell-live-region]')
}

/**
 * Open the app on the phone viewport (token bootstrap), already on `projectName`.
 *
 * The web client restores the last selected project from the server's store
 * (issue #855), and that store outlives a test. Pinning the selection first
 * makes every test start in its own fresh project, never in the previous
 * test's with its chats and terminals.
 */
async function openMobileWorkspace(page: Page, projectName: string): Promise<void> {
  await wsRequest(E2E_BASE_URL, 'store_write', {
    key: ACTIVE_PROJECT_KEY,
    value: { _version: 1, data: `e2e-${projectName}` }
  })
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN,
    { timeout: 60_000 }
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  await expect(title(page)).toBeVisible()
  await expect(subtitle(page)).toContainText(projectName)
  // The empty pane's launcher, with its agent loaded, is the last piece of the
  // project's hydration. Acting earlier races the workspace restore, which can
  // replace a tab the test just opened.
  await expect(
    page.getByRole('button', { name: 'Agent and model. Currently Fake Longrun' })
  ).toBeVisible()
}

/**
 * Type a prompt into the empty pane's launcher composer and submit it. The
 * composer is inert until the agent is prepared (a tap before then never
 * focuses it, and the typed text is lost), and Enter is a no-op until "Start
 * agent chat" is enabled, so each is awaited instead of raced. Resolves once
 * the header names the new chat.
 */
async function startChat(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Agent prompt' })
  await expect(composer).toHaveAttribute('contenteditable', 'true')
  // The composer can flip inert again while the agent finishes preparing, so a
  // tap can miss: tap until it holds focus.
  await expect(async () => {
    await composer.tap()
    await expect(composer).toBeFocused({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await page.keyboard.type(prompt)
  await expect(page.getByRole('button', { name: 'Start agent chat' })).toBeEnabled()
  await composer.press('Enter')
  await expect(title(page)).toContainText(prompt.slice(0, 24))
}

interface ProjectSwitchWire {
  /** The project ids of every `switch_project` request the page has sent, in order. */
  requested: () => string[]
}

/**
 * Record every `switch_project` frame the page sends at the relay wire. Switching
 * is client-only, so the list must stay empty; frames always pass through.
 * Must run before the page loads: the relay socket opens at boot.
 */
async function watchProjectSwitches(page: Page): Promise<ProjectSwitchWire> {
  const requested: string[] = []
  await page.routeWebSocket(
    (url) => url.pathname === '/ws',
    (client) => {
      const server = client.connectToServer()
      client.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          type?: string
          payload?: { projectId?: string }
        }
        if (frame.type === 'switch_project') requested.push(frame.payload?.projectId ?? '')
        server.send(message)
      })
      server.onMessage((message) => client.send(message))
    }
  )
  return { requested: () => [...requested] }
}

const PALETTE_SEARCH_PLACEHOLDER = 'Search commands, projects, settings...'

function closePaletteButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Close command palette' })
}

/**
 * Open the command palette from the ⋯ sheet of the current tab: the header ⋯
 * ("More") for a chat or tab, "Terminal actions" for a terminal.
 */
async function openPalette(page: Page, from: 'more' | 'terminal' = 'more'): Promise<void> {
  await headerButton(page, from === 'more' ? 'More' : 'Terminal actions').tap()
  await page
    .locator(from === 'more' ? '#mobile-header-more-sheet' : '#mobile-terminal-actions-sheet')
    .getByRole('button', { name: 'Command palette', exact: true })
    .tap()
  await expect(closePaletteButton(page)).toBeVisible()
}

/** Pick `projectName` in the open palette: search it (one entry is left), tap it, the palette closes. */
async function pickProject(page: Page, projectName: string): Promise<void> {
  await page.getByPlaceholder(PALETTE_SEARCH_PLACEHOLDER).fill(projectName)
  // The entry's label is the project name; its description is the path, which
  // only contains the name, so an exact text match picks the one entry.
  const entry = page
    .getByRole('option')
    .filter({ has: page.getByText(projectName, { exact: true }) })
  await expect(entry).toHaveCount(1)
  await entry.tap()
  await expect(closePaletteButton(page)).toBeHidden()
}

function projectSheet(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Projects' })
}

/**
 * Wait for a bottom sheet to finish sliding in: its bottom edge sits on the
 * viewport bottom. A `force` tap skips Playwright's stability check, and a tap
 * on a row that is still sliding up lands below the viewport.
 */
async function sheetSettled(page: Page, sheet: Locator): Promise<void> {
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')
  await expect
    .poll(async () => {
      const rect = await box(sheet)
      return Math.round(rect.y + rect.height)
    })
    .toBe(viewport.height)
}

/** One project row in the sheet (its name starts with the project name, then any badge). */
function projectRow(page: Page, projectName: string): Locator {
  const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return projectSheet(page).getByRole('button', { name: new RegExp(`^${escaped}`) })
}

async function box(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('element has no bounding box')
  return rect
}

/** Every row of the sheet keeps the 44px touch target. */
async function expectRowsAtLeast44(rows: Locator): Promise<void> {
  for (const row of await rows.all()) {
    expect((await box(row)).height).toBeGreaterThanOrEqual(44)
  }
}

/** Open a new terminal from the header ⋯ sheet (no tab open: the sheet still offers it). */
async function openNewTerminal(page: Page): Promise<string> {
  await headerButton(page, 'More').tap()
  await page
    .locator('#mobile-header-more-sheet')
    .getByRole('button', { name: 'New terminal', exact: true })
    .tap()
  await expect(title(page)).toHaveText(/^Terminal \d+$/)
  return title(page).innerText()
}

// ---------------------------------------------------------------------------
// The palette runs the project sheet's switch
// ---------------------------------------------------------------------------

test('a palette pick closes the palette and lands on the project without a host request', async ({
  page,
  request
}) => {
  await createProject(request, 'hpp-pick-from')
  await createProject(request, 'hpp-pick-to')
  const wire = await watchProjectSwitches(page)
  await openMobileWorkspace(page, 'hpp-pick-from')

  await openPalette(page)
  await pickProject(page, 'hpp-pick-to')

  await expect(subtitle(page)).toHaveText('hpp-pick-to')
  await expect(subtitle(page)).toHaveAccessibleName('hpp-pick-to, switch project')
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  expect(wire.requested()).toEqual([])
})

test('the active project is not a palette target and the sheet follows the pick', async ({
  page,
  request
}) => {
  await createProject(request, 'hpp-busy-a')
  await createProject(request, 'hpp-busy-b')
  const wire = await watchProjectSwitches(page)
  await openMobileWorkspace(page, 'hpp-busy-a')

  // The active project is not a target: the palette closes, nothing changes.
  await openPalette(page)
  await pickProject(page, 'hpp-busy-a')
  await expect(subtitle(page)).toHaveText('hpp-busy-a')

  await openPalette(page)
  await pickProject(page, 'hpp-busy-b')
  await expect(subtitle(page)).toHaveText('hpp-busy-b')

  await subtitle(page).tap()
  await expect(projectSheet(page)).toBeVisible()
  await sheetSettled(page, projectSheet(page))
  await expect(projectRow(page, 'hpp-busy-b')).toContainText('Current')
  await expect(projectRow(page, 'hpp-busy-a')).toBeEnabled()
  expect(wire.requested()).toEqual([])
})

// ---------------------------------------------------------------------------
// Terminal ⋯ sheet keeps the navigation
// ---------------------------------------------------------------------------

test('terminal ⋯ sheet lists the navigation rows before a set-apart Close terminal, every row 44px', async ({
  page,
  request
}) => {
  await createProject(request, 'hpp-term-rows', { git: true })
  await openMobileWorkspace(page, 'hpp-term-rows')
  const name = await openNewTerminal(page)

  const actions = headerButton(page, 'Terminal actions')
  await actions.tap()
  const sheet = page.getByRole('dialog', { name })
  await expect(sheet).toBeVisible()
  await expect(actions).toHaveAttribute('aria-controls', 'mobile-terminal-actions-sheet')

  // The project has a path: the header ⋯ sheet's navigation rows sit between
  // Command history and Close terminal, without New terminal (the header ✎ is
  // New terminal in a terminal).
  const rows = sheet.getByRole('button').filter({ hasNotText: /^Close$/ })
  await expect(rows).toHaveText([
    'Rename terminal',
    'Restart terminal',
    'Command history',
    'Git changes',
    'Files',
    'Command palette',
    'Project settings',
    'Close terminal'
  ])
  await expect(sheet.getByRole('button', { name: 'New terminal' })).toHaveCount(0)
  await expectRowsAtLeast44(rows)

  // Close terminal is destructive and set apart: its wrapper (not the sheet
  // itself) carries the divider, a hairline plus the gap above, while the
  // navigation rows sit directly in the sheet.
  const close = sheet.getByRole('button', { name: 'Close terminal', exact: true })
  await expect(close).toHaveClass(/text-destructive/)
  const wrapper = await close.evaluate((el) => ({
    role: el.parentElement?.getAttribute('role') ?? null,
    borderTop: el.parentElement ? getComputedStyle(el.parentElement).borderTopWidth : null
  }))
  expect(wrapper).toEqual({ role: null, borderTop: '1px' })
  const settings = sheet.getByRole('button', { name: 'Project settings', exact: true })
  const settingsBox = await box(settings)
  const closeBox = await box(close)
  expect(closeBox.y - (settingsBox.y + settingsBox.height)).toBeGreaterThanOrEqual(8)
  const gitParentRole = await sheet
    .getByRole('button', { name: 'Git changes', exact: true })
    .evaluate((el) => el.parentElement?.getAttribute('role') ?? null)
  expect(gitParentRole).toBe('dialog')
})

test('each terminal ⋯ navigation row opens its destination once and closes the sheet', async ({
  page,
  request
}) => {
  await createProject(request, 'hpp-term-go', { git: true })
  await openMobileWorkspace(page, 'hpp-term-go')
  const name = await openNewTerminal(page)

  const actions = headerButton(page, 'Terminal actions')
  const sheet = page.getByRole('dialog', { name })
  const choose = async (row: string): Promise<void> => {
    await actions.tap()
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: row, exact: true }).tap()
    await expect(sheet).toBeHidden()
  }

  // Git changes and Files record ⋯ as their opener, so closing either lands
  // focus back on Terminal actions.
  await choose('Git changes')
  const git = page.getByRole('dialog', { name: 'Git changes' })
  await expect(git).toHaveCount(1)
  await expect(git).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(git).toBeHidden()
  await expect(actions).toBeFocused()

  await choose('Files')
  const files = page.getByRole('dialog', { name: 'hpp-term-go' })
  await expect(files).toHaveCount(1)
  await expect(files).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(files).toBeHidden()
  await expect(actions).toBeFocused()

  await choose('Command palette')
  await expect(closePaletteButton(page)).toHaveCount(1)
  await expect(page.getByPlaceholder(PALETTE_SEARCH_PLACEHOLDER)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(closePaletteButton(page)).toBeHidden()

  await choose('Project settings')
  const settings = page.getByRole('dialog', { name: 'Project Settings' })
  await expect(settings).toHaveCount(1)
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: 'Close Project Settings' }).tap()
  await expect(settings).toBeHidden()

  // The terminal is still the active tab: no row switched it away.
  await expect(title(page)).toHaveText(name)
})

test('from a terminal, ⋯ then Command palette switches the project like the sheet does', async ({
  page,
  request
}) => {
  await createProject(request, 'hpp-term-from')
  await createProject(request, 'hpp-term-to')
  const wire = await watchProjectSwitches(page)
  await openMobileWorkspace(page, 'hpp-term-from')
  await openNewTerminal(page)

  await openPalette(page, 'terminal')
  await pickProject(page, 'hpp-term-to')

  // The header lands on the picked project with no host request and no toast.
  await expect(subtitle(page)).toHaveText('hpp-term-to')
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  expect(wire.requested()).toEqual([])
})

// ---------------------------------------------------------------------------
// The header ⋯ sheet is unchanged
// ---------------------------------------------------------------------------

test('header ⋯ sheet keeps its rows, order, 44px and Close chat divider on a non-terminal tab', async ({
  page,
  request
}) => {
  await createProject(request, 'hpp-header', { git: true, files: { 'notes.md': '# notes' } })
  await openMobileWorkspace(page, 'hpp-header')
  const sheetRows = (sheet: Locator): Locator =>
    sheet.getByRole('button').filter({ hasNotText: /^Close$/ })
  const navigation = ['Git changes', 'Files', 'Command palette', 'New terminal', 'Project settings']

  // No tab open: the five navigation rows, no Close chat.
  await headerButton(page, 'More').tap()
  const sheet = page.getByRole('dialog', { name: 'Termul' })
  await expect(sheet).toBeVisible()
  await expect(sheetRows(sheet)).toHaveText(navigation)
  await expectRowsAtLeast44(sheetRows(sheet))
  await expect(sheet.getByRole('button', { name: 'Close chat' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // A chat tab: the same rows, then the destructive Close chat set apart by
  // the same divider the terminal sheet's Close terminal now uses.
  const prompt = 'header rows chat [DURATION:2]'
  await startChat(page, prompt)
  await headerButton(page, 'More').tap()
  const chatSheet = page.getByRole('dialog', { name: prompt })
  await expect(chatSheet).toBeVisible()
  await expect(sheetRows(chatSheet)).toHaveText([...navigation, 'Close chat'])
  await expectRowsAtLeast44(sheetRows(chatSheet))
  const closeChat = chatSheet.getByRole('button', { name: 'Close chat', exact: true })
  await expect(closeChat).toHaveClass(/text-destructive/)
  const wrapper = await closeChat.evaluate((el) => ({
    role: el.parentElement?.getAttribute('role') ?? null,
    borderTop: el.parentElement ? getComputedStyle(el.parentElement).borderTopWidth : null
  }))
  expect(wrapper).toEqual({ role: null, borderTop: '1px' })
  await page.keyboard.press('Escape')
  await expect(chatSheet).toBeHidden()

  // An editor tab: the navigation rows again, then Close tab (the guarded
  // editor close) in place of Close chat.
  await headerButton(page, 'More').tap()
  await chatSheet.getByRole('button', { name: 'Files', exact: true }).tap()
  const files = page.getByRole('dialog', { name: 'hpp-header' })
  await files.getByRole('button', { name: 'Open notes.md' }).tap()
  await expect(files).toBeHidden()
  await expect(title(page)).toHaveText('notes.md')
  await headerButton(page, 'More').tap()
  const editorSheet = page.getByRole('dialog', { name: 'notes.md' })
  await expect(editorSheet).toBeVisible()
  await expect(sheetRows(editorSheet)).toHaveText([...navigation, 'Close tab'])
  await expectRowsAtLeast44(sheetRows(editorSheet))
  await expect(editorSheet.getByRole('button', { name: 'Close chat' })).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Desktop width keeps the plain select
// ---------------------------------------------------------------------------

test.describe('desktop-width shell', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent: DESKTOP_USER_AGENT
  })

  test('a palette pick selects the project client-side and sends no switch_project', async ({
    page,
    request
  }) => {
    await createProject(request, 'hpp-desk-from')
    await createProject(request, 'hpp-desk-to')
    const wire = await watchProjectSwitches(page)
    await wsRequest(E2E_BASE_URL, 'store_write', {
      key: ACTIVE_PROJECT_KEY,
      value: { _version: 1, data: 'e2e-hpp-desk-from' }
    })
    await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
    await page.waitForFunction(
      (token) => localStorage.getItem('termul.webAuthToken') === token,
      E2E_TOKEN,
      { timeout: 60_000 }
    )
    await page.goto(`${E2E_BASE_URL}/#/`)
    // The desktop shell has no mobile header: the sidebar names the active project.
    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toHaveCount(0)
    await expect(page.locator('[aria-label="Project: hpp-desk-from (active)"]')).toBeVisible()

    await page.keyboard.press('Control+k')
    await expect(page.getByPlaceholder(PALETTE_SEARCH_PLACEHOLDER)).toBeVisible()
    // No touch-only close button on the desktop palette.
    await expect(closePaletteButton(page)).toHaveCount(0)
    await page.getByPlaceholder(PALETTE_SEARCH_PLACEHOLDER).fill('hpp-desk-to')
    await page
      .getByRole('option')
      .filter({ has: page.getByText('hpp-desk-to', { exact: true }) })
      .click()

    // The sidebar marks the picked project active, with no switch request.
    await expect(page.locator('[aria-label="Project: hpp-desk-to (active)"]')).toBeVisible()
    await expect(page.getByPlaceholder(PALETTE_SEARCH_PLACEHOLDER)).toBeHidden()
    expect(wire.requested()).toEqual([])
    await expect(liveRegion(page)).toHaveCount(0)
  })
})
