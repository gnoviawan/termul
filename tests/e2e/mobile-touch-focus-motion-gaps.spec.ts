import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile touch, focus and motion gaps E2E (spec-mobile-touch-focus-motion-gaps,
 * goal G6, items L-21 to L-26): a phone-sized browser drives the web client's
 * mobile shell and checks what jsdom cannot evaluate:
 * - L-21: where `document.activeElement` lands after the Files Delete confirm
 *   and after an inline rename ends (never `<body>`);
 * - L-22: the real `inert` attribute on the shell body while an overlay is
 *   open, the browser's own accessibility tree (the silenced chat log is gone
 *   from it) and the focus hand-offs that must run after `inert` is lifted;
 * - L-23: computed `animation-name` of the animated Radix primitives under
 *   `prefers-reduced-motion`;
 * - L-24: 44px hit areas on a landscape phone (a coarse pointer in a pane that
 *   reaches 400px) against the 40px a fine pointer keeps;
 * - L-25: the agent and model sheet's close button, 85dvh cap and scrolling;
 * - L-26: the transparent focus outline a message and a tool row carry in
 *   `forced-colors: active`.
 *
 * Every test registers its own project (fresh workspace, no state shared with
 * other suites). Project names start with `proj-gaps-` on purpose: other suites
 * select `proj-a`..`proj-x` by name PREFIX. Chat content comes from the fake
 * agent's prompt markers (`[DURATION:n]`, `[RICH]`, `[USAGE]`); the directory
 * of a project with `fixture: true` carries the `composer-row-e2e` marker, so
 * the fake advertises a model, a thought level and two modes (the composer
 * toolbar then has every chip).
 *
 * Not automated here (`ui/reduced-motion.test.tsx` pins their tokens): the Popover
 * (on the phone shell only the launcher's MCP badge opens one, and it renders only
 * when an MCP server is configured, which the suite's seeded server does not do;
 * the status bar, the sidebar and the desktop composer toolbar that host the others
 * are hidden on the phone), the HoverCard (it needs an attachment preview, and the
 * fake agent advertises no embedded context) and the Radix toast of `ui/toast.tsx`
 * (only the desktop sidebar and the worktree modal raise it; the phone's toasts are
 * Sonner's). The alert dialog, the image lightbox, the dropdown menu and the select
 * are driven for real.
 */

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  locale: 'en-US',
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
})

test.setTimeout(120_000)

/** Marker the fake agent looks for in the `session/new` cwd. */
const CWD_MARKER = 'composer-row-e2e'
/** A file for the `@` mention menu to find. */
const MENTION_TARGET = 'mention-target.md'

interface GapsProject {
  id: string
  name: string
  path: string
}

/**
 * Register a throwaway project under the suite's workspace root. The name is
 * unique per call: workspace layouts persist per project id, so a reused id
 * (e.g. under --repeat-each) would restore an earlier test's tabs.
 */
async function registerProject(
  options: { files?: boolean; git?: boolean; fixture?: boolean } = {}
): Promise<GapsProject> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const unique = randomUUID().slice(0, 8)
  const name = `proj-gaps-${unique}`
  const id = `e2e-${name}`
  const path = join(root, options.fixture ? `${CWD_MARKER}-${name}` : name)
  await mkdir(path, { recursive: true })
  if (options.files) {
    await writeFile(join(path, 'notes.md'), '# notes\n')
    await writeFile(join(path, 'todo.txt'), 'todo\n')
  }
  if (options.fixture) await writeFile(join(path, MENTION_TARGET), '# mention target\n')
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
 * launcher spawns the agent and creates a draft session. A chat launched
 * BEFORE it lands races that session (a test-only race: a person needs
 * seconds to type a prompt). An agent that fails to start also ends the
 * warm-up, because no session will follow it.
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

/**
 * Boot the mobile shell on `project`. `waitForWarmup` is for tests that launch
 * a chat from the empty pane.
 */
async function bootShell(
  page: Page,
  project: GapsProject,
  options: { waitForWarmup?: boolean } = {}
): Promise<void> {
  const warmedUp = options.waitForWarmup ? watchAgentWarmup(page) : Promise.resolve()
  await wsRequest(E2E_BASE_URL, 'store_write', {
    key: 'web-active-project',
    value: { _version: 1, data: project.id }
  })
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  await warmedUp
  // The header subtitle names the active project: seeing it proves the shell
  // booted into our fresh project.
  // A git project's label gains " · {branch}" once the git probe resolves, so it is matched either way.
  await expect(
    page.getByRole('button', { name: new RegExp(`^${project.name}(?: · [^,]+)?, switch project`) })
  ).toBeVisible()
}

/**
 * Start a chat from the mobile shell: the empty pane shows the launcher
 * composer directly, an open chat needs the header "New chat" first. Resolves
 * once the header names the new chat (the title is the prompt text).
 */
async function startChat(page: Page, prompt: string, options: { viaNewChat?: boolean } = {}) {
  if (options.viaNewChat) await page.getByRole('button', { name: 'New chat' }).click()
  const composer = page.getByRole('textbox', { name: 'Agent prompt' })
  await composer.click()
  await page.keyboard.type(prompt)
  await page.getByRole('button', { name: 'Start agent chat' }).click()
  await expect(page.getByRole('heading', { level: 1, name: prompt, exact: true })).toBeVisible()
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

/**
 * Wait for every finite CSS animation under `locator` (a slide or zoom in) to finish.
 * Looping ones (the "Working…" shimmer) never finish and are left out.
 */
async function settled(locator: Locator): Promise<void> {
  await locator.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished)
    )
  )
}

