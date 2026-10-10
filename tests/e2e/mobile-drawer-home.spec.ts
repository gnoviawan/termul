import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page, WebSocketRoute } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile drawer E2E (spec-mobile-drawer-home, restyled by
 * spec-mobile-tabbar-claude-style): a phone-sized browser drives the web
 * client's mobile shell and checks what jsdom cannot: the real drawer and tab
 * bar geometry (width, section order, 44px hit areas, no horizontal scroll),
 * the merged Recents list with live chat status fed by real agent turns (the
 * fake long-run agent), the unread flag banking across a closed drawer and a
 * project switch, the long-press row actions and the delete confirm, the
 * focus hand-offs, a degraded connection in the footer, and that the desktop
 * StatusBar is gone from the shell (and still there on desktop).
 *
 * Every test registers its own project (a fresh workspace layout and a
 * History list scoped to that project), so no state is shared with other
 * suites or between tests. Fake-agent turns are bounded with `[DURATION:n]`
 * (or kept running with a long one) so every status is deterministic.
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

/** The id of the shell header's `h1`: where a navigation hands focus (else the opener). */
const SHELL_TITLE_ID = 'mobile-shell-title'

/** The footer's healthy reading: the status and the host this client talks to (V-12). */
const CONNECTED_TEXT = `Connected · ${new URL(E2E_BASE_URL).host}`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface RegisteredProject {
  name: string
  id: string
  path: string
}

/**
 * Register a throwaway project under the suite's workspace root. The name is
 * unique per call: layouts and History persist per project id, so a reused id
 * (e.g. under --repeat-each) would restore an earlier test's chats. A `git`
 * project is a real repo with one commit on `main`; `detached` leaves its HEAD
 * on that commit with no branch.
 */
async function registerProject(
  options: { git?: boolean; detached?: boolean } = {}
): Promise<RegisteredProject> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-drawer-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  if (options.git || options.detached) {
    execSync('git init -q -b main', { cwd: path })
    execSync('git -c user.email=e2e@termul -c user.name=e2e commit -q --allow-empty -m init', {
      cwd: path
    })
  }
  if (options.detached) execSync('git checkout -q --detach', { cwd: path })
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
  return { name, id, path }
}

/** Make the web client boot straight into this project. */
async function setActiveProject(project: RegisteredProject): Promise<void> {
  await wsRequest(E2E_BASE_URL, 'store_write', {
    key: 'web-active-project',
    value: { _version: 1, data: project.id }
  })
}

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session, and that session
 * creation re-activates the pane. A chat or terminal opened BEFORE it lands
 * can be swapped out from under the test (a test-only race: a person needs
 * seconds to reach the drawer). An agent that fails to start also ends the
 * warm-up. Bounded so a boot with no warm-up cannot hang the test.
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
 * Tracks the fake agent's end-of-turn marker (`[DONE after …]`) arriving on
 * the control socket, per chat. A background chat's turn is invisible in the
 * UI, so this is the deterministic "that turn finished" signal. Register
 * before the page connects.
 */
function trackTurnEnds(page: Page): { count: () => number } {
  const ended = new Set<string>()
  page.on('websocket', (socket) => {
    if (socket.url().endsWith('/terminal/ws')) return
    socket.on('framereceived', (frame) => {
      const text = String(frame.payload)
      if (!text.includes('[DONE after')) return
      const sessionId = /"sessionId":"([^"]+)"/.exec(text)?.[1]
      if (sessionId) ended.add(sessionId)
    })
  })
  return { count: () => ended.size }
}

/** Persist the auth token through the first-visit fragment, then land on the app root. */
async function signIn(page: Page): Promise<void> {
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  // The first load of a fresh server serves the whole bundle cold: allow for it.
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN,
    { timeout: 60_000 }
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
}

/** Boot the mobile shell on the project and wait for the agent warm-up to settle. */
async function bootInto(
  page: Page,
  project: RegisteredProject,
  options: { warmup?: boolean } = {}
): Promise<void> {
  const warmedUp = options.warmup === false ? Promise.resolve() : watchAgentWarmup(page)
  await setActiveProject(project)
  await signIn(page)
  // The header names the active project until a chat or terminal takes over:
  // seeing it proves the shell booted into our fresh project.
  await expect(
    page.getByRole('button', { name: new RegExp(`^${project.name}.*switch project$`) })
  ).toBeVisible()
  await warmedUp
}

/** Register a fresh project, boot into it, return it. */
async function bootFreshProject(
  page: Page,
  options: { git?: boolean; detached?: boolean } = {}
): Promise<RegisteredProject> {
  const project = await registerProject(options)
  await bootInto(page, project)
  return project
}

