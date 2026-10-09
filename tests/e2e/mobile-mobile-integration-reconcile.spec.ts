import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile integration reconcile E2E (spec-mobile-integration-reconcile): a
 * phone-sized browser drives REAL agent chats through the web client's mobile
 * shell and checks the seams between the nine mobile PRs, which jsdom cannot:
 * where `document.activeElement` really lands when the Git sheet, the drawer and
 * the shell sheets close (one focus-return registry), that the drawer's
 * navigation resolves its destination against the chat that is visible once it
 * has closed, that ☰ and the attention pill point `aria-controls` at the real
 * open "Menu" dialog, that the drawer's project row agrees with the header
 * subtitle, and where the toast stack sits.
 *
 * Not observable in a browser, so covered by Vitest only: the registry's
 * resolver and fallback internals (a throwing resolver, a stale destination),
 * the "Git opener gone" and "pill opener gone" rows (they need an unmount in
 * the middle of an open sheet), a worktree chat with no recorded branch (the
 * server always records one), and "focus already inside a prompt is left
 * alone" (it needs a prompt that grabs focus during the close).
 *
 * Deliberately not asserted: where focus lands after a row that CREATES a
 * terminal (drawer New terminal, ⋯ New terminal, ⋯ Restart terminal). The new
 * xterm focuses its own input once it attaches, which the registry's "focus
 * already elsewhere: leave it" rule keeps (the spec's residual risk; focus after
 * navigation belongs to sibling goal G3). The terminal paths below use an
 * existing terminal's drawer row and the ⋯ Close terminal row instead.
 *
 * The fake agent (fake-longrun-agent.ts) supplies the content through prompt
 * markers: `[DOCK]` (a plan and three edits: the changed-files bar and its Git
 * action), `[ASK:question]` and `[ASK:elicitation]` (a pending prompt that
 * replaces the composer) and `[PERMISSION]` (a pending approval that makes the
 * chat "need you"). Every test registers its own project (fresh chat state,
 * nothing shared with other suites).
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

/**
 * Every chat (and every launcher warm-up) runs its own `bun` fake-agent process
 * and the server never reaps them when it stops, so each test kills the agents
 * it caused.
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
  // Close the page first: a page that is still open warms a replacement for the
  // agent killed below. A failed test keeps its page for the failure report.
  if (testInfo.status === testInfo.expectedStatus) await page.close()
  for (const agentId of await serverAgentIds()) {
    if (agentsBeforeTest.has(agentId)) continue
    await wsRequest(E2E_BASE_URL, 'kill_agent', { agentId }).catch(() => {
      // already gone
    })
  }
})

/** Keeps a turn running for the whole test, so the chat stays busy. */
const LONG = '[DURATION:90]'
/** The id of the shell header's `h1`: where a navigation hands focus. */
const SHELL_TITLE_ID = 'mobile-shell-title'
/** The drawer's id: what ☰ and the attention pill point `aria-controls` at. */
const DRAWER_ID = 'mobile-shell-drawer'
const QUESTION_PROMPT = '[data-approval-prompt^="question:"]'