/** The header ⋯ button, which the Files and Git sheets open from. */
function moreButton(page: Page): Locator {
  return page.getByRole('button', { name: 'More', exact: true })
}

/** Open the header ⋯ sheet and choose one of its rows (Files, Git changes, ...). */
async function chooseFromMore(page: Page, row: string): Promise<void> {
  await moreButton(page).tap()
  await page
    .locator('#mobile-header-more-sheet')
    .getByRole('button', { name: row, exact: true })
    .tap()
}

/** The Files sheet. Radix names it by the project folder's basename, which is not the project's display name for a `fixture` project. */
function filesSheetOf(page: Page, project: GapsProject): Locator {
  return page.getByRole('dialog', { name: basename(project.path), exact: true })
}

/** The shell's body wrapper: the chat, the launcher and the editor live inside it. */
function shellBody(page: Page): Locator {
  return page.locator('[data-mobile-shell-body]')
}

function liveRegion(page: Page): Locator {
  return page.locator('[data-shell-live-region]')
}

/** Whether `locator` sits inside an `inert` subtree (the element itself counts). */
function isInert(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el.closest('[inert]') !== null)
}

/**
 * Press Tab from the top of the document until `target` holds focus, so the
 * browser treats the focus as keyboard-driven (`:focus-visible` matches). A
 * scripted `focus()` after a tap would not match it.
 */
async function tabTo(page: Page, target: Locator, maxPresses = 60): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  for (let press = 0; press < maxPresses; press++) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((el) => el === document.activeElement)) return
  }
  throw new Error(`Tab never reached the target within ${maxPresses} presses`)
}

// ---------------------------------------------------------------------------
// L-21: focus after the Files Delete confirm and after a rename
// ---------------------------------------------------------------------------