/** Start a NEW chat from the header button and wait for the shell to show it. */
async function launchChat(page: Page, prompt: string): Promise<string> {
  await page.getByRole('button', { name: 'New chat', exact: true }).tap()
  const composer = page.getByRole('textbox', { name: 'Agent prompt' })
  await expect(composer).toBeVisible()
  await composer.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  // The chat's title is its first prompt (the server shortens a long one with
  // an ellipsis), and the header shows the active chat's title.
  const heading = page.getByRole('heading', {
    level: 1,
    name: new RegExp(`^${escapeRegExp(prompt.slice(0, 30))}`)
  })
  await expect(heading).toBeVisible()
  const title = (await heading.innerText()).trim()
  expect(prompt.startsWith(title.replace(/…$/, ''))).toBe(true)
  return title
}

/** Tap the shell's ☰ and wait for the drawer to be on screen and settled. */
async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  const drawer = page.getByRole('dialog', { name: 'Termul', exact: true })
  await expect(drawer).toBeVisible()
  // The sheet slides in from the left: measure only once it has landed.
  await expect
    .poll(async () => (await drawer.boundingBox())?.x ?? Number.NEGATIVE_INFINITY)
    .toBeGreaterThanOrEqual(-0.5)
  return drawer
}

/** ☰ even while the modal drawer hides it from the accessibility tree. */
function menuButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Open menu', includeHidden: true })
}

/** A Recents chat row: named `{title}` or `{title}, {status…}` (open chats carry status). */
function chatRow(drawer: Locator, title: string): Locator {
  return drawer.getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}(,|$)`) })
}

/** The Recents recency bucket every chat of these tests lands in. */
function todayGroup(drawer: Locator): Locator {
  return drawer.getByRole('group', { name: 'Today', exact: true })
}

/** The drawer's section nav row (Chats, Terminals, Editors). */
function sectionNav(drawer: Locator, section: 'Chats' | 'Terminals' | 'Editors'): Locator {
  return drawer
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: new RegExp(`^${section}`) })
}

/** Long-press a Recents row (its `contextmenu`) and return the row actions sheet. */
async function openRowActions(page: Page, row: Locator, title: string): Promise<Locator> {
  await row.dispatchEvent('contextmenu')
  const sheet = page.getByRole('dialog', { name: title, exact: true })
  await expect(sheet).toBeVisible()
  return sheet
}

/** Nothing inside `root` scrolls sideways. */
async function expectNoHorizontalScroll(root: Locator, label: string): Promise<void> {
  const offenders = await root.evaluate((el) => {
    const bounds = el.getBoundingClientRect()
    const describe = (node: HTMLElement): string =>
      `${node.tagName.toLowerCase()}${node.getAttribute('aria-label') ? `[${node.getAttribute('aria-label')}]` : ''} "${(node.textContent ?? '').trim().slice(0, 30)}"`
    const found: string[] = []
    for (const node of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) {
      const style = getComputedStyle(node)
      // A container that scrolls sideways.
      if (
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        node.scrollWidth > node.clientWidth + 1
      ) {
        found.push(`scrolls: ${describe(node)}`)
        continue
      }
      // Anything painted past the drawer's left or right edge (visually hidden
      // 1px nodes aside).
      const rect = node.getBoundingClientRect()
      if (rect.width <= 1 || rect.height <= 1) continue
      if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) {
        found.push(`spills: ${describe(node)}`)
      }
    }
    return found
  })
  expect(offenders, `${label}: elements that scroll or spill sideways`).toEqual([])
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

/** A control that holds the 44px touch floor (CSS px). */
async function expectTouchTarget(locator: Locator, label: string): Promise<void> {
  const box = await boxOf(locator)
  expect(box.height, `${label} height`).toBeGreaterThanOrEqual(44)
  expect(box.width, `${label} width`).toBeGreaterThanOrEqual(44)
}

/**
 * A compact footer pill (36px visual) whose ::after hit-slop holds the 44px
 * floor: a point 3.5px outside its top and bottom edges still hits the pill.
 */
async function expectPillHitArea(locator: Locator, label: string): Promise<void> {
  const box = await boxOf(locator)
  expect(box.height, `${label} visual height`).toBeGreaterThanOrEqual(36)
  expect(box.height + 8, `${label} hit height`).toBeGreaterThanOrEqual(44)
  const x = box.x + box.width / 2
  for (const y of [box.y - 3.5, box.y + box.height + 3.5]) {
    const hitsPill = await locator.evaluate(
      (el, point) => {
        const hit = document.elementFromPoint(point.x, point.y)
        return hit !== null && (hit === el || el.contains(hit))
      },
      { x, y }
    )
    expect(hitsPill, `${label} hit-slop at y=${y.toFixed(1)}`).toBe(true)
  }
}

/**
 * After a navigation close focus goes to the destination title when the shell
 * has one (`#mobile-shell-title`, the header `h1`), else to the opener.
 */
async function expectNavigationFocus(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ titleId }) => {
          const title = document.getElementById(titleId)
          const target = title ?? document.querySelector('[aria-label="Open menu"]')
          return target !== null && document.activeElement === target
        },
        { titleId: SHELL_TITLE_ID }
      )
    )
    .toBe(true)
}

