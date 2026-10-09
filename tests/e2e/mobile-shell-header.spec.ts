import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type APIRequestContext,
  chromium,
  expect,
  type Locator,
  type Page,
  test,
  type WebSocketRoute
} from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile shell header E2E on termul-server, on a phone-sized touch viewport.
 *
 * Covers spec-mobile-shell-header: the header is three 44px icon slots (☰, ✎,
 * ⋯) around a title block (the `h1` over the project · branch · Local/Worktree
 * subtitle button) plus a conditional attention pill. The functions of the old
 * seven-icon header live in the header ⋯ sheet (chat or tab context) and the
 * terminal ⋯ sheet (terminal context); the subtitle opens the project sheet
 * from the bottom.
 *
 * jsdom cannot measure any of the geometry claims (44px slots, nothing scrolls
 * sideways, the title truncating first, the 360px fold, the bottom sheets), so
 * those are asserted here against a real layout.
 *
 * Every test builds its own project(s) under the workspace root, so it owns its
 * chats and terminals and never depends on another suite's state. Sheets and
 * the drawer are modal (the header goes aria-hidden while one is open), so
 * controls read while a sheet is open use `includeHidden`.
 *
 * Two host-side behaviours cannot be produced on cue by the seeded server, so
 * the suite plays them at the wire, the way the web client receives them: a
 * `switch_project` that stays in flight and is then refused (the busy and
 * Failed rows), and the terminal socket's `exit_code_changed` event (the
 * "Last exit code N" row; the host derives the code from the shell's own
 * output, which this harness's Windows ConPTY shell does not emit reliably).
 *
 * Left to the unit tests: the 9+ overflow (it needs ten chats asking at once),
 * the zero-project and no-project states (the seeded server always has
 * projects), a worktree chat with no known branch, and the browser and canvas
 * tab titles.
 */

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'

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

/** The drawer's ☰ and pill both point `aria-controls` here. */
const DRAWER_ID = 'mobile-shell-drawer'

/** The drawer is the left sheet titled "Menu". */
function drawerOf(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Menu' })
}

/**
 * One open-chat row in the drawer. Its name is the chat title, followed by
 * ", <status>" while a status shows (Working, Needs you, New activity), so a
 * plain exact match on the title would miss a chat with a live status.
 */
function chatRow(drawer: Locator, chatTitle: string): Locator {
  const escaped = chatTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return drawer.getByRole('button', { name: new RegExp(`^${escaped}(, .+)?$`) })
}

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
  /** With `git`: check the commit out detached. */
  detached?: boolean
  /** Files to create in the project folder (name to content). */
  files?: Record<string, string>
}