test.describe('Files sheet focus (L-21)', () => {
  function actionsButton(page: Page, fileName: string): Locator {
    return page.getByRole('button', { name: `Actions for ${fileName}`, exact: true })
  }

  /** The file actions sheet: Radix names it by its title (the file name). */
  function actionsSheet(page: Page, fileName: string): Locator {
    return page.getByRole('dialog', { name: fileName, exact: true })
  }

  async function openFiles(page: Page, project: GapsProject): Promise<Locator> {
    await chooseFromMore(page, 'Files')
    const sheet = filesSheetOf(page, project)
    await expect(sheet).toBeVisible()
    await expect(actionsButton(page, 'notes.md')).toBeVisible()
    return sheet
  }

  /** Row Actions, then one of the sheet's rows (Rename, Delete). */
  async function chooseRowAction(page: Page, fileName: string, action: string): Promise<void> {
    await actionsButton(page, fileName).tap()
    const sheet = actionsSheet(page, fileName)
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: action, exact: true }).tap()
    await expect(sheet).toBeHidden()
  }

  function renameInput(page: Page, fileName: string): Locator {
    return page.getByRole('textbox', { name: `Rename ${fileName}` })
  }

  /** Whether the focused element is inside `sheet` (the sheet itself counts): never `<body>`. */
  function focusIsInside(sheet: Locator): Promise<boolean> {
    return sheet.evaluate((el) => el.contains(document.activeElement))
  }

  test('cancelling the Delete confirm, or dismissing it with Escape, returns focus to the row Actions button', async ({
    page
  }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)
    const sheet = await openFiles(page, project)
    const confirm = page.getByRole('alertdialog', { name: 'Delete notes.md' })

    await chooseRowAction(page, 'notes.md', 'Delete')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).tap()
    await expect(confirm).toBeHidden()
    // The Files sheet stays open and the focus lands on the row that opened
    // the confirm, not on <body>.
    await expect(sheet).toBeVisible()
    await expect(actionsButton(page, 'notes.md')).toBeFocused()

    await chooseRowAction(page, 'notes.md', 'Delete')
    await expect(confirm).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(confirm).toBeHidden()
    await expect(sheet).toBeVisible()
    await expect(actionsButton(page, 'notes.md')).toBeFocused()
    expect(existsSync(join(project.path, 'notes.md'))).toBe(true)
  })

  test('confirming the Delete removes the file once and never leaves focus on <body>', async ({
    page
  }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)
    const sheet = await openFiles(page, project)
    const confirm = page.getByRole('alertdialog', { name: 'Delete notes.md' })

    await chooseRowAction(page, 'notes.md', 'Delete')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete', exact: true }).tap()
    await expect(confirm).toBeHidden()

    // The row is gone once the listing refreshes, and so is its Actions
    // button: the sheet's focus trap keeps focus inside the Files sheet.
    await expect(page.getByRole('button', { name: 'Open notes.md' })).toHaveCount(0)
    await expect(sheet).toBeVisible()
    await expect.poll(() => focusIsInside(sheet)).toBe(true)
    expect(existsSync(join(project.path, 'notes.md'))).toBe(false)
    // The other row is untouched.
    expect(existsSync(join(project.path, 'todo.txt'))).toBe(true)
  })

  test('ending a rename with Escape, an unchanged name or an empty name returns focus to the row Actions button', async ({
    page
  }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)
    const sheet = await openFiles(page, project)

    // Escape ends the rename only: the Files sheet stays open.
    await chooseRowAction(page, 'notes.md', 'Rename')
    await expect(renameInput(page, 'notes.md')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(renameInput(page, 'notes.md')).toHaveCount(0)
    await expect(sheet).toBeVisible()
    await expect(actionsButton(page, 'notes.md')).toBeFocused()

    // Enter with the name unchanged.
    await chooseRowAction(page, 'notes.md', 'Rename')
    await expect(renameInput(page, 'notes.md')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(renameInput(page, 'notes.md')).toHaveCount(0)
    await expect(actionsButton(page, 'notes.md')).toBeFocused()

    // Enter with an empty name.
    await chooseRowAction(page, 'notes.md', 'Rename')
    await renameInput(page, 'notes.md').fill('')
    await page.keyboard.press('Enter')
    await expect(renameInput(page, 'notes.md')).toHaveCount(0)
    await expect(actionsButton(page, 'notes.md')).toBeFocused()
    expect(existsSync(join(project.path, 'notes.md'))).toBe(true)
  })

  test('committing a rename focuses the renamed row Actions button once the listing shows it', async ({
    page
  }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)
    await openFiles(page, project)

    await chooseRowAction(page, 'notes.md', 'Rename')
    await renameInput(page, 'notes.md').fill('renamed.md')
    await page.keyboard.press('Enter')

    await expect(page.getByRole('button', { name: 'Open renamed.md' })).toBeVisible()
    await expect(actionsButton(page, 'renamed.md')).toBeFocused()
    expect(existsSync(join(project.path, 'renamed.md'))).toBe(true)
    expect(existsSync(join(project.path, 'notes.md'))).toBe(false)
  })

  test('a failed rename toasts and focuses the original row Actions button', async ({ page }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)
    await openFiles(page, project)

    // The parent folder does not exist, so the server refuses the rename.
    await chooseRowAction(page, 'notes.md', 'Rename')
    await renameInput(page, 'notes.md').fill('missing-folder/notes.md')
    await page.keyboard.press('Enter')

    await expect(page.getByText('Failed to rename')).toBeVisible()
    await expect(actionsButton(page, 'notes.md')).toBeFocused()
    expect(existsSync(join(project.path, 'notes.md'))).toBe(true)
  })

  test('a rename that blurs because the user moved focus leaves focus where the user put it', async ({
    page
  }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)
    await openFiles(page, project)

    await chooseRowAction(page, 'notes.md', 'Rename')
    await expect(renameInput(page, 'notes.md')).toBeFocused()
    // Tab hands focus to the next row's control; the rename ends unchanged.
    await page.keyboard.press('Tab')
    await expect(renameInput(page, 'notes.md')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open todo.txt' })).toBeFocused()
    // Nothing steals it back a moment later.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await expect(page.getByRole('button', { name: 'Open todo.txt' })).toBeFocused()
    await expect(actionsButton(page, 'notes.md')).not.toBeFocused()
  })
})

// ---------------------------------------------------------------------------
// L-22: the chat body is inert behind a blocking overlay
// ---------------------------------------------------------------------------