test('the drawer is a full-screen Claude-style navigator: project row beside the close, one line of section tabs, search, Recents and a footer with the New chat pill; the main screen has no bottom bar and no status bar', async ({
  page
}) => {
  const project = await bootFreshProject(page)

  // The desktop StatusBar is gone from the mobile shell, and there is no
  // bottom bar: the main screen is the header and the content.
  await expect(page.locator('[data-status-bar]')).toHaveCount(0)
  await expect(page.getByRole('navigation')).toHaveCount(0)

  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(menuButton(page)).not.toHaveAttribute('aria-controls', /.+/)
  const drawer = await openDrawer(page)
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(menuButton(page)).toHaveAttribute('aria-controls', 'mobile-shell-drawer')
  await expect(drawer).toHaveAttribute('id', 'mobile-shell-drawer')

  // Full screen: the whole 390px width and the whole height.
  const drawerBox = await boxOf(drawer)
  expect(drawerBox.x).toBeLessThanOrEqual(0.5)
  expect(drawerBox.width).toBeGreaterThanOrEqual(389.5)
  expect(drawerBox.height).toBeGreaterThanOrEqual(843.5)
  await expect(drawer.getByRole('button', { name: 'Close', exact: true })).toBeVisible()

  // The section tabs: one line of three equal 44px tabs, Chats preselected (no tab is open).
  const tabTops: number[] = []
  const tabWidths: number[] = []
  for (const section of ['Chats', 'Terminals', 'Editors'] as const) {
    await expectTouchTarget(sectionNav(drawer, section), `${section} tab`)
    const box = await boxOf(sectionNav(drawer, section))
    tabTops.push(box.y)
    tabWidths.push(box.width)
  }
  expect(new Set(tabTops).size, 'the three tabs share one line').toBe(1)
  expect(Math.max(...tabWidths) - Math.min(...tabWidths)).toBeLessThanOrEqual(1)
  await expect(sectionNav(drawer, 'Chats')).toHaveAttribute('aria-current', 'true')

  // The "Termul" title only names the dialog; the project row is the top row,
  // beside the close ×.
  const title = drawer.getByRole('heading', { level: 2, name: 'Termul', exact: true })
  await expect(drawer).toHaveAccessibleName('Termul')
  const projectRow = drawer.getByRole('button', { name: project.name })
  const close = drawer.getByRole('button', { name: 'Close', exact: true })
  const projectBox = await boxOf(projectRow)
  const closeBox = await boxOf(close)
  expect(projectBox.x + projectBox.width).toBeLessThanOrEqual(closeBox.x + 1)
  expect(
    Math.abs(projectBox.y + projectBox.height / 2 - (closeBox.y + closeBox.height / 2))
  ).toBeLessThan(12)

  // Top to bottom: project row, section tabs, search, Recents, then the footer.
  const search = drawer.getByRole('textbox', { name: 'Search chats' })
  const recentsHeading = drawer.getByRole('heading', { level: 2, name: 'Recents', exact: true })
  const settings = drawer.getByRole('button', { name: 'Settings', exact: true })
  const snapshots = drawer.getByRole('button', { name: 'Snapshots', exact: true })
  const gitHistory = drawer.getByRole('button', { name: 'Git history', exact: true })
  const newChat = drawer.getByRole('button', { name: 'New chat', exact: true })
  const connection = drawer.getByRole('status')
  const ordered = [projectRow, sectionNav(drawer, 'Chats'), search, recentsHeading, settings]
  const tops: number[] = []
  for (const locator of ordered) tops.push((await boxOf(locator)).y)
  expect(tops).toEqual([...tops].sort((a, b) => a - b))
  expect(new Set(tops).size).toBe(tops.length)
  // The footer controls and the New chat pill share a row, the pill at its end.
  expect((await boxOf(snapshots)).y).toBe((await boxOf(settings)).y)
  expect((await boxOf(gitHistory)).y).toBe((await boxOf(settings)).y)
  expect((await boxOf(newChat)).y).toBe((await boxOf(settings)).y)
  expect((await boxOf(newChat)).x).toBeGreaterThan((await boxOf(gitHistory)).x)
  expect(
    await newChat.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderRadius))
  ).toBeGreaterThan(20)
  expect((await boxOf(connection)).y).toBeGreaterThan((await boxOf(settings)).y)
  const footerBottom = (await boxOf(connection)).y + (await boxOf(connection)).height
  expect(footerBottom).toBeGreaterThan(844 - 80)

  // One chat list: no Open, Terminals, Tabs or History headings, no New project.
  for (const name of ['Open', 'Terminals', 'Tabs', 'History']) {
    await expect(drawer.getByRole('heading', { name, exact: true })).toHaveCount(0)
  }
  await expect(drawer.getByRole('button', { name: 'New project' })).toHaveCount(0)
  await expect(drawer.getByText('No chats yet. Start one with the New chat button.')).toBeVisible()

  // Visible, named controls at the touch floor; the connection summary is text.
  await expectTouchTarget(projectRow, 'project row')
  await expectTouchTarget(search, 'search')
  await expectPillHitArea(newChat, 'New chat')
  await expectTouchTarget(settings, 'Settings')
  await expectTouchTarget(snapshots, 'Snapshots')
  await expectTouchTarget(gitHistory, 'Git history')
  await expect(connection).toHaveText(CONNECTED_TEXT)

  // A non-git project shows its name only: no "{branch} · {Local|Worktree}" line.
  await expect(projectRow).toContainText(project.name)
  await expect(projectRow).not.toContainText('·')

  // The search never takes focus on open (the keyboard must not rise): with
  // no active row the (visually hidden) title holds it.
  await expect(search).not.toBeFocused()
  await expect(title).toBeFocused()
  expect(await search.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
})