/** Register a project under the workspace root, so each test owns its chats and terminals. */
async function createProject(
  request: APIRequestContext,
  name: string,
  { git = false, detached = false, files = {} }: ProjectOptions = {}
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
    if (detached) execFileSync('git', ['checkout', '-q', '--detach'], { cwd: dir })
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
function title(page: Page, { hidden = false } = {}): Locator {
  return header(page, { hidden }).getByRole('heading', { level: 1, includeHidden: hidden })
}

/** The subtitle button (project · branch · Local/Worktree); its name ends in "switch project". */
function subtitle(page: Page, { hidden = false } = {}): Locator {
  return page.getByRole('button', { name: /, switch project$/, includeHidden: hidden })
}

/**
 * A header control by exact accessible name. Always `includeHidden`: while a
 * modal sheet or the drawer is open the header is aria-hidden, and these
 * controls are still read (their aria state, focus) in that window.
 */
function headerButton(page: Page, name: string): Locator {
  return header(page, { hidden: true }).getByRole('button', {
    name,
    exact: true,
    includeHidden: true
  })
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
 * Type a prompt into a launcher composer and submit it. The composer is inert
 * until the agent is prepared (a tap before then never focuses it, and the
 * typed text is lost), and Enter is a no-op until "Start agent chat" is
 * enabled, so each is awaited instead of raced.
 */
async function submitPrompt(page: Page, launcher: Locator, prompt: string): Promise<void> {
  const composer = launcher.getByRole('textbox', { name: 'Agent prompt' })
  await expect(composer).toHaveAttribute('contenteditable', 'true')
  // The composer can flip inert again while the agent finishes preparing, so a
  // tap can miss: tap until it holds focus.
  await expect(async () => {
    await composer.tap()
    await expect(composer).toBeFocused({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await page.keyboard.type(prompt)
  await expect(launcher.getByRole('button', { name: 'Start agent chat' })).toBeEnabled()
  await composer.press('Enter')
  await expect(title(page)).toContainText(prompt.slice(0, 24))
}

/** Start a chat from the empty pane's launcher composer and wait for its title. */
async function startChatFromEmptyPane(page: Page, prompt: string): Promise<void> {
  await submitPrompt(page, page.locator('body'), prompt)
}

/**
 * Start another chat through the header ✎ "New chat" launcher.
 *
 * Each piece of the launcher mounts as its data arrives (the agent list, the
 * git probe that reveals the isolation picker), so the helper waits for each of
 * them (and, in `submitPrompt`, for the composer) instead of racing them.
 *
 * The launcher remembers the last isolation mode. `local` picks Local
 * explicitly, for a project whose previous chat used a worktree; choosing an
 * option closes the select with an exit animation and then returns focus to
 * its trigger, which must finish before the composer is focused or the late
 * focus return would take the keyboard back from it.
 */
async function startChatFromLauncher(
  page: Page,
  prompt: string,
  { local = false } = {}
): Promise<void> {
  await headerButton(page, 'New chat').tap()
  const launcher = page.getByRole('dialog', { name: 'Agent launcher' })
  await expect(
    launcher.getByRole('button', { name: 'Agent and model. Currently Fake Longrun' })
  ).toBeVisible()
  if (local) {
    const isolation = launcher.getByRole('combobox', { name: 'Isolation mode' })
    await isolation.tap()
    await page.getByRole('option', { name: 'Local', exact: true }).tap()
    await expect(page.getByRole('listbox')).toBeHidden()
    await expect(isolation).toBeFocused()
  }
  await submitPrompt(page, launcher, prompt)
}

interface ProjectSwitchWire {
  /** How many `switch_project` requests the page has sent so far. */
  requestCount: () => number
  /** Answer the oldest held request with the protocol's own failure frame. */
  refuse: (message: string) => void
  /** Let the oldest held request through to the server. */
  release: () => void
}

/**
 * Hold every `switch_project` request at the relay wire, so a switch stays in
 * flight until the test refuses or releases it. The seeded server offers no way
 * to make a switch slow or fail on cue, and the refusal is the protocol's own
 * failure frame, so the app handles it as it would a host-side one. Every other
 * frame passes through. Must run before the page loads: the relay socket opens
 * at boot.
 */
async function holdProjectSwitches(page: Page): Promise<ProjectSwitchWire> {
  let requests = 0
  // Each held request remembers the socket pair it arrived on: the page may
  // open more than one `/ws` connection, and the reply must go back on the same one.
  const held: Array<{
    id: string
    message: string | Buffer
    client: WebSocketRoute
    server: WebSocketRoute
  }> = []
  await page.routeWebSocket(
    (url) => url.pathname === '/ws',
    (client) => {
      const server = client.connectToServer()
      client.onMessage((message) => {
        const frame = JSON.parse(String(message)) as { id?: string; type?: string }
        if (frame.type === 'switch_project' && frame.id) {
          requests += 1
          held.push({ id: frame.id, message, client, server })
          return
        }
        server.send(message)
      })
      server.onMessage((message) => client.send(message))
    }
  )
  const next = (): (typeof held)[number] => {
    const request = held.shift()
    if (!request) throw new Error('no switch_project request is being held')
    return request
  }
  return {
    requestCount: () => requests,
    refuse: (message) => {
      const { id, client } = next()
      client.send(JSON.stringify({ id, ok: false, err: { code: 'no_agent', message } }))
    },
    release: () => {
      const { message, server } = next()
      server.send(message)
    }
  }
}

interface TerminalWire {
  /** PTY ids the page has attached to so far. */
  attachedCount: () => number
  /** Push the host's `exit_code_changed` event for every attached terminal. */
  exitCode: (code: number) => void
}

/**
 * Watch the terminal socket so the test can play the host's `exit_code_changed`
 * event. The host derives the code from the shell's own output, which this
 * harness's Windows ConPTY shell cannot produce on cue; the event frame is the
 * wire contract the web client consumes. Must run before the page loads.
 */
async function watchTerminalWire(page: Page): Promise<TerminalWire> {
  const attached = new Set<string>()
  let socket: WebSocketRoute | null = null
  await page.routeWebSocket(
    (url) => url.pathname === '/terminal/ws',
    (client) => {
      socket = client
      const server = client.connectToServer()
      client.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          type?: string
          payload?: { terminalId?: string }
        }
        if (frame.type === 'attach' && frame.payload?.terminalId) {
          attached.add(frame.payload.terminalId)
        }
        server.send(message)
      })
      server.onMessage((message) => client.send(message))
    }
  )
  return {
    attachedCount: () => attached.size,
    exitCode: (code) => {
      if (!socket) throw new Error('the terminal socket is not open')
      for (const terminalId of attached) {
        socket.send(
          JSON.stringify({
            type: 'event',
            payload: { type: 'exit_code_changed', terminal_id: terminalId, exit_code: code }
          })
        )
      }
    }
  }
}

async function box(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('element has no bounding box')
  return rect
}

/**
 * The `aria-label` of the button a hit test lands on at (x, y), or null. A tap
 * is no good for pinning a CSS hit area: Chromium's touch emulation snaps a tap
 * that just misses to a clickable nearby. `elementFromPoint` applies no such
 * adjustment, so it sees the area the CSS actually gives the control.
 */
async function buttonAt(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate(
    ([px, py]) =>
      document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label') ?? null,
    [x, y]
  )
}

/** A bottom sheet: full width, flush with the viewport bottom, capped at 85dvh. */
async function expectBottomSheet(page: Page, sheet: Locator): Promise<void> {
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')
  // Polling also waits out the slide-in animation.
  await expect
    .poll(async () => {
      const rect = await box(sheet)
      return Math.round(rect.y + rect.height)
    })
    .toBe(viewport.height)
  const rect = await box(sheet)
  expect(Math.round(rect.width)).toBe(viewport.width)
  expect(rect.height).toBeLessThanOrEqual(viewport.height * 0.85 + 1)
  const maxHeight = await sheet.evaluate((el) => Number.parseFloat(getComputedStyle(el).maxHeight))
  expect(maxHeight).toBeCloseTo(viewport.height * 0.85, 0)
}

/** Every row of the sheet keeps the 44px touch target. */
async function expectRowsAtLeast44(rows: Locator): Promise<void> {
  for (const row of await rows.all()) {
    expect((await box(row)).height).toBeGreaterThanOrEqual(44)
  }
}

/** Nothing in the header (or the page) scrolls sideways, and every control sits inside the viewport. */
async function expectNoSidewaysScroll(page: Page, controls: Locator[]): Promise<void> {
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')
  const overflow = await header(page).evaluate((bar) => ({
    barScrolls: bar.scrollWidth > bar.clientWidth,
    scrollers: [bar, ...bar.querySelectorAll('*')].filter((node) =>
      ['auto', 'scroll'].includes(getComputedStyle(node).overflowX)
    ).length,
    pageScrolls: document.documentElement.scrollWidth > window.innerWidth
  }))
  expect(overflow).toEqual({ barScrolls: false, scrollers: 0, pageScrolls: false })
  for (const control of controls) {
    const rect = await box(control)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width)
  }
}

// ---------------------------------------------------------------------------
// Header anatomy
// ---------------------------------------------------------------------------

test('header is three 44px icon slots plus the title block, with no sideways scroll', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-plain')
  await openMobileWorkspace(page, 'shdr-plain')

  const bar = header(page)
  await expect(title(page)).toHaveText('Termul')
  await expect(title(page)).toHaveId('mobile-shell-title')
  // A non-git project shows its name only, and the button names the project.
  await expect(subtitle(page)).toHaveText('shdr-plain')
  await expect(subtitle(page)).toHaveAccessibleName('shdr-plain, switch project')

  // Exactly ☰, subtitle, ✎ and ⋯; every removed icon is gone.
  await expect(bar.getByRole('button')).toHaveCount(4)
  for (const gone of [
    'Switch project',
    'Browse files',
    'Command palette',
    'New project',
    'Git changes',
    'Restart terminal',
    'Close terminal'
  ]) {
    await expect(bar.getByRole('button', { name: gone, exact: true })).toHaveCount(0)
  }

  const menu = headerButton(page, 'Open menu')
  const newChat = headerButton(page, 'New chat')
  const more = headerButton(page, 'More')
  for (const slot of [menu, newChat, more]) {
    const rect = await box(slot)
    expect(rect.width).toBeGreaterThanOrEqual(44)
    expect(rect.height).toBeGreaterThanOrEqual(44)
  }
  expect((await box(bar)).height).toBeGreaterThanOrEqual(56)
  await expectNoSidewaysScroll(page, [menu, subtitle(page), newChat, more])

  // ☰ opens the drawer and reports it.
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await menu.tap()
  await expect(drawerOf(page)).toBeVisible()
  const openMenu = headerButton(page, 'Open menu')
  await expect(openMenu).toHaveAttribute('aria-expanded', 'true')
  await expect(openMenu).toHaveAttribute('aria-controls', DRAWER_ID)
  await page.keyboard.press('Escape')
  await expect(drawerOf(page)).toBeHidden()

  // At 360px with no chat asking for attention there is no dot: the name stays
  // plain and the header still fits.
  await page.setViewportSize({ width: 360, height: 780 })
  await expect(menu).toHaveAccessibleName('Open menu')
  await expect(menu.locator('span[aria-hidden="true"]')).toHaveCount(0)
  await expectNoSidewaysScroll(page, [menu, subtitle(page), newChat, more])
})

// ---------------------------------------------------------------------------
// Subtitle and project sheet
// ---------------------------------------------------------------------------

test('subtitle shows project · branch · Local and opens the bottom project sheet', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-git', { git: true })
  await createProject(request, 'shdr-flat')
  await openMobileWorkspace(page, 'shdr-git')

  // Git project, outside a chat: the project's own branch and Local.
  await expect(subtitle(page)).toHaveText('shdr-git · main · Local')
  await expect(subtitle(page)).toHaveAccessibleName('shdr-git · main, switch project')

  // The (non-interactive) title is covered by the subtitle's hit area, which
  // spans the full header height: a tap in the middle of the title opens the sheet.
  const titleRect = await box(title(page))
  const titleCenter = {
    x: titleRect.x + titleRect.width / 2,
    y: titleRect.y + titleRect.height / 2
  }
  expect(await buttonAt(page, titleCenter.x, titleCenter.y)).toBe('shdr-git · main, switch project')
  await page.touchscreen.tap(titleCenter.x, titleCenter.y)
  const sheet = page.getByRole('dialog', { name: 'Projects' })
  await expect(sheet).toBeVisible()
  await expectBottomSheet(page, sheet)

  const opener = subtitle(page, { hidden: true })
  await expect(opener).toHaveAttribute('aria-expanded', 'true')
  await expect(opener).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(opener).toHaveAttribute('aria-controls', 'mobile-project-sheet')
  await expect(page.locator('#mobile-project-sheet')).toBeVisible()

  // The list keeps the current project marked and an always-visible Add project row.
  await expect(sheet.getByRole('button', { name: 'shdr-git Current' })).toBeDisabled()
  await expect(sheet.getByRole('button', { name: 'Add project' })).toBeVisible()
  await expectRowsAtLeast44(sheet.getByRole('button', { name: /^shdr-/ }))

  // ⌂ "Set as host default" (V-13) sits beside every row that is not the host
  // default, at the touch floor. The current project shows it too unless it
  // already is the host default, which the row's Default badge says.
  const flatDefault = sheet.getByRole('button', { name: 'Set "shdr-flat" as host default' })
  await expect(flatDefault).toBeVisible()
  const flatDefaultBox = await box(flatDefault)
  expect(flatDefaultBox.width).toBeGreaterThanOrEqual(44)
  expect(flatDefaultBox.height).toBeGreaterThanOrEqual(44)
  const currentRow = sheet.getByRole('listitem').filter({ hasText: 'shdr-git' })
  const currentIsDefault = (await currentRow.locator('[title^="Host default"]').count()) > 0
  await expect(
    currentRow.getByRole('button', { name: 'Set "shdr-git" as host default' })
  ).toHaveCount(currentIsDefault ? 0 : 1)
  // A row that carries the Default badge never offers the control.
  for (const row of await sheet
    .getByRole('listitem')
    .filter({ has: page.locator('[title^="Host default"]') })
    .all()) {
    await expect(row.getByRole('button', { name: /as host default$/ })).toHaveCount(0)
  }

  // Switching closes the sheet, updates the subtitle and returns focus to it.
  await sheet.getByRole('button', { name: 'shdr-flat', exact: true }).tap()
  await expect(sheet).toBeHidden()
  await expect(subtitle(page)).toHaveText('shdr-flat')
  await expect(subtitle(page)).toHaveAccessibleName('shdr-flat, switch project')
  await expect(subtitle(page)).toBeFocused()
})