interface Project {
  id: string
  name: string
  path: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Register a throwaway project under the suite's workspace root. The name is
 * unique per call: chats persist per project id, so a reused id would restore
 * an earlier test's chat. `git` makes it a repository with one commit on `main`.
 */
async function registerProject(options: { git?: boolean } = {}): Promise<Project> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-reconcile-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  if (options.git) {
    execSync('git init -q -b main', { cwd: path })
    execSync('git -c user.email=e2e@termul -c user.name=e2e commit -q --allow-empty -m init', {
      cwd: path
    })
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
  return { id, name, path }
}

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session. A chat launched BEFORE
 * it lands races that session (a test-only race: a person needs seconds to type
 * a prompt). An agent that fails to start also ends the warm-up.
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
 * Make `project` the web client's active project and load the app on it.
 * Resolves once the app's agent warm-up has settled (see `watchAgentWarmup`).
 */
async function openApp(page: Page, project: Project): Promise<void> {
  const warmedUp = watchAgentWarmup(page)
  await wsRequest(E2E_BASE_URL, 'store_write', {
    key: 'web-active-project',
    value: { _version: 1, data: project.id }
  })
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN,
    { timeout: 60_000 }
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  await warmedUp
}

/** Boot the mobile shell on `project`. */
async function bootShell(page: Page, project: Project): Promise<void> {
  await openApp(page, project)
  // The empty pane's launcher names the active project until a chat takes over:
  // seeing it proves the shell booted into our fresh project.
  await expect(
    page.getByRole('heading', { level: 1, name: `What should we do in ${project.name}?` })
  ).toBeVisible()
}

/**
 * Pick the launcher's isolation mode on a git project. The pick is persisted per
 * agent on the server (the next launcher starts with it), so a test that depends
 * on the mode chooses it instead of trusting the default.
 */
async function chooseIsolation(page: Page, mode: 'Local' | 'New worktree'): Promise<void> {
  await page.getByRole('combobox', { name: 'Isolation mode' }).tap()
  await page.getByRole('option', { name: mode }).tap()
  await expect(page.getByRole('combobox', { name: 'Isolation mode' })).toContainText(mode)
}

/**
 * Start a chat from the mobile shell: the empty pane shows the launcher
 * composer directly, an open chat needs the header "New chat" first. Resolves
 * once the header names the new chat (the title is the prompt text).
 */
async function startChat(page: Page, prompt: string, options: { viaNewChat?: boolean } = {}) {
  if (options.viaNewChat) await page.getByRole('button', { name: 'New chat', exact: true }).tap()
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
  await start.tap()
  await expect(page.getByRole('heading', { level: 1, name: prompt, exact: true })).toBeVisible()
}

/** The header title: `h1#mobile-shell-title`. */
function title(page: Page): Locator {
  return page.getByRole('banner').getByRole('heading', { level: 1 })
}

/** ☰ even while the modal drawer hides it from the accessibility tree. */
function menuButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Open menu', includeHidden: true })
}

/** The header ⋯ button (hidden from the tree while a sheet is open). */
function moreButton(page: Page): Locator {
  return page.getByRole('button', { name: 'More', exact: true, includeHidden: true })
}

/** The subtitle button (project · branch · Local/Worktree) that opens the project sheet. */
function subtitleButton(page: Page): Locator {
  return page.getByRole('button', { name: /, switch project$/, includeHidden: true })
}

/** Tap ☰ and wait for the drawer to be on screen and settled. */
async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  return settledDrawer(page)
}

async function settledDrawer(page: Page): Promise<Locator> {
  const drawer = page.getByRole('dialog', { name: 'Menu' })
  await expect(drawer).toBeVisible()
  // The sheet slides in from the left: act only once it has landed.
  await expect
    .poll(async () => (await drawer.boundingBox())?.x ?? Number.NEGATIVE_INFINITY)
    .toBeGreaterThanOrEqual(-0.5)
  return drawer
}

/** An Open-section chat row: named `{title}` or `{title}, {status…}`. */
function chatRow(drawer: Locator, chatTitle: string): Locator {
  return drawer
    .getByRole('group', { name: 'Open', exact: true })
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(chatTitle)}(,|$)`) })
}

/** Open the drawer, tap a chat's row, and wait for the drawer to be gone. */
async function navigateToChat(page: Page, chatTitle: string): Promise<void> {
  const drawer = await openDrawer(page)
  await chatRow(drawer, chatTitle).tap()
  await expect(drawer).toBeHidden()
}

/** The open question's dialog in the chat that is on screen. */
function visibleQuestion(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Which test suite should run?' })
}

/**
 * The element that holds focus, described for a failure message: its tag, its
 * accessible label and the prompt (if any) that contains it.
 */
async function describeFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return 'body'
    const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? ''
    const prompt = el.closest('[data-approval-prompt]')?.getAttribute('data-approval-prompt')
    return `${el.tagName.toLowerCase()}#${el.id} "${label}"${prompt ? ` in ${prompt}` : ''}`
  })
}

