import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page, WebSocketRoute } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile drawer-as-home E2E (spec-mobile-drawer-home): a phone-sized browser
 * drives the web client's mobile shell and checks what jsdom cannot: the real
 * drawer geometry (width, section order, 44px hit areas), live chat status
 * fed by real agent turns (the fake long-run agent), the unread flag banking
 * across a closed drawer and a project switch, the History delete confirm,
 * the focus hand-offs, a degraded connection in the footer, and that the
 * desktop StatusBar is gone from the shell (and still there on desktop).
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
    page.getByRole('heading', { level: 1, name: project.name, exact: true })
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
async function launchChat(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'New chat', exact: true }).tap()
  const composer = page.getByRole('textbox', { name: 'Agent prompt' })
  await expect(composer).toBeVisible()
  await composer.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  // The chat's title is its first prompt, and the header shows the active
  // chat's title.
  await expect(page.getByRole('heading', { level: 1, name: prompt, exact: true })).toBeVisible()
}

/** Tap the shell's ☰ and wait for the drawer to be on screen and settled. */
async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  const drawer = page.getByRole('dialog', { name: 'Menu' })
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

/** An Open-section chat row: named `{title}` or `{title}, {status…}`. */
function chatRow(drawer: Locator, title: string): Locator {
  return drawer
    .getByRole('group', { name: 'Open', exact: true })
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}(,|$)`) })
}

/** The History section's group for the recency bucket (always "Today" here). */
function historyGroup(drawer: Locator): Locator {
  return drawer.getByRole('group', { name: 'Today', exact: true })
}

/** A History row's open button (named `{title} {relative time}`). */
function historyOpen(drawer: Locator, title: string): Locator {
  return historyGroup(drawer).getByRole('button', {
    name: new RegExp(`^${escapeRegExp(title)}( |$)`)
  })
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

test('the drawer is the home: Menu, project row, search, New chat, Open, History and a pinned footer, 320px wide, with no status bar', async ({
  page
}) => {
  const project = await bootFreshProject(page)

  // The desktop StatusBar is gone from the mobile shell.
  await expect(page.locator('[data-status-bar]')).toHaveCount(0)

  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(menuButton(page)).not.toHaveAttribute('aria-controls', /.+/)
  const drawer = await openDrawer(page)
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(menuButton(page)).toHaveAttribute('aria-controls', 'mobile-shell-drawer')
  await expect(drawer).toHaveAttribute('id', 'mobile-shell-drawer')

  // min(82vw, 20rem) at 390px: 319.8px, never the old 72vw with a dead cap.
  const drawerBox = await boxOf(drawer)
  expect(drawerBox.width).toBeGreaterThan(319)
  expect(drawerBox.width).toBeLessThanOrEqual(320.5)

  // Top to bottom: Menu, project row, search, New chat, Open, Terminals,
  // History, then the pinned footer.
  const title = drawer.getByRole('heading', { level: 2, name: 'Menu', exact: true })
  const projectRow = drawer.getByRole('button', { name: project.name })
  const search = drawer.getByRole('textbox', { name: 'Search chats' })
  const newChat = drawer.getByRole('button', { name: 'New chat', exact: true })
  const openHeading = drawer.getByRole('heading', { level: 2, name: 'Open', exact: true })
  const terminalsHeading = drawer.getByRole('heading', { level: 3, name: 'Terminals' })
  const historyHeading = drawer.getByRole('heading', { level: 2, name: 'History', exact: true })
  const settings = drawer.getByRole('button', { name: 'Settings', exact: true })
  const snapshots = drawer.getByRole('button', { name: 'Snapshots', exact: true })
  const gitHistory = drawer.getByRole('button', { name: 'Git history', exact: true })
  const connection = drawer.getByRole('status')
  const ordered = [
    title,
    projectRow,
    search,
    newChat,
    openHeading,
    terminalsHeading,
    historyHeading,
    settings
  ]
  const tops: number[] = []
  for (const locator of ordered) tops.push((await boxOf(locator)).y)
  expect(tops).toEqual([...tops].sort((a, b) => a - b))
  expect(new Set(tops).size).toBe(tops.length)
  // The footer controls share a row; the status text sits below them.
  expect((await boxOf(snapshots)).y).toBe((await boxOf(settings)).y)
  expect((await boxOf(gitHistory)).y).toBe((await boxOf(settings)).y)
  expect((await boxOf(connection)).y).toBeGreaterThan((await boxOf(settings)).y)
  // The footer is pinned to the bottom of the drawer, below the scroll body.
  const footerBottom = (await boxOf(connection)).y + (await boxOf(connection)).height
  expect(footerBottom).toBeGreaterThan(844 - 80)
  expect((await boxOf(settings)).y).toBeGreaterThan((await boxOf(historyHeading)).y)

  // No Tabs group until a non-terminal, non-chat tab is open; no New project.
  await expect(drawer.getByRole('heading', { level: 3, name: 'Tabs' })).toHaveCount(0)
  await expect(drawer.getByRole('button', { name: 'New project' })).toHaveCount(0)
  await expect(drawer.getByText('No open terminals')).toBeVisible()
  await expect(drawer.getByText('No chats yet. Start one with the New chat button.')).toBeVisible()

  // Visible, named controls at the touch floor; the connection summary is text.
  await expectTouchTarget(projectRow, 'project row')
  await expectTouchTarget(search, 'search')
  await expectTouchTarget(newChat, 'New chat')
  await expectTouchTarget(settings, 'Settings')
  await expectTouchTarget(snapshots, 'Snapshots')
  await expectTouchTarget(gitHistory, 'Git history')
  await expectTouchTarget(drawer.getByRole('button', { name: 'New terminal' }), 'New terminal')
  await expect(connection).toHaveText(CONNECTED_TEXT)

  // A non-git project shows its name only: no "{branch} · {Local|Worktree}" line.
  await expect(projectRow).toContainText(project.name)
  await expect(projectRow).not.toContainText('·')

  // The search never takes focus on open (the keyboard must not rise): with
  // no active Open row the "Menu" title holds it.
  await expect(search).not.toBeFocused()
  await expect(title).toBeFocused()
  // The search field is 16px so iOS does not zoom on focus.
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

test('Open chat rows show live status, hold the 44px floor and name their actions', async ({
  page
}) => {
  const turns = trackTurnEnds(page)
  await bootFreshProject(page)
  const prompt = 'status survey [DURATION:15]'
  await launchChat(page, prompt)

  const drawer = await openDrawer(page)
  const row = chatRow(drawer, prompt)
  // A live turn: the spinner glyph plus the visible "Working" label.
  await expect(row).toHaveAccessibleName(`${prompt}, Working`)
  await expect(row).toContainText('Working')
  await expect(row).toHaveAttribute('aria-current', 'page')
  // Focus lands on the active Open row, never on the search.
  await expect(row).toBeFocused()
  await expect(drawer.getByRole('textbox', { name: 'Search chats' })).not.toBeFocused()
  // Open rows never show Failed.
  await expect(drawer.getByRole('group', { name: 'Open', exact: true })).not.toContainText('Failed')

  // 44px hit areas, with actions that name their object.
  await expectTouchTarget(row, 'chat row')
  const close = drawer.getByRole('button', { name: `Close ${prompt}`, exact: true })
  await expectTouchTarget(close, 'chat close')
  // The active row carries a primary leading bar (not colour alone).
  expect(await row.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('2px')

  // The turn finishes while this chat is the active one: no "New activity".
  await expect.poll(() => turns.count(), { timeout: 45_000 }).toBeGreaterThan(0)
  await expect(row).toHaveAccessibleName(prompt)
  await expect(row).not.toContainText('Working')
  await expect(row).not.toContainText('New activity')
})

test('a pending approval reads Needs you beside Working, and only Needs you takes the warning colour', async ({
  page
}) => {
  await bootFreshProject(page)
  const prompt = 'approval survey [PERMISSION] [DURATION:90]'
  await launchChat(page, prompt)

  const drawer = await openDrawer(page)
  const row = chatRow(drawer, prompt)
  await expect(row).toHaveAccessibleName(`${prompt}, Needs you, Working`)
  // The visible labels (the glyphs also carry sr-only copies of the same words).
  const needsYou = row.locator('span.text-2xs', { hasText: /^Needs you$/ })
  const working = row.locator('span.text-2xs', { hasText: /^Working$/ })
  await expect(needsYou).toBeVisible()
  await expect(working).toBeVisible()
  // "Needs you" leads, and it alone is in the warning colour.
  expect((await boxOf(needsYou)).x).toBeLessThan((await boxOf(working)).x)
  const colourOf = (label: Locator): Promise<string> =>
    label.evaluate((el) => getComputedStyle(el).color)
  expect(await colourOf(needsYou)).not.toBe(await colourOf(working))
  // A chat that needs you is never a failure.
  await expect(row).not.toContainText('Failed')
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

test('closing a chat mid-turn reads Closing (never Working) until the turn ends, then the row goes and History keeps the chat', async ({
  page
}) => {
  const turns = trackTurnEnds(page)
  await bootFreshProject(page)
  const prompt = 'echo review [DURATION:15]'
  await launchChat(page, prompt)

  const drawer = await openDrawer(page)
  await expect(chatRow(drawer, prompt)).toHaveAccessibleName(`${prompt}, Working`)
  await drawer.getByRole('button', { name: `Close ${prompt}`, exact: true }).tap()

  // The running turn stays on screen: "Closing" wins the slot over "Working".
  const row = chatRow(drawer, prompt)
  await expect(row).toHaveAccessibleName(`${prompt}, Closing`)
  await expect(row).toContainText('Closing')
  await expect(row).not.toContainText('Working')

  // When the turn ends the chat closes (no unread is banked for a closing
  // chat); the persisted chat stays reachable from History.
  await expect.poll(() => turns.count(), { timeout: 45_000 }).toBeGreaterThan(0)
  await expect(chatRow(drawer, prompt)).toHaveCount(0)
  await expect(historyOpen(drawer, prompt)).toBeVisible()
  await expect(drawer.getByRole('group', { name: 'Open', exact: true })).toHaveCount(0)
})

test('search filters History only, never takes focus, and starts fresh on each visit', async ({
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
  // Focus lands on the active Open row, not the search field.
  await expect(chatRow(drawer, second)).toBeFocused()
  await expect(search).not.toBeFocused()
  await expect(drawer.getByRole('heading', { level: 3, name: 'Today' })).toBeVisible()
  await expect(historyOpen(drawer, first)).toBeVisible()
  await expect(historyOpen(drawer, second)).toBeVisible()

  await search.tap()
  await search.fill('foxtrot')
  await expect(historyOpen(drawer, first)).toBeVisible()
  await expect(historyOpen(drawer, second)).toHaveCount(0)
  // Open rows are never filtered.
  await expect(chatRow(drawer, first)).toBeVisible()
  await expect(chatRow(drawer, second)).toBeVisible()

  await search.fill('zzz-no-such-chat')
  await expect(drawer.getByText('No chats match this search.')).toBeVisible()
  await expect(chatRow(drawer, first)).toBeVisible()
  await expect(chatRow(drawer, second)).toBeVisible()

  // Dismiss and reopen: the query resets and every History row is back.
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  drawer = await openDrawer(page)
  await expect(drawer.getByRole('textbox', { name: 'Search chats' })).toHaveValue('')
  await expect(historyOpen(drawer, first)).toBeVisible()
  await expect(historyOpen(drawer, second)).toBeVisible()
})

test('deleting from History asks first: Cancel and Esc keep the chat and return focus, Delete removes it and moves focus on', async ({
  page
}) => {
  const turns = trackTurnEnds(page)
  await bootFreshProject(page)
  const older = 'hotel notes [DURATION:2]'
  const newer = 'india notes [DURATION:2]'
  await launchChat(page, older)
  await launchChat(page, newer)
  // A turn's end bumps its chat's last activity and re-sorts History, and the
  // "next" row after a delete is decided by that order: let both turns end first.
  await expect.poll(() => turns.count(), { timeout: 45_000 }).toBeGreaterThanOrEqual(2)

  const drawer = await openDrawer(page)
  const deleteButton = (title: string): Locator =>
    historyGroup(drawer).getByRole('button', { name: `Delete ${title}`, exact: true })
  const confirm = page.getByRole('alertdialog', { name: 'Delete chat' })
  const historyRows = historyGroup(drawer).getByRole('button', { name: /^Delete / })
  await expect(historyRows).toHaveCount(2)
  await expectTouchTarget(deleteButton(newer), 'History delete')
  await expectTouchTarget(historyOpen(drawer, newer), 'History row')

  // The recency order decides which row is "next": read it, do not assume it.
  const order = await historyRows.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-label') ?? '')
  )
  const [topTitle, nextTitle] = order.map((label) => label.replace(/^Delete /, ''))
  expect([topTitle, nextTitle].sort()).toEqual([older, newer].sort())

  // Trash opens a confirm; nothing is deleted yet.
  await deleteButton(topTitle).tap()
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText(`Delete “${topTitle}”? This action cannot be undone.`)
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(confirm.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
  await expect(drawer).toBeVisible()

  // Cancel: nothing deleted, focus returns to that row's trash button.
  await confirm.getByRole('button', { name: 'Cancel' }).tap()
  await expect(confirm).toBeHidden()
  await expect(historyRows).toHaveCount(2)
  await expect(deleteButton(topTitle)).toBeFocused()

  // Esc behaves the same.
  await deleteButton(topTitle).tap()
  await expect(confirm).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(historyRows).toHaveCount(2)
  await expect(deleteButton(topTitle)).toBeFocused()
  await expect(drawer).toBeVisible()

  // Delete: the row goes, the drawer stays, focus moves to the next row's open button.
  await deleteButton(topTitle).tap()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).tap()
  await expect(confirm).toBeHidden()
  await expect(historyOpen(drawer, topTitle)).toHaveCount(0)
  await expect(historyRows).toHaveCount(1)
  await expect(drawer).toBeVisible()
  await expect(historyOpen(drawer, nextTitle)).toBeFocused()

  // Deleting the last visible row leaves nothing to focus: the History heading takes it.
  await deleteButton(nextTitle).tap()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).tap()
  await expect(confirm).toBeHidden()
  await expect(drawer.getByText('No chats yet. Start one with the New chat button.')).toBeVisible()
  await expect(
    drawer.getByRole('heading', { level: 2, name: 'History', exact: true })
  ).toBeFocused()
})

test('Terminals and Tabs rows: a new terminal is listed with rename and close, Git history adds a Tabs row, every action holds the 44px floor', async ({
  page
}) => {
  await bootFreshProject(page, { git: true })

  // New terminal is a navigation: the drawer closes and the shell shows it.
  let drawer = await openDrawer(page)
  await drawer.getByRole('button', { name: 'New terminal', exact: true }).tap()
  await expect(drawer).toBeHidden()

  drawer = await openDrawer(page)
  const terminalsHeading = drawer.getByRole('heading', { level: 3, name: 'Terminals' })
  const terminals = drawer.getByRole('group', { name: 'Terminals', exact: true })
  await expect(drawer.getByText('No open terminals')).toHaveCount(0)
  // The terminal's name is whatever the app gave it: read it off the rename action.
  const rename = terminals.getByRole('button', { name: /^Rename / })
  await expect(rename).toHaveCount(1)
  const name = ((await rename.getAttribute('aria-label')) ?? '').replace(/^Rename /, '')
  expect(name.length).toBeGreaterThan(0)
  const terminalRow = terminals.getByRole('button', { name, exact: true })
  const closeTerminal = terminals.getByRole('button', { name: `Close ${name}`, exact: true })
  // The new terminal is the active tab: it is the focused, current row.
  await expect(terminalRow).toHaveAttribute('aria-current', 'page')
  await expect(terminalRow).toBeFocused()
  await expectTouchTarget(terminalRow, 'terminal row')
  await expectTouchTarget(rename, 'terminal rename')
  await expectTouchTarget(closeTerminal, 'terminal close')

  // Rename in place: a labelled 16px field at the touch floor, committed with Enter.
  await rename.tap()
  const renameInput = terminals.getByRole('textbox', { name: `Rename ${name}`, exact: true })
  await expect(renameInput).toBeFocused()
  expect((await boxOf(renameInput)).height).toBeGreaterThanOrEqual(44)
  expect(await renameInput.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  await renameInput.fill('build shell')
  await page.keyboard.press('Enter')
  await expect(terminals.getByRole('button', { name: 'build shell', exact: true })).toBeVisible()
  await expect(
    terminals.getByRole('button', { name: 'Rename build shell', exact: true })
  ).toBeVisible()
  await expect(
    terminals.getByRole('button', { name: 'Close build shell', exact: true })
  ).toBeVisible()

  // Git history is a navigation too, and its tab lands in the Tabs group.
  await expect(drawer.getByRole('heading', { level: 3, name: 'Tabs' })).toHaveCount(0)
  await drawer.getByRole('button', { name: 'Git history', exact: true }).tap()
  await expect(drawer).toBeHidden()

  drawer = await openDrawer(page)
  const tabsHeading = drawer.getByRole('heading', { level: 3, name: 'Tabs' })
  await expect(tabsHeading).toBeVisible()
  const tabs = drawer.getByRole('group', { name: 'Tabs', exact: true })
  const gitRow = tabs.getByRole('button', { name: 'Git History', exact: true })
  const closeGit = tabs.getByRole('button', { name: 'Close Git History', exact: true })
  await expect(gitRow).toHaveAttribute('aria-current', 'page')
  await expect(gitRow).toBeFocused()
  await expectTouchTarget(gitRow, 'tab row')
  await expectTouchTarget(closeGit, 'tab close')
  // Terminals sit above Tabs.
  expect((await boxOf(terminalsHeading)).y).toBeLessThan((await boxOf(tabsHeading)).y)

  // Closing the only other tab removes the whole Tabs group.
  await closeGit.tap()
  await expect(tabsHeading).toHaveCount(0)
  await expect(drawer).toBeVisible()
})

test('focus returns to ☰ after Esc, the scrim and the built-in close, and a row navigation leaves the drawer on the opener', async ({
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

  // Scrim: a tap outside the 320px drawer.
  drawer = await openDrawer(page)
  await page.touchscreen.tap(375, 420)
  await expect(drawer).toBeHidden()
  await expect(menuButton(page)).toBeFocused()

  // The built-in close.
  drawer = await openDrawer(page)
  await drawer.getByRole('button', { name: 'Close', exact: true }).tap()
  await expect(drawer).toBeHidden()
  await expect(menuButton(page)).toBeFocused()

  // Row navigation, from an Open row and then from a History row: the drawer
  // closes on the chat it opened and focus lands on the opener (or the shell
  // title once the header goal adds it).
  drawer = await openDrawer(page)
  await chatRow(drawer, first).tap()
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: first, exact: true })).toBeVisible()
  await expectNavigationFocus(page)

  drawer = await openDrawer(page)
  await expect(chatRow(drawer, first)).toBeFocused()
  await historyOpen(drawer, second).tap()
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