test('the project sheet ⌂ control calls the default-project route for its own project only', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-home')
  await createProject(request, 'shdr-other')
  await openMobileWorkspace(page, 'shdr-home')
  // The host default is shared by every suite on this server: the route is
  // stubbed, so the tap proves the request without changing it.
  const bodies: unknown[] = []
  await page.route('**/projects/default', async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ json: { success: true } })
  })

  await subtitle(page).tap()
  const sheet = page.getByRole('dialog', { name: 'Projects' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Set "shdr-other" as host default' }).tap()

  await expect(page.getByText('"shdr-other" is now the host default')).toBeVisible()
  expect(bodies).toEqual([{ projectId: 'e2e-shdr-other' }])
  // Setting a default is not a switch: the current project is unchanged.
  await expect(sheet.getByRole('button', { name: /^shdr-home Current/ })).toBeDisabled()
})

test('project sheet returns focus on Escape and hardware back, and Add project opens the creation flow', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-sheet')
  await openMobileWorkspace(page, 'shdr-sheet')
  const sheet = page.getByRole('dialog', { name: 'Projects' })

  await subtitle(page).tap()
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(subtitle(page)).toBeFocused()

  // The sheet is registered with the overlay back stack: back closes it
  // instead of leaving the app.
  const appUrl = page.url()
  await subtitle(page).tap()
  await expect(sheet).toBeVisible()
  await page.goBack()
  await expect(sheet).toBeHidden()
  await expect(page).toHaveURL(appUrl)
  await expect(subtitle(page)).toBeFocused()

  // Add project closes the sheet, then opens the New project modal.
  await subtitle(page).tap()
  await sheet.getByRole('button', { name: 'Add project' }).tap()
  await expect(sheet).toBeHidden()
  await expect(page.getByText('Create New Project')).toBeVisible()
})