test('the project row names the branch for a git project and hands off to the project sheet', async ({
  page
}) => {
  const project = await bootFreshProject(page, { git: true })
  const drawer = await openDrawer(page)

  // The git-branch probe resolves after project load: auto-wait for it.
  const projectRow = drawer.getByRole('button', { name: new RegExp(escapeRegExp(project.name)) })
  await expect(projectRow).toContainText('main · Local')
  await expect(projectRow).toHaveAttribute('aria-haspopup', 'dialog')

  // Tapping it closes the drawer and opens the project sheet; the sheet holds
  // focus (the drawer must not pull it back to ☰).
  await projectRow.tap()
  const sheet = page.getByRole('dialog', { name: 'Projects' })
  await expect(sheet).toBeVisible()
  await expect(drawer).toBeHidden()
  // The active project is listed first-class: its select button is "current".
  await expect(
    sheet.getByRole('button', { name: new RegExp(`^${escapeRegExp(project.name)}`) })
  ).toHaveAttribute('aria-current', 'true')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null))
    .toBe(true)
  await expect(menuButton(page)).not.toBeFocused()
})

test('a git project on a detached HEAD reads "Detached HEAD · Local"', async ({ page }) => {
  const project = await bootFreshProject(page, { detached: true })
  const drawer = await openDrawer(page)

  const projectRow = drawer.getByRole('button', { name: new RegExp(escapeRegExp(project.name)) })
  await expect(projectRow).toContainText('Detached HEAD · Local')
  await expect(projectRow).not.toContainText('main')
})

test('Recents rows: an open chat is listed once with a status glyph, holds the 44px floor, and long titles never scroll sideways', async ({
  page
}) => {
  const turns = trackTurnEnds(page)
  await bootFreshProject(page)
  const prompt =
    'status survey with a long title that keeps on going well past the drawer edge [DURATION:15]'
  // The chat is titled by its (server-shortened) first prompt: still far wider
  // than a 16px row at 390px.
  const title = await launchChat(page, prompt)
  expect(title.length).toBeGreaterThan(40)

  const drawer = await openDrawer(page)
  const row = chatRow(drawer, title)
  // Listed once, though it is both an open tab and in the session index.
  await expect(row).toHaveCount(1)
  // A live turn: the spinner glyph, with its word only for assistive tech.
  await expect(row).toHaveAccessibleName(`${title}, Working`)
  await expect(row.locator('[title="Working"]')).toBeVisible()
  await expect(row.locator('span.text-2xs')).toHaveCount(0)
  await expect(row).toHaveAttribute('aria-current', 'page')
  // Focus lands on the active row, never on the search.
  await expect(row).toBeFocused()
  await expect(drawer.getByRole('textbox', { name: 'Search chats' })).not.toBeFocused()

  // The active row is a full-width pill; 44px; no trailing icons.
  await expectTouchTarget(row, 'chat row')
  expect(
    await row.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderRadius))
  ).toBeGreaterThan(20)
  await expect(drawer.getByRole('button', { name: `Close ${title}`, exact: true })).toHaveCount(0)
  // The long title truncates: the glyph stays inside the drawer, nothing scrolls sideways.
  const drawerBox = await boxOf(drawer)
  const glyph = await boxOf(row.locator('[title="Working"]'))
  expect(glyph.x + glyph.width).toBeLessThanOrEqual(drawerBox.x + drawerBox.width)
  await expectNoHorizontalScroll(drawer, 'drawer')

  // The turn finishes while this chat is the active one: no "New activity".
  await expect.poll(() => turns.count(), { timeout: 45_000 }).toBeGreaterThan(0)
  await expect(row).toHaveAccessibleName(title)
  await expect(row.locator('[title="Working"]')).toHaveCount(0)
  await expect(row.locator('[title="New activity"]')).toHaveCount(0)
})