test.describe('inert behind overlays (L-22)', () => {
  /**
   * The browser's own accessibility tree: the nodes with role `log` that a
   * screen reader can still reach (`ignored: false`). The silenced chat log
   * must not be among them while a modal sheet is open.
   */
  async function reachableLogs(page: Page): Promise<number> {
    const cdp = await page.context().newCDPSession(page)
    try {
      const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
        nodes: Array<{ ignored?: boolean; role?: { value?: string } }>
      }
      return nodes.filter((node) => node.role?.value === 'log' && node.ignored !== true).length
    } finally {
      await cdp.detach()
    }
  }

  test('the body goes inert behind the Files sheet, and the live region and header never do', async ({
    page
  }) => {
    const project = await registerProject({ files: true, fixture: true })
    await bootShell(page, project, { waitForWarmup: true })
    await startChat(page, 'gaps inert [DURATION:2]')
    const log = page.getByRole('log')
    await expect(log).toHaveAttribute('aria-live', 'off')
    await expect(shellBody(page)).toHaveCount(1)
    await expect(shellBody(page)).not.toHaveAttribute('inert')
    expect(await reachableLogs(page)).toBe(1)

    await chooseFromMore(page, 'Files')
    const filesSheet = filesSheetOf(page, project)
    await expect(filesSheet).toBeVisible()
    await expect(shellBody(page)).toHaveAttribute('inert', '')
    // The silenced log is out of the browser's accessibility tree, so a screen
    // reader cannot swipe into the chat history behind the sheet.
    await expect.poll(() => reachableLogs(page)).toBe(0)
    expect(await isInert(log)).toBe(true)
    // The shell's own live region, header and everything outside the body stay live.
    expect(await isInert(liveRegion(page))).toBe(false)
    expect(await liveRegion(page).evaluate((el) => el.closest('[inert]'))).toBeNull()
    expect(
      await page
        .locator('header')
        .first()
        .evaluate((el) => el.closest('[inert]'))
    ).toBeNull()
    // The log keeps its explicit silence while inert.
    await expect(log).toHaveAttribute('aria-live', 'off')

    // A second overlay on top (the file actions sheet) keeps it inert, and
    // closing only that one does not lift it: the Files sheet is still open.
    await page.getByRole('button', { name: 'Actions for notes.md' }).tap()
    const actionsSheet = page.getByRole('dialog', { name: 'notes.md', exact: true })
    await expect(actionsSheet).toBeVisible()
    await expect(shellBody(page)).toHaveAttribute('inert', '')
    await page.keyboard.press('Escape')
    await expect(actionsSheet).toBeHidden()
    await expect(filesSheet).toBeVisible()
    await expect(shellBody(page)).toHaveAttribute('inert', '')

    // The last overlay closing lifts it, and ⋯ (outside the wrapper) gets focus back.
    await page.keyboard.press('Escape')
    await expect(filesSheet).toBeHidden()
    await expect(shellBody(page)).not.toHaveAttribute('inert')
    await expect(moreButton(page)).toBeFocused()
    await expect.poll(() => reachableLogs(page)).toBe(1)
    expect(await isInert(log)).toBe(false)
  })

  test('the drawer is a blocking overlay too, and the live region still announces behind it', async ({
    page
  }) => {
    await bootShell(page, await registerProject())
    await expect(shellBody(page)).not.toHaveAttribute('inert')

    await page.getByRole('button', { name: 'Open menu' }).tap()
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible()
    await expect(shellBody(page)).toHaveAttribute('inert', '')
    expect(await isInert(liveRegion(page))).toBe(false)
    // The drawer is a sibling of the wrapper: it is never inert itself.
    expect(
      await page.getByRole('dialog', { name: 'Menu' }).evaluate((el) => el.closest('[inert]'))
    ).toBeNull()
    // The region works while the body is inert: the drawer search announces its count.
    await page.getByRole('textbox', { name: 'Search chats' }).fill('zzz-no-such-chat')
    await expect(liveRegion(page)).toHaveText('0 chats match')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
    await expect(shellBody(page)).not.toHaveAttribute('inert')
  })

  test('Mention file and Commands still focus the editor right after the + sheet closes', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ fixture: true }), { waitForWarmup: true })
    await startChat(page, 'gaps plus sheet [DURATION:2]')
    const composer = page.locator('[data-chat-composer="true"]')
    const editor = composer.getByRole('textbox', { includeHidden: true })
    const addButton = page.getByRole('button', { name: 'Add to chat', includeHidden: true })
    const addSheet = page.getByRole('dialog', { name: 'Add to chat' })

    for (const [action, trigger] of [
      ['Mention file', '@'],
      ['Commands', '/']
    ] as const) {
      await addButton.tap()
      await expect(addSheet).toBeVisible()
      // The composer sits inside the shell body: inert while the sheet is open...
      await expect(shellBody(page)).toHaveAttribute('inert', '')
      await addSheet.getByRole('button', { name: action, exact: true }).tap()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      // ...and the attribute is gone before the editor takes focus, or the
      // focus() inside the same tap would have been refused.
      await expect(shellBody(page)).not.toHaveAttribute('inert')
      await expect(editor).toBeFocused()
      await expect(editor).toHaveText(trigger)
      await editor.tap()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await expect(editor).toHaveText('')
    }
  })

  test('an opener inside the body takes focus back once the last overlay closes', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ fixture: true }), { waitForWarmup: true })
    await startChat(page, 'gaps opener [USAGE] [DURATION:2]')
    const ring = page.getByRole('button', { name: /^Context \d+ percent used$/ })
    const details = page.getByRole('dialog', { name: 'Context window' })

    await ring.tap()
    await expect(details).toBeVisible()
    await expect(shellBody(page)).toHaveAttribute('inert', '')
    await page.keyboard.press('Escape')
    await expect(details).toBeHidden()
    await expect(shellBody(page)).not.toHaveAttribute('inert')
    // The ring sits inside the wrapper: it could only take focus back after
    // `inert` was lifted.
    await expect(ring).toBeFocused()
  })

  test('the agent launcher over an open chat is an exempt overlay: the body stays interactive', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ fixture: true }), { waitForWarmup: true })
    await startChat(page, 'gaps launcher [DURATION:2]')

    await page.getByRole('button', { name: 'New chat' }).tap()
    const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
    await expect(launcher).toBeVisible()
    await expect(shellBody(page)).not.toHaveAttribute('inert')
    expect(await isInert(launcher)).toBe(false)
    // It takes input: an inert subtree would refuse the focus and the keys.
    await launcher.click()
    await expect(launcher).toBeFocused()
    await page.keyboard.type('hello')
    await expect(launcher).toContainText('hello')
  })

  test('a long-press message menu is exempt: it opens, the body stays interactive and it stays open after the finger lifts', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ fixture: true }), { waitForWarmup: true })
    const prompt = `gaps menu ${randomUUID().slice(0, 6)} [DURATION:2]`
    await startChat(page, prompt)
    const message = page
      .getByRole('log')
      .locator('[data-slot="message"]')
      .filter({ hasText: prompt })
      .first()
    await expect(message).toHaveAttribute('tabindex', '0', { timeout: 60_000 })
    const target = message.getByText(prompt)
    await target.scrollIntoViewIfNeeded()
    const box = await boxOf(target)
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

    // A real finger: down, held past the 700ms timer, then lifted.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await expect(page.getByRole('menu')).toBeVisible()
    // The trigger sits inside the body wrapper, mid-gesture: it must not go inert.
    await expect(shellBody(page)).not.toHaveAttribute('inert')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(shellBody(page)).not.toHaveAttribute('inert')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('the desktop shell has no shell body to make inert', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    })
    try {
      const page = await context.newPage()
      const project = await registerProject()
      await wsRequest(E2E_BASE_URL, 'store_write', {
        key: 'web-active-project',
        value: { _version: 1, data: project.id }
      })
      await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
      await page.waitForFunction(
        (token) => localStorage.getItem('termul.webAuthToken') === token,
        E2E_TOKEN
      )
      await page.goto(`${E2E_BASE_URL}/#/`)
      await expect(page.locator(`[aria-label^="Project: ${project.name}"]`).first()).toBeVisible()
      await expect(shellBody(page)).toHaveCount(0)
      await expect(page.locator('[inert]')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})