test('a refused project switch keeps the sheet open on the row, and a switch in flight ignores other rows', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-busy-a')
  await createProject(request, 'shdr-busy-b')
  await createProject(request, 'shdr-busy-c')
  const wire = await holdProjectSwitches(page)
  await openMobileWorkspace(page, 'shdr-busy-a')
  const sheet = page.getByRole('dialog', { name: 'Projects' })
  const row = (name: string): Locator => sheet.getByRole('button', { name: new RegExp(`^${name}`) })
  const [current, target, other] = ['shdr-busy-a', 'shdr-busy-b', 'shdr-busy-c']

  // Attempt 1: in flight the other rows stay focusable but are aria-disabled (a
  // native `disabled` would drop the focused row's focus); the current project
  // keeps its native `disabled`.
  await subtitle(page).tap()
  await expect(sheet).toBeVisible()
  await row(target).tap()
  await expect.poll(() => wire.requestCount()).toBe(1)
  await expect(row(target)).toBeFocused()
  for (const name of [target, other]) {
    await expect(row(name)).toHaveAttribute('aria-disabled', 'true')
    await expect(row(name)).toHaveJSProperty('disabled', false)
  }
  await expect(row(current)).toHaveJSProperty('disabled', true)
  await expect(row(current)).not.toHaveAttribute('aria-disabled', 'true')

  // The refusal keeps the sheet open, marks the row Failed, raises the existing
  // toast, leaves the focus on the row, and is logged with the project id and
  // the error message.
  const refusal = 'switch_project requires a live agent (e2e)'
  const logged = page.waitForRequest(
    (req) =>
      req.url().endsWith('/log/frontend-error') &&
      (req.postData() ?? '').includes('ProjectSwitcherDrawer')
  )
  wire.refuse(refusal)
  await expect(row(target)).toContainText('Failed')
  await expect(page.getByText(refusal)).toBeVisible()
  await expect(sheet).toBeVisible()
  await expect(row(target)).toBeFocused()
  expect(JSON.parse((await logged).postData() ?? '{}')).toMatchObject({
    level: 'warn',
    source: 'ProjectSwitcherDrawer',
    message: `Project switch failed for e2e-${target}: ${refusal}`
  })
  // The busy state ended: rows are tappable again.
  await expect(row(other)).not.toHaveAttribute('aria-disabled', 'true')

  // Dismissing the sheet clears the Failed badge and returns focus to the subtitle.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(subtitle(page)).toBeFocused()
  await expect(subtitle(page)).toHaveText(current)
  await subtitle(page).tap()
  await expect(sheet).toBeVisible()
  await expect(row(target)).not.toContainText('Failed')

  // Attempt 2: a tap on another row while busy is ignored (no second request,
  // the sheet stays, and focus follows the tap onto that row and stays there).
  // `force`: Playwright treats an aria-disabled row as not actionable.
  await row(target).tap()
  await expect.poll(() => wire.requestCount()).toBe(2)
  await row(other).tap({ force: true })
  await expect(row(other)).toBeFocused()
  await expect(sheet).toBeVisible()
  expect(wire.requestCount()).toBe(2)

  // Letting it through completes the switch: the sheet closes onto the subtitle.
  wire.release()
  await expect(sheet).toBeHidden()
  await expect(subtitle(page)).toHaveText(target)
  await expect(subtitle(page)).toBeFocused()
  expect(wire.requestCount()).toBe(2)
})