// ---------------------------------------------------------------------------
// The changed-files bar's Git action records itself as the Git sheet's opener
// ---------------------------------------------------------------------------

test.describe('Git sheet focus return', () => {
  test('closing the Git sheet opened from the changed-files bar returns focus to its Git action', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ git: true }))
    await chooseIsolation(page, 'Local')
    await startChat(page, `[DOCK] ${LONG} git action`)
    const git = page.getByRole('button', { name: 'Open Git changes', exact: true })
    const sheet = page.getByRole('dialog', { name: 'Git changes' })
    await expect(git).toBeVisible()

    // Escape.
    await git.tap()
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(git).toBeFocused()

    // The sheet's own close button.
    await git.tap()
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(sheet).toBeHidden()
    await expect(git).toBeFocused()

    // The scrim: the sheet is 90vh tall, so a tap in the strip above it lands on it.
    await git.tap()
    await expect(sheet).toBeVisible()
    await page.touchscreen.tap(195, 30)
    await expect(sheet).toBeHidden()
    await expect(git).toBeFocused()

    // The hardware back button closes the topmost overlay.
    await git.tap()
    await expect(sheet).toBeVisible()
    await page.goBack()
    await expect(sheet).toBeHidden()
    await expect(git).toBeFocused()
    // Never the ⋯ of the other entry, and never the page.
    await expect(moreButton(page)).not.toBeFocused()
  })

  test('opened from ⋯ the Git sheet returns focus to ⋯, and each open records its own opener', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ git: true }))
    await chooseIsolation(page, 'Local')
    await startChat(page, `[DOCK] ${LONG} git entries`)
    const git = page.getByRole('button', { name: 'Open Git changes', exact: true })
    const more = moreButton(page)
    const sheet = page.getByRole('dialog', { name: 'Git changes' })
    const viaMore = async (): Promise<void> => {
      await more.tap()
      await page
        .locator('#mobile-header-more-sheet')
        .getByRole('button', { name: 'Git changes', exact: true })
        .tap()
      await expect(sheet).toBeVisible()
    }

    await viaMore()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(more).toBeFocused()

    // The Git action replaces the ⋯ record: it does not fall back to ⋯.
    await git.tap()
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(git).toBeFocused()

    // And ⋯ replaces the Git action's record in turn.
    await viaMore()
    await sheet.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(sheet).toBeHidden()
    await expect(more).toBeFocused()
  })
})

// ---------------------------------------------------------------------------
// Drawer navigation: the destination is resolved once the drawer has closed
// ---------------------------------------------------------------------------