// ---------------------------------------------------------------------------
// L-23: reduced motion on the animated overlay primitives
// ---------------------------------------------------------------------------

test.describe('reduced motion (L-23)', () => {
  /** The `animation-name` of the content and, where it has one, its overlay (the previous sibling). */
  function animationNames(content: Locator): Promise<string[]> {
    return content.evaluate((el) =>
      [el, el.previousElementSibling]
        .filter(
          (node): node is Element => node instanceof Element && node.hasAttribute('data-state')
        )
        .map((node) => getComputedStyle(node).animationName)
    )
  }

  /**
   * Open the surface and read its animation names with motion allowed (Tailwind's
   * `animate-in` names its keyframes `enter`), then again under reduced motion,
   * where `motion-reduce:animate-none!` must win over `data-[state=open]:animate-in`.
   */
  async function expectAnimatedUnlessReduced(
    page: Page,
    surface: {
      name: string
      open: () => Promise<void>
      content: Locator
      /** Dismisses the surface; resolves once it is gone. */
      close: () => Promise<void>
    }
  ): Promise<void> {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion })
      await surface.open()
      await expect(surface.content).toBeVisible()
      const names = await animationNames(surface.content)
      expect(names.length, `${surface.name} animated surfaces`).toBeGreaterThan(0)
      for (const name of names) {
        if (reducedMotion === 'reduce') expect(name, `${surface.name} (reduced)`).toBe('none')
        else expect(name, `${surface.name} (motion)`).toBe('enter')
      }
      await surface.close()
    }
  }

  test('the alert dialog (Delete confirm) animates normally and not at all under reduced motion', async ({
    page
  }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)
    await chooseFromMore(page, 'Files')
    const filesSheet = filesSheetOf(page, project)
    await expect(filesSheet).toBeVisible()
    const confirm = page.getByRole('alertdialog', { name: 'Delete notes.md' })

    await expectAnimatedUnlessReduced(page, {
      name: 'alert dialog',
      open: async () => {
        await page.getByRole('button', { name: 'Actions for notes.md' }).tap()
        await page
          .getByRole('dialog', { name: 'notes.md', exact: true })
          .getByRole('button', { name: 'Delete', exact: true })
          .tap()
      },
      content: confirm,
      close: async () => {
        await page.keyboard.press('Escape')
        await expect(confirm).toBeHidden()
        await expect(filesSheet).toBeVisible()
      }
    })
  })

  test('the image lightbox animates normally and not at all under reduced motion', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ fixture: true }), { waitForWarmup: true })
    await startChat(page, '[RICH] gaps lightbox')
    const thumbnail = page.getByRole('button', { name: 'Open image: Image' })
    const lightbox = page.getByRole('dialog', { name: 'Image' })

    await expectAnimatedUnlessReduced(page, {
      name: 'image lightbox',
      open: () => thumbnail.tap(),
      content: lightbox,
      close: async () => {
        await lightbox.getByRole('button', { name: 'Close image' }).tap()
        await expect(lightbox).toBeHidden()
      }
    })
  })

  test('the dropdown menu (Git branch menu) animates normally and not at all under reduced motion', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ git: true }))
    await chooseFromMore(page, 'Git changes')
    const gitSheet = page.getByRole('dialog', { name: 'Git changes' })
    await expect(gitSheet).toBeVisible()
    const menu = page.getByRole('menu')

    await expectAnimatedUnlessReduced(page, {
      name: 'dropdown menu',
      open: () => gitSheet.getByRole('button', { name: /^(main|Detached HEAD)$/ }).tap(),
      content: menu,
      close: async () => {
        await page.keyboard.press('Escape')
        await expect(menu).toBeHidden()
        await expect(gitSheet).toBeVisible()
      }
    })
  })

  test('the select (launcher isolation picker) animates normally and not at all under reduced motion', async ({
    page
  }) => {
    const project = await registerProject({ git: true })
    // The launcher spawns its agent at boot and re-renders as that settles: a tap that
    // lands before it is lost, so the picker is used only after the warm-up.
    await bootShell(page, project, { waitForWarmup: true })
    // The header subtitle names the branch once the git probe has resolved, and the
    // launcher's context strip (with the isolation picker) is final from then on.
    await expect(
      page.getByRole('button', { name: new RegExp(`^${project.name} · main`) })
    ).toBeVisible()
    const trigger = page.getByRole('combobox', { name: 'Isolation mode' })
    await expect(trigger).toBeVisible()
    const list = page.getByRole('listbox')

    await expectAnimatedUnlessReduced(page, {
      name: 'select',
      open: () => trigger.tap(),
      content: list,
      close: async () => {
        await page.keyboard.press('Escape')
        await expect(list).toBeHidden()
      }
    })
  })
})