test('a worktree chat shows its chat/ branch and Worktree; another chat shows Local', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-tree', { git: true })
  await openMobileWorkspace(page, 'shdr-tree')
  await expect(subtitle(page)).toHaveText('shdr-tree · main · Local')

  // Launch the first chat in a new git worktree.
  const worktreePrompt = 'charlie worktree chat'
  await page.getByRole('combobox', { name: 'Isolation mode' }).tap()
  await page.getByRole('option', { name: 'New worktree' }).tap()
  await startChatFromEmptyPane(page, worktreePrompt)
  await expect(title(page)).toHaveText(worktreePrompt)
  await expect(subtitle(page)).toHaveText(/^shdr-tree · chat\/[0-9a-f]+ · Worktree$/)
  await expect(subtitle(page)).toHaveAccessibleName(/^shdr-tree · chat\/[0-9a-f]+, switch project$/)

  // A second chat in the project folder reads Local on main.
  const localPrompt = 'delta local chat'
  await startChatFromLauncher(page, localPrompt, { local: true })
  await expect(title(page)).toHaveText(localPrompt)
  await expect(subtitle(page)).toHaveText('shdr-tree · main · Local')

  // Back to the worktree chat through the drawer: the subtitle follows the chat.
  await headerButton(page, 'Open menu').tap()
  const drawer = drawerOf(page)
  await chatRow(drawer, worktreePrompt).tap()
  await expect(drawer).toBeHidden()
  await expect(title(page)).toHaveText(worktreePrompt)
  await expect(subtitle(page)).toHaveText(/^shdr-tree · chat\/[0-9a-f]+ · Worktree$/)
})

test('a detached HEAD project reads Detached HEAD in the subtitle', async ({ page, request }) => {
  await createProject(request, 'shdr-detached', { git: true, detached: true })
  await openMobileWorkspace(page, 'shdr-detached')
  await expect(subtitle(page)).toHaveText('shdr-detached · Detached HEAD · Local')
  await expect(subtitle(page)).toHaveAccessibleName('shdr-detached · Detached HEAD, switch project')
})

test('an editor tab is titled by its file, keeps the project subtitle and has no Close chat', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-edit', { git: true, files: { 'notes.md': '# notes' } })
  await openMobileWorkspace(page, 'shdr-edit')

  // Open the file from the Files sheet (header ⋯ → Files → the file row).
  await headerButton(page, 'More').tap()
  await page
    .getByRole('dialog', { name: 'Termul' })
    .getByRole('button', { name: 'Files', exact: true })
    .tap()
  const files = page.getByRole('dialog', { name: 'shdr-edit' })
  await files.getByRole('button', { name: 'Open notes.md' }).tap()
  await expect(files).toBeHidden()

  // Outside a chat the subtitle shows the active project's values.
  await expect(title(page)).toHaveText('notes.md')
  await expect(subtitle(page)).toHaveText('shdr-edit · main · Local')
  await expect(headerButton(page, 'New chat')).toBeVisible()

  // The header ⋯ sheet drops the chat-only row.
  await headerButton(page, 'More').tap()
  const sheet = page.getByRole('dialog', { name: 'notes.md' })
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveAccessibleDescription('shdr-edit · main · Local')
  await expect(sheet.getByRole('button').filter({ hasNotText: /^Close$/ })).toHaveText([
    'Git changes',
    'Files',
    'Command palette',
    'New terminal',
    'Project settings'
  ])
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // A Git History tab (drawer action) is titled "Git History".
  await headerButton(page, 'Open menu').tap()
  await drawerOf(page).getByRole('button', { name: 'Git history', exact: true }).tap()
  await expect(title(page)).toHaveText('Git History')
})

// ---------------------------------------------------------------------------
// Header ⋯ sheet
// ---------------------------------------------------------------------------