test.describe('drawer navigation focus', () => {
  test('a chat row lands focus on the open question first option, never the pager or Cancel', async ({
    page
  }) => {
    await bootShell(page, await registerProject())
    const prompt = `[ASK:question] ${LONG} question row`
    await startChat(page, prompt)
    const question = visibleQuestion(page)
    await expect(question).toBeVisible()
    const firstOption = question.getByRole('button', { name: /^Unit tests/ })
    // The question took focus when it arrived.
    await expect(firstOption).toBeFocused()
    // The stepper's own first button is not an option: it carries no aria-pressed.
    await expect(question.getByRole('button').first()).not.toHaveAttribute('aria-pressed', /.*/)
    await expect(firstOption).toHaveAttribute('aria-pressed', 'false')

    const drawer = await openDrawer(page)
    // The drawer's trap took focus off the question.
    await expect(firstOption).not.toBeFocused()
    await chatRow(drawer, prompt).tap()
    await expect(drawer).toBeHidden()

    await expect(firstOption).toBeFocused()
    expect(await describeFocus(page)).toContain('Unit tests')
    await expect(question.getByRole('button', { name: 'Cancel' })).not.toBeFocused()
    await expect(question.getByRole('button', { name: 'Previous question' })).not.toBeFocused()
    await expect(question.getByRole('button', { name: 'Next question' })).not.toBeFocused()
    // Opening the drawer from ☰ and dismissing it instead goes back to ☰.
    await openDrawer(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
    await expect(menuButton(page)).toBeFocused()
  })

  test('a question in a hidden chat tab is ignored; tapping its own row focuses it', async ({
    page
  }) => {
    await bootShell(page, await registerProject())
    const asking = `[ASK:question] ${LONG} asking chat`
    const plain = `${LONG} plain chat`
    await startChat(page, asking)
    await expect(visibleQuestion(page)).toBeVisible()
    await startChat(page, plain, { viaNewChat: true })

    // The first chat's question is still mounted behind the new chat, hidden,
    // and the visible chat has none: the precondition this test is about.
    await expect(page.locator(`[data-chat-tab-state="hidden"] ${QUESTION_PROMPT}`)).toHaveCount(1)
    await expect(page.locator(`[data-chat-tab-state="visible"] ${QUESTION_PROMPT}`)).toHaveCount(0)

    // Navigating to the chat with no question lands on the title, not in the
    // question of the chat that went out of view.
    await navigateToChat(page, plain)
    await expect(title(page)).toHaveText(plain)
    await expect(title(page)).toHaveId(SHELL_TITLE_ID)
    await expect(title(page)).toBeFocused()
    expect(await describeFocus(page)).not.toContain('question:')

    // Opening the asking chat's own row resolves against the chat that is
    // visible once the drawer has closed: its first option.
    await navigateToChat(page, asking)
    await expect(title(page)).toHaveText(asking)
    const firstOption = visibleQuestion(page).getByRole('button', { name: /^Unit tests/ })
    await expect(firstOption).toBeVisible()
    await expect(firstOption).toBeFocused()
    await expect(page.locator(`[data-chat-tab-state="hidden"] ${QUESTION_PROMPT}`)).toHaveCount(0)
  })

  test('a terminal row and a chat with only a permission land focus on the title, not in the terminal', async ({
    page
  }) => {
    await bootShell(page, await registerProject())
    const permission = `[PERMISSION] ${LONG} permission chat`
    await startChat(page, permission)
    await expect(page.getByRole('region', { name: 'Approval needed' })).toBeVisible()
    const terminalInput = page.getByRole('textbox', { name: 'Terminal input' })

    // A terminal to navigate to. A terminal created from the drawer focuses its
    // own input once it attaches, and the registry leaves focus where a
    // destination put it (the spec's residual risk), so nothing is asserted
    // about focus here.
    let drawer = await openDrawer(page)
    await drawer.getByRole('button', { name: 'New terminal' }).tap()
    await expect(drawer).toBeHidden()
    await expect(title(page)).toHaveText(/^Terminal \d+$/)
    await expect(terminalInput).toBeAttached()

    // Back to the chat that only has a permission pending: no question, so the title.
    await navigateToChat(page, permission)
    await expect(title(page)).toHaveText(permission)
    await expect(title(page)).toHaveId(SHELL_TITLE_ID)
    await expect(title(page)).toBeFocused()
    expect(await describeFocus(page)).not.toContain('approval')

    // A terminal row in the drawer: the destination is a terminal, and focus
    // must stay off xterm so the keyboard does not rise.
    drawer = await openDrawer(page)
    await drawer
      .getByRole('button', { name: /^Terminal \d+/ })
      .first()
      .tap()
    await expect(drawer).toBeHidden()
    await expect(title(page)).toHaveText(/^Terminal \d+$/)
    await expect(terminalInput).toBeAttached()
    await expect(title(page)).toBeFocused()
    await expect(terminalInput).not.toBeFocused()
  })
})

// ---------------------------------------------------------------------------
// ☰ and the attention pill: the opener, aria-controls, the return
// ---------------------------------------------------------------------------

test.describe('drawer opener', () => {
  test('☰ and the attention pill point aria-controls at the open Menu dialog and get focus back', async ({
    page
  }) => {
    await bootShell(page, await registerProject())
    // The first chat needs you for the whole test (an approval nobody answers):
    // once a second chat is on screen it is the "other chat" the pill counts.
    await startChat(page, `[PERMISSION] ${LONG} needs you`)
    await expect(page.getByRole('region', { name: 'Approval needed' })).toBeVisible()
    await startChat(page, `${LONG} calm chat`, { viaNewChat: true })
    const pill = page.getByRole('button', { name: '1 other chat needs you', includeHidden: true })
    await expect(pill).toBeVisible()
    const menu = menuButton(page)

    for (const [name, control] of [
      ['☰', menu],
      ['the attention pill', pill]
    ] as const) {
      await expect(
        control,
        `${name} controls nothing while the drawer is closed`
      ).not.toHaveAttribute('aria-controls', /.+/)
      await control.tap()
      const drawer = await settledDrawer(page)
      const controls = await control.getAttribute('aria-controls')
      expect(controls, `${name} aria-controls`).toBe(DRAWER_ID)
      // The attribute resolves to a real element: the open "Menu" dialog itself.
      await expect(page.locator(`#${controls}`)).toHaveCount(1)
      await expect(drawer).toHaveAttribute('id', controls as string)
      await expect(drawer).toHaveAttribute('data-state', 'open')
      await expect(control).toHaveAttribute('aria-expanded', 'true')

      // Dismissed by Escape it returns focus to the control that opened it.
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
      await expect(control, `${name} gets focus back`).toBeFocused()
    }

    // The pill opened it last, so the pill is where the scrim and back return too.
    await pill.tap()
    const drawer = await settledDrawer(page)
    await page.touchscreen.tap(380, 400)
    await expect(drawer).toBeHidden()
    await expect(pill).toBeFocused()
    await pill.tap()
    await settledDrawer(page)
    await page.goBack()
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
    await expect(pill).toBeFocused()

    // ☰ records itself the same way after the pill: the record is per open.
    await menu.tap()
    await settledDrawer(page)
    await page.keyboard.press('Escape')
    await expect(menu).toBeFocused()
  })
})

// ---------------------------------------------------------------------------
// Shell sheets: ⋯ (chat and terminal) and the project sheet
// ---------------------------------------------------------------------------

test.describe('shell sheets focus return', () => {
  test('the project sheet returns focus to the subtitle from both the subtitle and the drawer row', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ git: true }))
    await chooseIsolation(page, 'Local')
    await startChat(page, `${LONG} project sheet`)
    const subtitle = subtitleButton(page)
    const sheet = page.getByRole('dialog', { name: 'Projects' })

    // Entry 1: the header subtitle.
    await subtitle.tap()
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(subtitle).toBeFocused()

    // Entry 2: the drawer's project row hands off to the same sheet; it must
    // return to the subtitle, not to ☰ where the drawer was opened.
    const drawer = await openDrawer(page)
    await drawer.getByRole('button', { name: /^proj-reconcile-/ }).tap()
    await expect(sheet).toBeVisible()
    await expect(drawer).toBeHidden()
    await expect(menuButton(page)).not.toBeFocused()
    await page.goBack()
    await expect(sheet).toBeHidden()
    await expect(subtitle).toBeFocused()

    // The same entry, closed by the sheet's own close button.
    const again = await openDrawer(page)
    await again.getByRole('button', { name: /^proj-reconcile-/ }).tap()
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(sheet).toBeHidden()
    await expect(subtitle).toBeFocused()
  })

  test('the chat ⋯ sheet returns focus to ⋯ on dismiss and to the title once a row was chosen', async ({
    page
  }) => {
    await bootShell(page, await registerProject())
    // A short turn, so Close chat removes the tab at once (no idle-shutdown guard).
    await startChat(page, '[DURATION:2] chat more')
    await expect(page.getByText(/DONE after/)).toBeVisible()
    const more = moreButton(page)
    const sheet = page.locator('#mobile-header-more-sheet')

    for (const dismiss of ['Escape', 'Close'] as const) {
      await more.tap()
      await expect(sheet).toBeVisible()
      if (dismiss === 'Escape') await page.keyboard.press('Escape')
      else await sheet.getByRole('button', { name: 'Close', exact: true }).tap()
      await expect(sheet).toBeHidden()
      await expect(more).toBeFocused()
    }

    // A chosen row that opens no other overlay (Close chat): the chat leaves
    // and focus follows to the title, not back to a ⋯ that is no longer there.
    await more.tap()
    await sheet.getByRole('button', { name: 'Close chat', exact: true }).tap()
    await expect(sheet).toBeHidden()
    await expect(title(page)).toHaveText('Termul')
    await expect(title(page)).toHaveId(SHELL_TITLE_ID)
    await expect(title(page)).toBeFocused()
  })

  test('the terminal ⋯ sheet returns focus to ⋯ on dismiss and to the title once a row was chosen', async ({
    page
  }) => {
    await bootShell(page, await registerProject())
    await startChat(page, `${LONG} terminal more`)
    // A terminal from the drawer, so the header swaps ⋯ for "Terminal actions".
    const drawer = await openDrawer(page)
    await drawer.getByRole('button', { name: 'New terminal' }).tap()
    await expect(title(page)).toHaveText(/^Terminal \d+$/)
    const actions = page.getByRole('button', {
      name: 'Terminal actions',
      exact: true,
      includeHidden: true
    })
    const sheet = page.locator('#mobile-terminal-actions-sheet')

    for (const dismiss of ['Escape', 'Close'] as const) {
      await actions.tap()
      await expect(sheet).toBeVisible()
      if (dismiss === 'Escape') await page.keyboard.press('Escape')
      else await sheet.getByRole('button', { name: 'Close', exact: true }).tap()
      await expect(sheet).toBeHidden()
      await expect(actions).toBeFocused()
    }

    // A chosen row that opens no other overlay (Close terminal): focus follows
    // to the title. (Restart terminal is no example: the restarted terminal
    // focuses its own input.)
    await actions.tap()
    await sheet.getByRole('button', { name: 'Close terminal', exact: true }).tap()
    await expect(sheet).toBeHidden()
    await expect(title(page)).toHaveId(SHELL_TITLE_ID)
    await expect(title(page)).toBeFocused()
  })
})