test('a pending approval shows the Needs you glyph beside Working, and only Needs you takes the warning colour', async ({
  page
}) => {
  await bootFreshProject(page)
  const prompt = 'approval survey [PERMISSION] [DURATION:90]'
  await launchChat(page, prompt)

  const drawer = await openDrawer(page)
  const row = chatRow(drawer, prompt)
  await expect(row).toHaveAccessibleName(`${prompt}, Needs you, Working`)
  const needsYou = row.locator('[title="Needs you"]')
  const working = row.locator('[title="Working"]')
  await expect(needsYou).toBeVisible()
  await expect(working).toBeVisible()
  // "Needs you" leads, and it alone is in the warning colour.
  expect((await boxOf(needsYou)).x).toBeLessThan((await boxOf(working)).x)
  const colourOf = (glyph: Locator): Promise<string> =>
    glyph.evaluate((el) => getComputedStyle(el).color)
  expect(await colourOf(needsYou)).not.toBe(await colourOf(working))
  // A chat that needs you is never a failure.
  await expect(row).not.toContainText('Failed')

  // The Chats nav row badges the other chats that need you, never the one on screen.
  await expect(sectionNav(drawer, 'Chats')).toHaveAccessibleName('Chats')
})

test('a background turn banks New activity behind a closed drawer and opening the chat clears it', async ({
  page
}) => {
  const turns = trackTurnEnds(page)
  await bootFreshProject(page)
  const background = 'alpha review [DURATION:12]'
  const foreground = 'bravo review [DURATION:120]'
  await launchChat(page, background)
  await launchChat(page, foreground)

  // The drawer stays closed while the background turn ends (its rows are
  // unmounted): only the shell-level tracker can bank the flag.
  await expect.poll(() => turns.count(), { timeout: 45_000 }).toBeGreaterThan(0)

  let drawer = await openDrawer(page)
  const backgroundRow = chatRow(drawer, background)
  const foregroundRow = chatRow(drawer, foreground)
  await expect(backgroundRow).toHaveAccessibleName(`${background}, New activity`)
  await expect(backgroundRow).toContainText('New activity')
  // The active chat is still working; it has no unread cue of its own.
  await expect(foregroundRow).toHaveAccessibleName(`${foreground}, Working`)
  await expect(foregroundRow).toHaveAttribute('aria-current', 'page')
  await expect(backgroundRow).not.toHaveAttribute('aria-current', 'page')

  // Viewing the chat clears the flag, and it stays cleared while it is active.
  await backgroundRow.tap()
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: background, exact: true })).toBeVisible()
  drawer = await openDrawer(page)
  await expect(chatRow(drawer, background)).toHaveAccessibleName(background)
  await expect(chatRow(drawer, background)).toHaveAttribute('aria-current', 'page')
  await expect(chatRow(drawer, background)).not.toContainText('New activity')
  await expect(chatRow(drawer, foreground)).toHaveAccessibleName(`${foreground}, Working`)
})

test('New activity survives a project switch and back', async ({ page }) => {
  const turns = trackTurnEnds(page)
  // Both projects exist before the page loads, so the project sheet lists them.
  const first = await registerProject()
  const second = await registerProject()
  await bootInto(page, first)
  const background = 'charlie review [DURATION:12]'
  const foreground = 'delta review [DURATION:120]'
  await launchChat(page, background)
  await launchChat(page, foreground)
  await expect.poll(() => turns.count(), { timeout: 45_000 }).toBeGreaterThan(0)
  // A project switch is queued while the active chat runs a turn: stop it.
  await page.getByRole('button', { name: 'Cancel turn' }).tap()
  await expect(page.getByRole('button', { name: 'Cancel turn' })).toBeHidden()

  let drawer = await openDrawer(page)
  await expect(chatRow(drawer, background)).toHaveAccessibleName(`${background}, New activity`)

  const switchTo = async (from: RegisteredProject, to: RegisteredProject): Promise<Locator> => {
    await drawer.getByRole('button', { name: new RegExp(escapeRegExp(from.name)) }).tap()
    await page
      .getByRole('dialog', { name: 'Projects' })
      .getByRole('button', { name: new RegExp(`^${escapeRegExp(to.name)}`) })
      .tap()
    const reopened = await openDrawer(page)
    await expect(
      reopened.getByRole('button', { name: new RegExp(escapeRegExp(to.name)) })
    ).toBeVisible()
    return reopened
  }

  // In the other project the first project's chats are not listed...
  drawer = await switchTo(first, second)
  await expect(chatRow(drawer, background)).toHaveCount(0)
  // ...and back, the unread flag is still banked (per session, not per visit).
  drawer = await switchTo(second, first)
  await expect(chatRow(drawer, background)).toHaveAccessibleName(`${background}, New activity`)
})