test('header ⋯ sheet lists the chat actions in order and returns focus to ⋯ on dismiss', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-menu', { git: true })
  await openMobileWorkspace(page, 'shdr-menu')
  const prompt = 'echo quick chat [DURATION:2]'
  await startChatFromEmptyPane(page, prompt)

  const more = headerButton(page, 'More')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.tap()
  const sheet = page.getByRole('dialog', { name: prompt })
  await expect(sheet).toBeVisible()
  await expectBottomSheet(page, sheet)

  // Sheet title is the header title; its description is the subtitle text.
  await expect(sheet).toHaveAccessibleDescription('shdr-menu · main · Local')
  const moreHidden = headerButton(page, 'More')
  await expect(moreHidden).toHaveAttribute('aria-expanded', 'true')
  await expect(moreHidden).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(moreHidden).toHaveAttribute('aria-controls', 'mobile-header-more-sheet')
  await expect(page.locator('#mobile-header-more-sheet')).toBeVisible()

  const rows = sheet.getByRole('button').filter({ hasNotText: /^Close$/ })
  await expect(rows).toHaveText([
    'Git changes',
    'Files',
    'Command palette',
    'New terminal',
    'Project settings',
    'Close chat'
  ])
  await expectRowsAtLeast44(rows)

  // Escape and the sheet's own close button both land focus back on ⋯.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(more).toBeFocused()
  await expect(more).toHaveAttribute('aria-expanded', 'false')

  await more.tap()
  await sheet.getByRole('button', { name: 'Close', exact: true }).tap()
  await expect(sheet).toBeHidden()
  await expect(more).toBeFocused()

  // Registered with the overlay back stack: back closes it and stays in the chat.
  const chatUrl = page.url()
  await more.tap()
  await expect(sheet).toBeVisible()
  await page.goBack()
  await expect(sheet).toBeHidden()
  await expect(page).toHaveURL(chatUrl)

  // ✎ starts another chat through the launcher.
  await headerButton(page, 'New chat').tap()
  const launcher = page.getByRole('dialog', { name: 'Agent launcher' })
  await expect(launcher).toBeVisible()
  await launcher.getByRole('button', { name: 'Close agent launcher' }).tap()
})

test('header ⋯ items open their destination, close the sheet, and Close chat ends the chat', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-dest', { git: true })
  await openMobileWorkspace(page, 'shdr-dest')
  const prompt = 'foxtrot quick chat [DURATION:2]'
  await startChatFromEmptyPane(page, prompt)
  // Let the short turn finish, so Close chat removes the tab at once.
  await expect(page.getByText(/DONE after/)).toBeVisible()

  const more = headerButton(page, 'More')
  const sheet = page.getByRole('dialog', { name: prompt })
  const choose = async (row: string): Promise<void> => {
    await more.tap()
    await sheet.getByRole('button', { name: row, exact: true }).tap()
    await expect(sheet).toBeHidden()
  }

  await choose('Files')
  const files = page.getByRole('dialog', { name: 'shdr-dest' })
  await expect(files).toBeVisible()
  await expect(more).not.toBeFocused()
  await page.keyboard.press('Escape')
  await expect(files).toBeHidden()

  await choose('Command palette')
  await expect(page.getByRole('button', { name: 'Close command palette' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Close command palette' })).toBeHidden()

  await choose('Git changes')
  const git = page.getByRole('dialog', { name: 'Git changes' })
  await expect(git).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(git).toBeHidden()

  await choose('Project settings')
  const settings = page.getByRole('dialog', { name: 'Project Settings' })
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: 'Close Project Settings' }).tap()
  await expect(settings).toBeHidden()

  // Close chat is the separated destructive row; the chat leaves and the title resets.
  await more.tap()
  const closeChat = sheet.getByRole('button', { name: 'Close chat', exact: true })
  await expect(closeChat).toHaveClass(/text-destructive/)
  await closeChat.tap()
  await expect(sheet).toBeHidden()
  await expect(title(page)).toHaveText('Termul')
  await expect(more).not.toBeFocused()
})

// ---------------------------------------------------------------------------
// Terminal ⋯ sheet
// ---------------------------------------------------------------------------