// ---------------------------------------------------------------------------
// The drawer's project row reads through the isolation rules the header uses
// ---------------------------------------------------------------------------

test.describe('drawer project row', () => {
  test('names a worktree chat by its chat/ branch and Worktree, like the header subtitle', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ git: true }))
    await chooseIsolation(page, 'New worktree')
    await startChat(page, `${LONG} worktree row`)

    // The header subtitle shows the chat's worktree once `git worktree add` is done.
    await expect(subtitleButton(page)).toHaveText(
      /^proj-reconcile-[0-9a-f]+ · chat\/[0-9a-f]+ · Worktree$/
    )
    const drawer = await openDrawer(page)
    const row = drawer.getByRole('button', { name: /^proj-reconcile-/ })
    await expect(row).toContainText(/chat\/[0-9a-f]+ · Worktree/)
    // Never the project's own branch beside Worktree.
    await expect(row).not.toContainText('main')
    const detail = (await row.innerText()).match(/chat\/[0-9a-f]+ · Worktree/)?.[0]
    await expect(subtitleButton(page)).toContainText(detail as string)
  })

  test('names the project branch and Local for a chat in the project folder', async ({ page }) => {
    await bootShell(page, await registerProject({ git: true }))
    await chooseIsolation(page, 'Local')
    await startChat(page, `${LONG} local row`)
    const drawer = await openDrawer(page)
    await expect(drawer.getByRole('button', { name: /^proj-reconcile-/ })).toContainText(
      'main · Local'
    )
    await expect(subtitleButton(page)).toContainText('main · Local')
  })
})