// ---------------------------------------------------------------------------
// L-24: 44px hit areas on a landscape phone
// ---------------------------------------------------------------------------

test.describe('landscape phone hit areas (L-24)', () => {
  test.use({ viewport: { width: 844, height: 390 } })

  /**
   * The hit height of a control whose `::after` extends the box vertically
   * (`after:-inset-y-1.5` is 6px, `@[400px]:after:-inset-y-1` is 4px): the box
   * plus what the pseudo-element adds above and below it.
   */
  async function hitHeight(control: Locator): Promise<number> {
    return control.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const after = getComputedStyle(el, '::after')
      return rect.height - Number.parseFloat(after.top) - Number.parseFloat(after.bottom)
    })
  }

  /** The `::after` hit area of a square-ish control extended on all four sides. */
  async function hitSize(control: Locator): Promise<{ width: number; height: number }> {
    return control.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const after = getComputedStyle(el, '::after')
      return {
        width: rect.width - Number.parseFloat(after.left) - Number.parseFloat(after.right),
        height: rect.height - Number.parseFloat(after.top) - Number.parseFloat(after.bottom)
      }
    })
  }

  /**
   * A running chat with the whole one-row composer (+, model pill, mode chip,
   * context ring, stop), a queued draft and enough streamed text for the log to
   * scroll. `[DURATION:60]` keeps the turn busy for the whole test.
   */
  async function openBusyChat(page: Page): Promise<void> {
    await bootShell(page, await registerProject({ fixture: true }), { waitForWarmup: true })
    await startChat(page, '[USAGE] [DURATION:60] gaps landscape')
    await expect(page.getByRole('button', { name: /^Context \d+ percent used$/ })).toBeVisible()
    await expect(page.getByRole('log')).toContainText('chunk-1')
  }

  async function queueDraft(page: Page, text: string): Promise<void> {
    const editor = page
      .locator('[data-chat-composer="true"]')
      .getByRole('textbox', { includeHidden: true })
    await editor.click()
    await page.keyboard.insertText(text)
    await expect(editor).toHaveText(text)
    await page.getByRole('button', { name: 'Queue message' }).click()
    await expect(editor).toHaveText('')
    // The phone shell collapses the queue by default: open it to reach the row actions.
    await page.getByRole('button', { name: /Queued/ }).click()
  }

  /** Scroll the chat log up until the "Scroll to latest" button shows. */
  async function scrollLogUp(page: Page): Promise<Locator> {
    // Wait for enough streamed text that the log overflows a 390px viewport.
    await expect(page.getByRole('log')).toContainText('chunk-4', { timeout: 30_000 })
    await page.locator('[data-slot="message-scroller-viewport"]').evaluate((el) => {
      el.scrollTop = 0
    })
    const jump = page.getByRole('button', { name: /^Scroll to latest/ })
    await expect(jump).toBeVisible()
    await settled(page.locator('[data-slot="message-scroller"]'))
    return jump
  }

  test('on a coarse pointer the composer row, the mention menu, the queue and the jump button keep 44px', async ({
    page
  }) => {
    await openBusyChat(page)
    const composer = page.locator('[data-chat-composer="true"]')

    // The whole one-row composer, measured on its real hit area.
    expect(
      (await boxOf(page.getByRole('button', { name: 'Add to chat' }))).height
    ).toBeGreaterThanOrEqual(44)
    expect(
      (await boxOf(page.getByRole('button', { name: 'Add to chat' }))).width
    ).toBeGreaterThanOrEqual(44)
    const pill = composer.getByTestId('agent-model-selector-trigger')
    const modeChip = page.getByRole('button', { name: 'Default', exact: true })
    const ring = page.getByRole('button', { name: /^Context \d+ percent used$/ })
    for (const [name, control] of [
      ['model pill', pill],
      ['mode chip', modeChip],
      ['context ring', ring]
    ] as const) {
      expect(await hitHeight(control), `${name} hit height`).toBeGreaterThanOrEqual(44)
    }
    const stop = page.getByRole('button', { name: 'Cancel turn' })
    const stopHit = await hitSize(stop)
    expect(stopHit.width, 'stop hit width').toBeGreaterThanOrEqual(44)
    expect(stopHit.height, 'stop hit height').toBeGreaterThanOrEqual(44)

    // A queued draft: its two actions are 44px boxes.
    await queueDraft(page, 'queued landscape note')
    const sendNow = page.getByRole('button', { name: /^Send now/ })
    const remove = page.getByRole('button', { name: /^Remove from queue/ })
    for (const [name, action] of [
      ['send now', sendNow],
      ['remove', remove]
    ] as const) {
      const box = await boxOf(action)
      expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44)
      expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44)
    }

    // The mention menu rows.
    await page.getByRole('button', { name: 'Add to chat' }).tap()
    await page
      .getByRole('dialog', { name: 'Add to chat' })
      .getByRole('button', { name: 'Mention file', exact: true })
      .tap()
    // The menu lists nothing for an empty query: type the start of the file name.
    await page.keyboard.type('mention-t')
    const option = page.getByRole('option', { name: MENTION_TARGET })
    await expect(option).toBeVisible()
    expect((await boxOf(option)).height).toBeGreaterThanOrEqual(44)
    await page.keyboard.press('Escape')

    // The jump-to-latest button.
    const jump = await scrollLogUp(page)
    const jumpBox = await boxOf(jump)
    expect(jumpBox.width).toBeGreaterThanOrEqual(44)
    expect(jumpBox.height).toBeGreaterThanOrEqual(44)
  })

  test.describe('with a fine pointer', () => {
    // A mouse on the same 844x390 window: still the phone shell (short and
    // wide), but no coarse pointer, so the 400px pane keeps its 40px targets.
    test.use({ isMobile: false, hasTouch: false, deviceScaleFactor: 1 })

    test('a 400px pane keeps 40px targets', async ({ page }) => {
      await openBusyChat(page)
      // The model pill is left out: it is a 44px box on the phone shell for every pointer.
      const ring = page.getByRole('button', { name: /^Context \d+ percent used$/ })
      expect(await hitHeight(ring), 'context ring hit height').toBeLessThan(44)
      const stopHit = await hitSize(page.getByRole('button', { name: 'Cancel turn' }))
      expect(stopHit.height, 'stop hit height').toBeLessThan(44)

      await queueDraft(page, 'queued fine pointer note')
      const sendNow = await boxOf(page.getByRole('button', { name: /^Send now/ }))
      expect(sendNow.width).toBeCloseTo(40, 0)
      expect(sendNow.height).toBeCloseTo(40, 0)

      const jump = await boxOf(await scrollLogUp(page))
      expect(jump.width).toBeCloseTo(40, 0)
      expect(jump.height).toBeCloseTo(40, 0)
    })
  })
})