test('terminal context swaps ✎ to New terminal and ⋯ to the terminal actions sheet', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-term')
  const wire = await watchTerminalWire(page)
  await openMobileWorkspace(page, 'shdr-term')

  // New terminal from the header ⋯ sheet (no tab open: the sheet still offers it).
  await headerButton(page, 'More').tap()
  await page
    .getByRole('dialog', { name: 'Termul' })
    .getByRole('button', { name: 'New terminal', exact: true })
    .tap()
  await expect(title(page)).toHaveText(/^Terminal \d+$/)
  const firstName = await title(page).innerText()

  // Terminal context: ✎ is New terminal, ⋯ is Terminal actions, the project name stays.
  await expect(headerButton(page, 'New chat')).toHaveCount(0)
  await expect(headerButton(page, 'More')).toHaveCount(0)
  await expect(subtitle(page)).toHaveText('shdr-term')

  await headerButton(page, 'New terminal').tap()
  await expect(title(page)).toHaveText(/^Terminal \d+$/)
  await expect(title(page)).not.toHaveText(firstName)
  const name = await title(page).innerText()

  const actions = headerButton(page, 'Terminal actions')
  await expect(actions).toHaveAttribute('aria-expanded', 'false')
  await actions.tap()
  const sheet = page.getByRole('dialog', { name })
  await expect(sheet).toBeVisible()
  await expectBottomSheet(page, sheet)
  const actionsHidden = headerButton(page, 'Terminal actions')
  await expect(actionsHidden).toHaveAttribute('aria-expanded', 'true')
  await expect(actionsHidden).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(actionsHidden).toHaveAttribute('aria-controls', 'mobile-terminal-actions-sheet')
  await expect(page.locator('#mobile-terminal-actions-sheet')).toBeVisible()

  // No command has exited yet: no exit-code line. Once the host reports one,
  // the sheet describes itself with it, `0` included.
  await expect(sheet.getByText(/Last exit code/)).toHaveCount(0)
  await expect.poll(() => wire.attachedCount()).toBe(2)
  wire.exitCode(127)
  const exitLine = sheet.getByText('Last exit code 127')
  await expect(exitLine).toBeVisible()
  await expect(exitLine).toHaveClass(/tabular-nums/)
  await expect(sheet).toHaveAccessibleDescription('Last exit code 127')
  wire.exitCode(0)
  await expect(sheet.getByText('Last exit code 0')).toBeVisible()
  await expect(sheet).toHaveAccessibleDescription('Last exit code 0')
  const rows = sheet.getByRole('button').filter({ hasNotText: /^Close$/ })
  await expect(rows).toHaveText([
    'Rename terminal',
    'Restart terminal',
    'Command history',
    'Close terminal'
  ])
  await expectRowsAtLeast44(rows)
  await expect(sheet.getByRole('button', { name: 'Close terminal' })).toHaveClass(
    /text-destructive/
  )

  // Escape and the sheet's own close button both land focus back on ⋯.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(actions).toBeFocused()
  await actions.tap()
  await sheet.getByRole('button', { name: 'Close', exact: true }).tap()
  await expect(sheet).toBeHidden()
  await expect(actions).toBeFocused()

  // Registered with the overlay back stack: hardware back closes it.
  await actions.tap()
  await expect(sheet).toBeVisible()
  await page.goBack()
  await expect(sheet).toBeHidden()
})

test('terminal rename trims on Enter, drops on Escape, ignores blank, and the other rows act', async ({
  page,
  request
}) => {
  await createProject(request, 'shdr-name')
  await openMobileWorkspace(page, 'shdr-name')
  await headerButton(page, 'More').tap()
  await page
    .getByRole('dialog', { name: 'Termul' })
    .getByRole('button', { name: 'New terminal', exact: true })
    .tap()
  await expect(title(page)).toHaveText(/^Terminal \d+$/)
  const name = await title(page).innerText()

  const actions = headerButton(page, 'Terminal actions')
  const sheetFor = (current: string): Locator => page.getByRole('dialog', { name: current })

  // Enter commits the trimmed name, closes the sheet and focuses ⋯.
  await actions.tap()
  let sheet = sheetFor(name)
  await sheet.getByRole('button', { name: 'Rename terminal' }).tap()
  const input = sheet.getByRole('textbox', { name: `Rename ${name}` })
  await expect(input).toBeFocused()
  // 44px row, and 16px text so a phone browser does not zoom on focus.
  expect((await box(input)).height).toBeGreaterThanOrEqual(44)
  expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  await input.fill('  api  ')
  await input.press('Enter')
  await expect(sheet).toBeHidden()
  await expect(title(page)).toHaveText('api')
  await expect(actions).toBeFocused()

  // Escape drops the edit: no rename, sheet closes, focus on ⋯.
  await actions.tap()
  sheet = sheetFor('api')
  await sheet.getByRole('button', { name: 'Rename terminal' }).tap()
  const draft = sheet.getByRole('textbox', { name: 'Rename api' })
  await draft.fill('discarded')
  await draft.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(title(page)).toHaveText('api')
  await expect(actions).toBeFocused()

  // A blank name changes nothing and leaves the sheet open on its rows.
  await actions.tap()
  await sheet.getByRole('button', { name: 'Rename terminal' }).tap()
  const blank = sheet.getByRole('textbox', { name: 'Rename api' })
  await blank.fill('   ')
  await blank.press('Enter')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Rename terminal' })).toBeVisible()
  await expect(title(page, { hidden: true })).toHaveText('api')

  // Blur commits and leaves the sheet open: tapping the sheet title ends the edit.
  // The sheet is titled by the terminal name, so it is "blurred" from then on.
  await sheet.getByRole('button', { name: 'Rename terminal' }).tap()
  await sheet.getByRole('textbox', { name: 'Rename api' }).fill('blurred')
  await sheet.getByRole('heading', { name: 'api' }).tap()
  await expect(title(page, { hidden: true })).toHaveText('blurred')
  sheet = sheetFor('blurred')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Rename terminal' })).toBeVisible()

  // Command history closes the sheet and opens the history modal.
  await sheet.getByRole('button', { name: 'Command history' }).tap()
  await expect(sheet).toBeHidden()
  const search = page.getByRole('textbox', { name: 'Search commands...' })
  await expect(search).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(search).toBeHidden()

  // Restart closes the sheet and respawns the shell: a fresh, default-named
  // terminal replaces the renamed one in the same pane.
  await actions.tap()
  await sheet.getByRole('button', { name: 'Restart terminal' }).tap()
  await expect(sheet).toBeHidden()
  await expect(title(page)).toHaveText(/^Terminal \d+$/)
  await expect(actions).toBeVisible()
  const restartedName = await title(page).innerText()
  sheet = sheetFor(restartedName)

  // Close terminal goes through the existing confirm: Cancel keeps it, Close removes it.
  await actions.tap()
  await sheet.getByRole('button', { name: 'Close terminal' }).tap()
  await expect(sheet).toBeHidden()
  const confirm = page.getByText(`Are you sure you want to close "${restartedName}"?`)
  await expect(confirm).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).tap()
  await expect(confirm).toBeHidden()
  await expect(title(page)).toHaveText(restartedName)

  await actions.tap()
  await sheet.getByRole('button', { name: 'Close terminal' }).tap()
  await expect(sheet).toBeHidden()
  await expect(confirm).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).tap()
  await expect(title(page)).toHaveText('Termul')
})