test('closing a chat mid-turn from its long-press sheet reads Closing (never Working) until the turn ends, then the row stays as history', async ({
  page
}) => {
  const turns = trackTurnEnds(page)
  await bootFreshProject(page)
  const prompt = 'echo review [DURATION:15]'
  await launchChat(page, prompt)

  const drawer = await openDrawer(page)
  await expect(chatRow(drawer, prompt)).toHaveAccessibleName(`${prompt}, Working`)
  // An open chat that is in history offers Close and Delete.
  const sheet = await openRowActions(page, chatRow(drawer, prompt), prompt)
  await expect(sheet.getByRole('button', { name: 'Delete chat' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Close chat', exact: true }).tap()
  await expect(sheet).toBeHidden()

  // The running turn stays on screen: "Closing" wins the slot over "Working".
  const row = chatRow(drawer, prompt)
  await expect(row).toHaveAccessibleName(`${prompt}, Closing`)
  await expect(row.locator('[title="Working"]')).toHaveCount(0)

  // When the turn ends the chat closes (no unread is banked for a closing
  // chat); the persisted chat stays in Recents, once, without status.
  await expect.poll(() => turns.count(), { timeout: 45_000 }).toBeGreaterThan(0)
  await expect(row).toHaveAccessibleName(prompt)
  await expect(row).toHaveCount(1)
  await expect(row).not.toHaveAttribute('aria-current', 'page')
})

test('search filters the merged Recents list, never takes focus, and starts fresh on each visit', async ({
  page
}) => {
  await bootFreshProject(page)
  const first = 'foxtrot notes [DURATION:2]'
  const second = 'golf notes [DURATION:2]'
  await launchChat(page, first)
  await launchChat(page, second)

  let drawer = await openDrawer(page)
  const search = drawer.getByRole('textbox', { name: 'Search chats' })
  await expect(search).toHaveAttribute('placeholder', 'Search chats…')
  await expect(chatRow(drawer, second)).toBeFocused()
  await expect(search).not.toBeFocused()
  await expect(drawer.getByRole('heading', { level: 3, name: 'Today' })).toBeVisible()
  await expect(chatRow(drawer, first)).toBeVisible()
  await expect(chatRow(drawer, second)).toBeVisible()

  await search.tap()
  await search.fill('foxtrot')
  await expect(chatRow(drawer, first)).toBeVisible()
  await expect(chatRow(drawer, second)).toHaveCount(0)

  await search.fill('zzz-no-such-chat')
  await expect(drawer.getByText('No chats match this search.')).toBeVisible()
  await expect(chatRow(drawer, first)).toHaveCount(0)

  // Dismiss and reopen: the query resets and every row is back.
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  drawer = await openDrawer(page)
  await expect(drawer.getByRole('textbox', { name: 'Search chats' })).toHaveValue('')
  await expect(chatRow(drawer, first)).toBeVisible()
  await expect(chatRow(drawer, second)).toBeVisible()
})

test('deleting a history chat from its long-press sheet asks first: Cancel and Esc keep it and return focus, Delete removes it and moves focus on', async ({
  page
}) => {
  const turns = trackTurnEnds(page)
  await bootFreshProject(page)
  const older = 'hotel notes [DURATION:2]'
  const newer = 'india notes [DURATION:2]'
  await launchChat(page, older)
  await launchChat(page, newer)
  // A turn's end bumps its chat's last activity and re-sorts Recents, and the
  // "next" row after a delete is decided by that order: let both turns end first.
  await expect.poll(() => turns.count(), { timeout: 45_000 }).toBeGreaterThanOrEqual(2)

  const drawer = await openDrawer(page)
  // Close both so they are history rows: Delete then stands alone.
  for (const title of [older, newer]) {
    const sheet = await openRowActions(page, chatRow(drawer, title), title)
    await sheet.getByRole('button', { name: 'Close chat', exact: true }).tap()
    await expect(sheet).toBeHidden()
    await expect(chatRow(drawer, title)).not.toHaveAttribute('aria-current', 'page')
  }
  const confirm = page.getByRole('alertdialog', { name: 'Delete chat' })
  const rows = todayGroup(drawer).locator('[data-recents-open]')
  await expect(rows).toHaveCount(2)
  await expectTouchTarget(chatRow(drawer, newer), 'Recents row')

  // The recency order decides which row is "next": read it, do not assume it.
  const [topTitle, nextTitle] = await rows.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-label') ?? '')
  )
  expect([topTitle, nextTitle].sort()).toEqual([older, newer].sort())

  const requestDelete = async (title: string): Promise<void> => {
    const sheet = await openRowActions(page, chatRow(drawer, title), title)
    await expect(sheet.getByRole('button', { name: 'Close chat' })).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Delete chat', exact: true }).tap()
    await expect(confirm).toBeVisible()
  }

  // Delete chat opens a confirm; nothing is deleted yet.
  await requestDelete(topTitle)
  await expect(confirm).toContainText(`Delete “${topTitle}”? This action cannot be undone.`)
  await expect(drawer).toBeVisible()

  // Cancel: nothing deleted, focus returns to that row.
  await confirm.getByRole('button', { name: 'Cancel' }).tap()
  await expect(confirm).toBeHidden()
  await expect(rows).toHaveCount(2)
  await expect(chatRow(drawer, topTitle)).toBeFocused()

  // Esc behaves the same.
  await requestDelete(topTitle)
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(rows).toHaveCount(2)
  await expect(chatRow(drawer, topTitle)).toBeFocused()
  await expect(drawer).toBeVisible()

  // Delete: the row goes, the drawer stays, focus moves to the next row.
  await requestDelete(topTitle)
  await confirm.getByRole('button', { name: 'Delete', exact: true }).tap()
  await expect(confirm).toBeHidden()
  await expect(chatRow(drawer, topTitle)).toHaveCount(0)
  await expect(rows).toHaveCount(1)
  await expect(chatRow(drawer, nextTitle)).toBeFocused()

  // Deleting the last row leaves nothing to focus: the Recents heading takes it.
  await requestDelete(nextTitle)
  await confirm.getByRole('button', { name: 'Delete', exact: true }).tap()
  await expect(confirm).toBeHidden()
  await expect(drawer.getByText('No chats yet. Start one with the New chat button.')).toBeVisible()
  await expect(
    drawer.getByRole('heading', { level: 2, name: 'Recents', exact: true })
  ).toBeFocused()
})

test('drawer sections: the nav switches lists in place, Terminals lists terminals with rename and close, Editors offers Browse files, Git History lives in the menu, every action holds the 44px floor', async ({
  page
}) => {
  await bootFreshProject(page, { git: true })

  // Switching to an empty Terminals section keeps the drawer open: an empty
  // line, no search, and the section's New terminal pill.
  let drawer = await openDrawer(page)
  await sectionNav(drawer, 'Terminals').tap()
  await expect(drawer).toBeVisible()
  await expect(sectionNav(drawer, 'Terminals')).toHaveAttribute('aria-current', 'true')
  await expect(drawer.getByText('No open terminals')).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: 'Search chats' })).toHaveCount(0)
  // New terminal is a navigation: the drawer closes and the shell shows it.
  await drawer.getByRole('button', { name: 'New terminal', exact: true }).tap()
  await expect(drawer).toBeHidden()

  // Reopened with a terminal active, the drawer preselects Terminals.
  drawer = await openDrawer(page)
  await expect(sectionNav(drawer, 'Terminals')).toHaveAttribute('aria-current', 'true')
  const terminals = drawer.getByRole('group', { name: 'Terminals', exact: true })
  const rename = terminals.getByRole('button', { name: /^Rename / })
  await expect(rename).toHaveCount(1)
  const name = ((await rename.getAttribute('aria-label')) ?? '').replace(/^Rename /, '')
  expect(name.length).toBeGreaterThan(0)
  const terminalRow = terminals.getByRole('button', { name, exact: true })
  const closeTerminal = terminals.getByRole('button', { name: `Close ${name}`, exact: true })
  await expect(terminalRow).toHaveAttribute('aria-current', 'page')
  await expect(terminalRow).toBeFocused()
  await expectTouchTarget(terminalRow, 'terminal row')
  await expectTouchTarget(rename, 'terminal rename')
  await expectTouchTarget(closeTerminal, 'terminal close')
  await expectNoHorizontalScroll(drawer, 'Terminals drawer')

  // Rename in place: a labelled 16px field at the touch floor, committed with Enter.
  await rename.tap()
  const renameInput = terminals.getByRole('textbox', { name: `Rename ${name}`, exact: true })
  await expect(renameInput).toBeFocused()
  expect((await boxOf(renameInput)).height).toBeGreaterThanOrEqual(44)
  expect(await renameInput.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  await renameInput.fill('build shell')
  await page.keyboard.press('Enter')
  await expect(terminals.getByRole('button', { name: 'build shell', exact: true })).toBeVisible()

  // Git History is a menu entry, not a section: with it on screen the drawer
  // opens on Chats.
  await drawer.getByRole('button', { name: 'Git history', exact: true }).tap()
  await expect(drawer).toBeHidden()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Git History', exact: true })
  ).toBeVisible()
  drawer = await openDrawer(page)
  await expect(sectionNav(drawer, 'Chats')).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  // Header ⋯ closes it.
  await page.getByRole('button', { name: 'More', exact: true }).tap()
  await page.locator('#mobile-header-more-sheet').getByRole('button', { name: 'Close tab' }).tap()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Git History', exact: true })
  ).toHaveCount(0)

  // The terminal row switches back to it; it was never recreated.
  drawer = await openDrawer(page)
  await sectionNav(drawer, 'Terminals').tap()
  await drawer.getByRole('button', { name: 'build shell', exact: true }).tap()
  await expect(drawer).toBeHidden()
  await expect(
    page.getByRole('heading', { level: 1, name: 'build shell', exact: true })
  ).toBeVisible()

  // An empty Editors section offers Browse files.
  drawer = await openDrawer(page)
  await sectionNav(drawer, 'Editors').tap()
  await expect(drawer.getByText('No open editors')).toBeVisible()
  const browse = drawer.getByRole('button', { name: 'Browse files', exact: true })
  await expectPillHitArea(browse, 'Browse files')
  await browse.tap()
  await expect(page.getByRole('button', { name: 'Back to parent folder' })).toBeVisible()
})