// ---------------------------------------------------------------------------
// L-25: the agent and model sheet
// ---------------------------------------------------------------------------

test.describe('agent and model sheet (L-25)', () => {
  async function openChatWithSelector(page: Page): Promise<{ pill: Locator; sheet: Locator }> {
    await bootShell(page, await registerProject({ fixture: true }), { waitForWarmup: true })
    await startChat(page, 'gaps selector [DURATION:2]')
    // Radix hides the pill from the accessibility tree while its sheet is open:
    // find it by test id, inside the chat composer (the launcher keeps its own).
    const pill = page
      .locator('[data-chat-composer="true"]')
      .getByTestId('agent-model-selector-trigger')
    await expect(pill).toBeVisible()
    return { pill, sheet: page.getByRole('dialog', { name: 'Model and agent' }) }
  }

  test('shows a close button, caps at 85dvh, keeps its grabber, and the search row clears the close box', async ({
    page
  }) => {
    const { pill, sheet } = await openChatWithSelector(page)

    await pill.tap()
    await expect(sheet).toBeVisible()
    await settled(sheet)

    // The built-in close is there, and it is the 44px touch target.
    const close = sheet.getByRole('button', { name: 'Close', exact: true })
    await expect(close).toBeVisible()
    const closeBox = await boxOf(close)
    expect(closeBox.width).toBeGreaterThanOrEqual(44)
    expect(closeBox.height).toBeGreaterThanOrEqual(44)

    // The cap every bottom sheet shares, scrolling inside it.
    await expect(sheet).toHaveCSS('max-height', `${844 * 0.85}px`)
    await expect(sheet).toHaveCSS('overflow-y', 'auto')
    await expect(sheet).toHaveCSS('overscroll-behavior-y', 'contain')

    // The decorative grabber stays: a short rounded bar, hidden from assistive technology.
    const grabber = sheet.locator('div[aria-hidden="true"].rounded-full').first()
    await expect(grabber).toBeVisible()
    const grabberBox = await boxOf(grabber)
    expect(grabberBox.width).toBeCloseTo(36, 0)
    expect(grabberBox.height).toBeCloseTo(4, 0)

    // The touch search row ends before the close box begins: neither the field
    // nor the result count sits under it.
    const search = sheet.getByRole('textbox', { name: 'Search models and agents' })
    await search.fill('zzz-no-such-model')
    const searchBox = await boxOf(search)
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(closeBox.x)
    const count = sheet.getByText('0', { exact: true })
    if ((await count.count()) > 0) {
      const countBox = await boxOf(count.first())
      expect(countBox.x + countBox.width).toBeLessThanOrEqual(closeBox.x)
    }
    await search.fill('')
  })

  test('the close button dismisses the sheet and returns focus to the pill', async ({ page }) => {
    const { pill, sheet } = await openChatWithSelector(page)

    await pill.tap()
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(sheet).toBeHidden()
    await expect(pill).toBeFocused()
    await expect(shellBody(page)).not.toHaveAttribute('inert')
  })

  test.describe('on a landscape phone', () => {
    test.use({ viewport: { width: 844, height: 390 } })

    test('stays inside the 85dvh cap, and its close still works and returns focus to the pill', async ({
      page
    }) => {
      const { pill, sheet } = await openChatWithSelector(page)

      await pill.tap()
      await expect(sheet).toBeVisible()
      await settled(sheet)

      // 85% of 390px: the sheet never outgrows the short window.
      await expect(sheet).toHaveCSS('max-height', `${390 * 0.85}px`)
      expect((await boxOf(sheet)).height).toBeLessThanOrEqual(390 * 0.85 + 1)

      // The close box stays inside the window, so a thumb can reach it.
      const close = sheet.getByRole('button', { name: 'Close', exact: true })
      const closeBox = await boxOf(close)
      expect(closeBox.y).toBeGreaterThanOrEqual(0)
      expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(390)
      await close.tap()
      await expect(sheet).toBeHidden()
      await expect(pill).toBeFocused()
    })
  })

  test.describe('in a landscape window too short for the panel', () => {
    test.use({ viewport: { width: 844, height: 260 } })

    test('scrolls inside the 85dvh cap instead of outgrowing the window', async ({ page }) => {
      const { pill, sheet } = await openChatWithSelector(page)

      await pill.tap()
      await expect(sheet).toBeVisible()
      await settled(sheet)

      await expect(sheet).toHaveCSS('max-height', `${260 * 0.85}px`)
      expect((await boxOf(sheet)).height).toBeLessThanOrEqual(260 * 0.85 + 1)
      // The panel is taller than the cap, so it scrolls inside the sheet...
      const metrics = await sheet.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      }))
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
      // ...down to its last row, without the page behind it moving.
      const scrollTop = await sheet.evaluate((el) => {
        el.scrollTop = el.scrollHeight
        return el.scrollTop
      })
      expect(scrollTop).toBeGreaterThan(0)
      expect(await page.evaluate(() => window.scrollY)).toBe(0)

      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
      await expect(pill).toBeFocused()
    })
  })
})