// ---------------------------------------------------------------------------
// Attention pill and the narrow fold
// ---------------------------------------------------------------------------

test('attention pill counts the other chats that need you, opens the drawer, and folds into ☰ at 360px', async ({
  page,
  request
}) => {
  // A prompt carrying `[PERMISSION]` makes the fake agent ask for a tool
  // approval, and the approval stays pending for as long as the page is
  // connected (the host denies it only after a 60s disconnect grace): that chat
  // "needs you" for the whole test.
  const project = 'shdr-attention-project-with-a-long-name'
  await createProject(request, project, { git: true })
  await openMobileWorkspace(page, project)
  const approval = page.getByRole('region', { name: 'Approval needed' })
  const pillIn = (name: string | RegExp): Locator =>
    header(page, { hidden: true }).getByRole('button', { name, includeHidden: true })
  const anyPill = pillIn(/other chats? needs? you$/)

  // Chat A needs you but is the one on screen, so it is not an "other" chat: no pill.
  const alpha = 'alpha attention chat [PERMISSION]'
  await startChatFromEmptyPane(page, alpha)
  await expect(approval).toBeVisible()
  await expect(anyPill).toHaveCount(0)
  await expect(headerButton(page, 'Open menu')).toBeVisible()

  // Chat B (long title) needs you too, and is now on screen: the count is 2 but
  // B is subtracted, so the pill reads 1 (singular).
  const bravo =
    'bravo second chat with a very long title that must truncate before it pushes any header control off the screen [PERMISSION]'
  await startChatFromLauncher(page, bravo)
  await expect(approval).toBeVisible()
  const pill = pillIn('1 other chat needs you')
  await expect(pill).toBeVisible()
  await expect(pill).toHaveText('1')

  // Nothing scrolls sideways with the longest header content: pill, long title and subtitle.
  const menu = headerButton(page, 'Open menu')
  const newChat = headerButton(page, 'New chat')
  const more = headerButton(page, 'More')
  await expectNoSidewaysScroll(page, [menu, subtitle(page), pill, newChat, more])
  await expect.poll(() => title(page).evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  const pillBox = await box(pill)
  expect(pillBox.x + pillBox.width).toBeLessThanOrEqual((await box(newChat)).x)
  expect((await box(newChat)).x + (await box(newChat)).width).toBeLessThanOrEqual(
    (await box(more)).x + 1
  )

  // Chat C asks for nothing: both A and B are "other" chats that need you.
  await startChatFromLauncher(page, 'charlie third chat')
  const plural = pillIn('2 other chats need you')
  await expect(plural).toBeVisible()
  await expect(plural).toHaveText('2')
  await expect(anyPill).toHaveCount(1)
  await expectNoSidewaysScroll(page, [menu, subtitle(page), plural, newChat, more])

  // The pill's 28px body is padded by 8px above and below to a 44px target:
  // 6px outside the body still hits the pill, and a tap on it opens the drawer.
  const pluralBox = await box(plural)
  const pillCenterX = pluralBox.x + pluralBox.width / 2
  for (const y of [pluralBox.y - 6, pluralBox.y + pluralBox.height + 6]) {
    expect(await buttonAt(page, pillCenterX, y)).toBe('2 other chats need you')
  }
  await plural.tap()
  const drawer = drawerOf(page)
  await expect(drawer).toBeVisible()
  for (const control of [plural, headerButton(page, 'Open menu')]) {
    await expect(control).toHaveAttribute('aria-expanded', 'true')
    await expect(control).toHaveAttribute('aria-controls', DRAWER_ID)
  }
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  // ☰ opens the same drawer.
  await menu.tap()
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  // At 360px the pill folds into a dot on ☰, whose name carries the count.
  await page.setViewportSize({ width: 360, height: 780 })
  const folded = headerButton(page, 'Open menu, 2 chats need you')
  await expect(folded).toBeVisible()
  await expect(anyPill).toHaveCount(0)
  await expect(folded.locator('span[aria-hidden="true"]')).toHaveCount(1)
  await expectNoSidewaysScroll(page, [folded, subtitle(page), newChat, more])
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(plural).toBeVisible()
  await expect(headerButton(page, 'Open menu')).toBeVisible()

  // Landing in chat A drops A from the count and keeps B: the pill reads 1 again.
  await menu.tap()
  await chatRow(drawer, alpha).tap()
  await expect(drawer).toBeHidden()
  await expect(title(page)).toHaveText(alpha)
  await expect(pillIn('1 other chat needs you')).toHaveText('1')
})