test('focus returns to ☰ after Esc and the built-in close, and a row navigation leaves the drawer on the opener', async ({
  page
}) => {
  await bootFreshProject(page)
  const first = 'kilo focus [DURATION:2]'
  const second = 'lima focus [DURATION:2]'
  await launchChat(page, first)
  await launchChat(page, second)

  // Esc.
  let drawer = await openDrawer(page)
  await expect(chatRow(drawer, second)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(menuButton(page)).toBeFocused()

  // The built-in close.
  drawer = await openDrawer(page)
  await drawer.getByRole('button', { name: 'Close', exact: true }).tap()
  await expect(drawer).toBeHidden()
  await expect(menuButton(page)).toBeFocused()

  // Row navigation, from one Recents row and then another: the drawer
  // closes on the chat it opened and focus lands on the opener (or the shell
  // title once the header goal adds it).
  drawer = await openDrawer(page)
  await chatRow(drawer, first).tap()
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: first, exact: true })).toBeVisible()
  await expectNavigationFocus(page)

  drawer = await openDrawer(page)
  await expect(chatRow(drawer, first)).toBeFocused()
  await chatRow(drawer, second).tap()
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: second, exact: true })).toBeVisible()
  await expectNavigationFocus(page)
})

test('Settings hands the drawer off: it closes and the settings dialog keeps focus', async ({
  page
}) => {
  await bootFreshProject(page)

  const drawer = await openDrawer(page)
  await drawer.getByRole('button', { name: 'Settings', exact: true }).tap()
  await expect(drawer).toBeHidden()
  const settings = page.getByRole('dialog', { name: 'Application Preferences' })
  await expect(settings).toBeVisible()
  // The drawer must not pull focus back to ☰ behind the dialog that opened.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest('[role="dialog"][aria-label]')?.ariaLabel ?? null
      )
    )
    .toBe('Application Preferences')
  await expect(menuButton(page)).not.toBeFocused()
})