// ---------------------------------------------------------------------------
// L-26: a transparent outline for forced-colors mode
// ---------------------------------------------------------------------------

test.describe('forced colors focus indicator (L-26)', () => {
  interface Indicator {
    outlineStyle: string
    outlineWidth: string
    outlineOffset: string
    outlineColor: string
    boxShadow: string
  }

  function indicatorOf(locator: Locator): Promise<Indicator> {
    return locator.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset,
        outlineColor: style.outlineColor,
        boxShadow: style.boxShadow
      }
    })
  }

  /** Start a `[RICH]` chat and return its settled agent message and its subagent row. */
  async function openRichChat(page: Page): Promise<{ message: Locator; subagentRow: Locator }> {
    await bootShell(page, await registerProject({ fixture: true }), { waitForWarmup: true })
    await startChat(page, '[RICH] gaps outline')
    const message = page
      .getByRole('log')
      .locator('[data-slot="message"]')
      .filter({ hasText: 'Example docs' })
      .first()
    await expect(message).toHaveAttribute('tabindex', '0', { timeout: 60_000 })
    // Tool calls sit behind the turn's "Worked for" disclosure.
    await page.getByRole('button', { name: /^Worked for/ }).tap()
    const subagentRow = page.getByRole('button', { name: 'Review the overlay change' })
    await expect(subagentRow).toBeVisible()
    return { message, subagentRow }
  }

  test('a focused message and a focused tool row paint a transparent outline inside the row', async ({
    page
  }) => {
    const { message, subagentRow } = await openRichChat(page)

    for (const [name, target] of [
      ['message', message],
      ['subagent row', subagentRow]
    ] as const) {
      // Normal colours first: the ring (a box-shadow) is the indicator and no
      // outline is painted, exactly as before the change.
      await page.emulateMedia({ forcedColors: 'none' })
      await tabTo(page, target)
      const ring = await indicatorOf(target)
      expect(ring.outlineStyle, `${name} outline (normal colours)`).toBe('none')
      expect(ring.boxShadow, `${name} ring (normal colours)`).not.toBe('none')

      // Forced colours remove box-shadow; the transparent outline is what the
      // browser paints in its place, pulled inside the row so an
      // `overflow-hidden` ancestor cannot clip it.
      await page.emulateMedia({ forcedColors: 'active' })
      await tabTo(page, target)
      const forced = await indicatorOf(target)
      expect(forced.outlineStyle, `${name} outline (forced colours)`).toBe('solid')
      expect(forced.outlineWidth, `${name} outline width`).toBe('2px')
      expect(forced.outlineOffset, `${name} outline offset`).toBe('-2px')
      // The browser swaps the transparent colour for a system colour.
      expect(forced.outlineColor, `${name} outline colour`).not.toBe('rgba(0, 0, 0, 0)')
    }
  })

  test('a row that is not focused paints no outline in forced colours', async ({ page }) => {
    const { message, subagentRow } = await openRichChat(page)
    await page.emulateMedia({ forcedColors: 'active' })

    // `outline-hidden` alone would box every message at rest: the outline is
    // scoped to :focus-visible.
    for (const target of [message, subagentRow]) {
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      })
      const rest = await indicatorOf(target)
      expect(rest.outlineStyle).toBe('none')
    }
  })
})