// ---------------------------------------------------------------------------
// The toast stack: 136 on the mobile shell, 20 on desktop
// ---------------------------------------------------------------------------

/**
 * Raise a toast: the elicitation form refuses an empty required field with its
 * existing toast (and an inline alert saying the same). Resolves with the toast
 * and the toaster (`ol[data-sonner-toaster]`) it sits in.
 */
async function raiseToast(page: Page, press: (target: Locator) => Promise<void>) {
  await startChat(page, `[ASK:elicitation] ${LONG} toast`)
  await expect(
    page.getByRole('heading', { level: 2, name: 'Request from the agent' })
  ).toBeVisible()
  await press(page.getByRole('button', { name: 'Submit', exact: true }))
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'branch is required.' })
  await expect(toast).toBeVisible()
  return { toast, toaster: page.locator('[data-sonner-toaster]') }
}

/** The toaster's bottom offset custom properties, as sonner computed them. */
function toasterOffsets(toaster: Locator): Promise<{ offset: string; mobile: string }> {
  return toaster.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      offset: style.getPropertyValue('--offset-bottom').trim(),
      mobile: style.getPropertyValue('--mobile-offset-bottom').trim()
    }
  })
}

test.describe('toast offset', () => {
  test('the mobile shell lifts the toast stack 136px off the bottom edge', async ({ page }) => {
    await bootShell(page, await registerProject())
    const { toast, toaster } = await raiseToast(page, (target) => target.tap())

    // Both props carry the same object: 100 composer card + 24 padding + 12 gap.
    expect(await toasterOffsets(toaster)).toEqual({ offset: '136px', mobile: '136px' })
    // Geometry agrees once the toast has slid in: its bottom edge is 136px up.
    await expect
      .poll(async () => {
        const box = await toast.boundingBox()
        return box ? Math.round(844 - (box.y + box.height)) : Number.NaN
      })
      .toBe(136)
  })

  test.describe('desktop browser', () => {
    test.use({
      viewport: { width: 1440, height: 900 },
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    })

    /** Boot the desktop shell on a fresh project and start a chat from its launcher. */
    async function startDesktopChat(page: Page, prompt: string): Promise<void> {
      const project = await registerProject()
      await openApp(page, project)
      await expect(page.locator(`[aria-label^="Project: ${project.name}"]`).first()).toBeVisible()
      // The rail's New agent chat button opens the launcher.
      await page.locator('[aria-label="New agent chat"]').first().click()
      const composer = page
        .locator('[data-composer-editor="true"][aria-label="Agent prompt"]')
        .first()
      await composer.click()
      await page.keyboard.type(prompt)
      await page.keyboard.press('Enter')
    }

    test('keeps the 20px toast offset', async ({ page }) => {
      await startDesktopChat(page, `[ASK:elicitation] ${LONG} desktop toast`)
      await expect(
        page.getByRole('heading', { level: 2, name: 'Request from the agent' })
      ).toBeVisible()

      await page.getByRole('button', { name: 'Submit', exact: true }).click()
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'branch is required.' })
      await expect(toast).toBeVisible()
      const offsets = await toasterOffsets(page.locator('[data-sonner-toaster]'))
      expect(offsets.offset).toBe('20px')
      // The mobile offset is not set on desktop: sonner keeps its own default.
      expect(offsets.mobile).not.toBe('136px')
      await expect
        .poll(async () => {
          const box = await toast.boundingBox()
          return box ? Math.round(900 - (box.y + box.height)) : Number.NaN
        })
        .toBe(20)
    })

    test('the changed-files bar renders no Git action', async ({ page }) => {
      await startDesktopChat(page, `[DOCK] ${LONG} desktop bar`)
      // The bar keeps its desktop header (named by its action, not by its text)
      // and has no Git action: only the mobile shell wires `onOpenGitChanges`.
      await expect(page.getByRole('button', { name: 'Expand changed files' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open Git changes', exact: true })).toHaveCount(
        0
      )
    })
  })
})