test('New chat opens the launcher and Snapshots keeps the shell and its menu', async ({ page }) => {
  await bootFreshProject(page)
  const prompt = 'mike hand-off [DURATION:2]'
  await launchChat(page, prompt)

  // New chat: from inside a chat (whose composer is not the launcher's) the
  // drawer closes on the launcher's "Agent prompt" composer. No other dialog
  // took focus, so it returns to the opener.
  let drawer = await openDrawer(page)
  await expect(page.getByRole('textbox', { name: 'Agent prompt' })).toHaveCount(0)
  await drawer.getByRole('button', { name: 'New chat', exact: true }).tap()
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Agent prompt' })).toBeVisible()
  await expect(menuButton(page)).toBeFocused()

  // Snapshots: a route change inside the same shell, so ☰ and the drawer stay.
  drawer = await openDrawer(page)
  await drawer.getByRole('button', { name: 'Snapshots', exact: true }).tap()
  await expect(drawer).toBeHidden()
  await expect.poll(() => page.url()).toContain('/snapshots')
  await expectNavigationFocus(page)
  drawer = await openDrawer(page)
  await expect(drawer.getByRole('status')).toHaveText(CONNECTED_TEXT)
})

test('a degraded control channel reads as text with a warning lamp in the footer', async ({
  page
}) => {
  // Proxy the control sockets so the test can drop them. While the channel is
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
  const project = await registerProject()
  await bootInto(page, project, { warmup: false })

  const drawer = await openDrawer(page)
  const status = drawer.getByRole('status')
  const lamp = status.locator('svg')
  await expect(status).toHaveText(CONNECTED_TEXT)
  const connectedColour = await lamp.evaluate((el) => getComputedStyle(el).color)

  channelDown = true
  for (const socket of liveSockets) await socket.close()
  await expect(status).toHaveText(/^Control channel: (reconnecting|disconnected)$/)
  // The lamp is warning or destructive, never the healthy colour.
  await expect(lamp).toHaveClass(/text-(warning|destructive)/)
  expect(await lamp.evaluate((el) => getComputedStyle(el).color)).not.toBe(connectedColour)
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

  test('the desktop-width web client still renders the StatusBar and has no mobile menu', async ({
    page
  }) => {
    const project = await registerProject()
    await setActiveProject(project)
    await signIn(page)

    const statusBar = page.locator('[data-status-bar]')
    await expect(statusBar).toBeVisible()
    await expect(statusBar.getByRole('status')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0)
  })
})
