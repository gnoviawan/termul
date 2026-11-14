import { expect, type Locator, type Page, test } from 'playwright/test'
import { E2E_TOKEN } from './helpers'
import { chatTab, openWorkspace, selectProject } from './ui'

/**
 * Shell-revamp journeys E2E on termul-server (story 30, CAP-18 / AD-15 / E6).
 *
 * These two specs walk Journey 1 and Journey 2 of EXPERIENCE.md
 * (ux-termul-2026-10-10) on the only desktop shell: Rail | main | Side panel |
 * tool strip (Sidebar V2).
 * The suite passing is also the proof that the classic shell is gone (no
 * "Global actions" navigation).
 *
 * Fixtures: `proj-w` (`e2e-proj-w`) is a git repo whose `global-setup` leaves
 * two uncommitted files behind (`notes.txt` modified, `scratch.txt` untracked:
 * `+4 -1`, 2 changed files). The fake long-run agent (fake-longrun-agent.ts)
 * answers every chat; its turns run for minutes, so a chat card reads
 * "Running" for the whole spec.
 *
 * Steps that need a real LLM, a real connection failure or a model list are
 * recorded with `skipStep` (a `SKIPPED:` test step plus an annotation that
 * carries the one-line reason) instead of asserting something the fake agent
 * cannot provide.
 */

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const PROJECT = 'proj-w'
const PROJECT_ID = 'e2e-proj-w'
const RAIL_TOGGLE = 'Expand or collapse projects'

const CHAT_ONE = 'sierra chat one'
const CHAT_TWO = 'sierra chat two'
const CHAT_THREE = 'sierra chat three'
const CHAT_WORKTREE = 'tango worktree fix'
const CHAT_CHECKOUT = 'victor checkout fix'

/** Records a journey step the fake agent / environment cannot exercise. */
async function skipStep(title: string, reason: string): Promise<void> {
  test.info().annotations.push({ type: 'skipped-step', description: `${title}: ${reason}` })
  await test.step(`SKIPPED: ${title} (${reason})`, async () => {})
}

/** Comparable form of a filesystem path (separators, trailing slash, case). */
function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Collects the `cwd` of every terminal `spawn` the page sends over
 * `/terminal/ws` (the server then starts the PTY in that folder). Must be
 * installed before the page first connects.
 */
function trackTerminalSpawns(page: Page): { cwds: () => string[] } {
  const cwds: string[] = []
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/terminal/ws')) return
    socket.on('framesent', (frame) => {
      try {
        const message = JSON.parse(String(frame.payload)) as {
          type?: string
          payload?: { cwd?: string }
        }
        if (message.type === 'spawn' && typeof message.payload?.cwd === 'string') {
          cwds.push(message.payload.cwd)
        }
      } catch {
        // not a JSON frame
      }
    })
  })
  return { cwds: () => [...cwds] }
}

interface ListedWorktree {
  branch: string
  path: string
}

/** The project's git worktrees, straight from the server (durable proof). */
async function listWorktrees(page: Page): Promise<ListedWorktree[]> {
  const res = await page.request.post('/worktree/list', {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
    data: { projectPath: `${process.env.E2E_WORKSPACE_ROOT}/${PROJECT}` }
  })
  expect(res.ok()).toBe(true)
  const body = await res.json()
  expect(body.success).toBe(true)
  return (body.data ?? []) as ListedWorktree[]
}

const railNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Projects' })
const paneContents = (page: Page): Locator => page.locator('[data-pane-content]')
const chatCard = (page: Page, title: string): Locator =>
  page.locator(`button[data-chat-card-index][aria-label^="${title}"]`)
const toolStrip = (page: Page): Locator => page.getByRole('toolbar', { name: 'Tools' })
/** The active project's chats in the Rail. */
const railChats = (page: Page): Locator =>
  railNav(page).getByRole('list', { name: `Chats in ${PROJECT}` })

/** A Rail chat row by title (its name may end with a status word). */
const railChat = (page: Page, title: string): Locator =>
  railChats(page).getByRole('button', { name: new RegExp(`^${title}`) })

/** Opens the worktree switcher from the project row menu (Sidebar V2 P4). */
async function openWorktreeSwitcher(page: Page): Promise<Locator> {
  await railNav(page)
    .getByRole('button', { name: new RegExp(`^Project: ${PROJECT}`) })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Switch worktree/ }).click()
  const list = page.getByRole('listbox', { name: 'Working copies' })
  await expect(list).toBeVisible()
  return list
}

const stripButton = (page: Page, name: string): Locator =>
  toolStrip(page).getByRole('button', { name, exact: true })

/**
 * Expands or collapses the Rail. Expanded, the toggle follows the mark in the
 * Rail header; collapsed, it opens the tab bar next to the Rail (right of the
 * macOS traffic lights). Exactly one shows.
 */
async function clickRailToggle(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: RAIL_TOGGLE })
  await expect(toggle).toHaveCount(1)
  await expect(toggle).toBeInViewport({ ratio: 1 })
  await toggle.click()
}

/** Boot the shell and wait for the Rail + the registered projects. */
async function openRevampWorkspace(page: Page): Promise<void> {
  await openWorkspace(page)
  await expect(railNav(page)).toBeVisible()
  // The Rail state is persisted: a collapsed Rail would hide the project rows.
  if ((await railNav(page).getAttribute('data-expanded')) === 'false') {
    await clickRailToggle(page)
  }
  await expect(railNav(page)).toHaveAttribute('data-expanded', 'true')
  await page.locator('[aria-label^="Project: proj-"]').first().waitFor({ state: 'visible' })
  // The classic activity rail is gone.
  await expect(page.getByRole('navigation', { name: 'Global actions' })).toHaveCount(0)
}

/**
 * Start a NEW chat from the Rail's New chat row (the launcher opens
 * over the active pane). `workspace` drives the launcher's Workspace chip.
 * Resolves once the chat tab exists.
 */
async function launchRevampChat(
  page: Page,
  prompt: string,
  workspace?: 'Current checkout' | 'New worktree'
): Promise<void> {
  const composer = page.locator('[data-composer-editor="true"][aria-label="Agent prompt"]').first()
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    try {
      await composer.waitFor({ state: 'visible', timeout: 5_000 })
      break
    } catch {
      if (attempt === 2) throw new Error('Agent launcher composer never appeared')
    }
  }
  if (workspace) {
    // The chip is interactive once the git probe marks the project as git.
    const chip = page.getByRole('combobox', { name: 'Workspace' })
    await expect(chip).toBeVisible({ timeout: 15_000 })
    await chip.click()
    await page.getByRole('option', { name: workspace }).click()
    await expect(chip).toContainText(workspace)
  }
  await composer.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  const tab = chatTab(page, prompt)
  try {
    await tab.waitFor({ state: 'visible', timeout: 8_000 })
  } catch {
    // Enter can be swallowed while the launcher is still settling; the
    // Send button is the deterministic path.
    await page.getByRole('button', { name: 'Start agent chat' }).click()
    await tab.waitFor({ state: 'visible' })
  }
  // Let the session settle (its card lands in Chats, the launcher closes)
  // before the next launch: a New chat click while the previous session is
  // still being created is swallowed.
  await expect(chatCard(page, prompt)).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Agent launcher' })).toHaveCount(0)
}

/**
 * Drag a Chats-list card onto one edge of a pane with the real mouse: the
 * pane's drop-zone overlay only exists while a drag is in flight, so the
 * zone is located after the drag has started.
 */
async function dragCardToPaneEdge(
  page: Page,
  card: Locator,
  pane: Locator,
  edge: 'right' | 'bottom'
): Promise<void> {
  const zoneSelector =
    edge === 'right'
      ? 'div[class*="right-0"][class*="w-1/4"]'
      : 'div[class*="bottom-0"][class*="h-1/4"]'
  const cardBox = await card.boundingBox()
  if (!cardBox) throw new Error('chat card has no bounding box')
  const startX = cardBox.x + cardBox.width / 2
  const startY = cardBox.y + cardBox.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 12, startY + 4, { steps: 4 })
  const zone = pane.locator(zoneSelector).first()
  await zone.waitFor({ state: 'attached' })
  const paneBox = await pane.boundingBox()
  if (!paneBox) throw new Error('pane has no bounding box')
  // Cross the pane first so the overlay sees a regular drag-over path.
  await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2, {
    steps: 10
  })
  const zoneBox = await zone.boundingBox()
  if (!zoneBox) throw new Error('drop zone has no bounding box')
  await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2, {
    steps: 8
  })
  await page.mouse.up()
}

/** Per-page terminal spawn trackers, installed in `beforeEach`. */
const trackTerminals = new WeakMap<Page, { cwds: () => string[] }>()

test.beforeEach(async ({ page }) => {
  // Installed before the first navigation so no terminal socket is missed.
  trackTerminals.set(page, trackTerminalSpawns(page))
  await openRevampWorkspace(page)
})

test('Journey 1: three chats on one project, side by side, next to the diff', async ({ page }) => {
  await test.step('1. Rail: select the project, its Diff stat shows the uncommitted lines', async () => {
    await selectProject(page, PROJECT)
    const row = page.getByTestId(`project-item-${PROJECT_ID}`)
    // The stat swaps for the settings gear while the row is hovered or has
    // focus (the click just focused it), so move away and blur first.
    await page.mouse.move(700, 450)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const stat = row.getByTestId('project-diff-stat')
    await expect(stat).toBeVisible()
    await expect(stat).toContainText('+4')
    await expect(stat).toContainText('−1')
    // Sidebar V2: the main screen opens without the Side panel; the strip's
    // Changes button carries the changed-file count.
    await expect(page.getByTestId('right-panel')).toHaveCount(0)
    await expect(page.getByTestId('tool-strip-changes-badge')).toHaveText('2')
  })

  await test.step('2. Chats list: one card per chat with its agent, status, title and branch', async () => {
    await launchRevampChat(page, CHAT_ONE)
    await launchRevampChat(page, CHAT_TWO)
    await launchRevampChat(page, CHAT_THREE)
    for (const title of [CHAT_ONE, CHAT_TWO, CHAT_THREE]) {
      const card = chatCard(page, title)
      await expect(card).toBeVisible()
      await expect(card).toContainText(title)
      await expect(card).toContainText('Fake Longrun')
      // The project folder's current branch is the card's branch line.
      await expect(card).toContainText('main')
      // Same signal as the tab: a running turn reads "Running".
      await expect(card).toHaveAttribute('aria-label', /Running/)
    }
  })

  await test.step('3. Dragging a card onto a pane edge splits the pane', async () => {
    await expect(paneContents(page)).toHaveCount(1)
    await dragCardToPaneEdge(page, chatCard(page, CHAT_TWO), paneContents(page).first(), 'right')
    await expect(paneContents(page)).toHaveCount(2)

    await dragCardToPaneEdge(page, chatCard(page, CHAT_THREE), paneContents(page).last(), 'bottom')
    await expect(paneContents(page)).toHaveCount(3)

    // Every chat keeps its own tab, in its own pane, and keeps running.
    for (const title of [CHAT_ONE, CHAT_TWO, CHAT_THREE]) {
      await expect(chatTab(page, title)).toBeVisible()
    }
  })

  await skipStep(
    '3b. one pane hits a connection error and keeps its Retry notice',
    'a real agent connection failure cannot be produced with the fake agent'
  )
  await skipStep(
    '3c. cards show the agent AND the model',
    'the fake agent advertises no model list; only the agent name is asserted in step 2'
  )

  await test.step('4. Changes: the changed files and the docked Graph', async () => {
    await stripButton(page, 'Changes').click()
    await expect(stripButton(page, 'Changes')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('right-panel')).toBeVisible()
    await expect(page.getByTestId('tool-strip-changes-badge')).toHaveText('2')

    const graph = page.getByRole('region', { name: 'Git graph' })
    await expect(graph).toBeVisible()
    await expect(graph).toContainText('Git History')

    const notes = page.getByRole('option').filter({ hasText: 'notes.txt' })
    await expect(notes).toBeVisible()
    await expect(page.getByRole('option').filter({ hasText: 'scratch.txt' })).toBeVisible()

    // A plain file click opens the Diff tab (the diff itself stays out of the panel).
    await notes.click()
    await expect(
      page.locator('[role="tab"]').filter({ has: page.locator('span[title^="notes.txt ("]') })
    ).toBeVisible()
  })

  await skipStep(
    '5. send a prompt with screenshots attached from the launcher',
    'a screenshot turn needs a real vision-capable model; the fake agent only streams text'
  )

  await test.step('6. Collapse the Rail to its 1:1 icons, switch projects, peek and expand', async () => {
    try {
      await clickRailToggle(page)
      await expect(railNav(page)).toHaveAttribute('data-expanded', 'false')
      // Sidebar V2: the collapsed Rail is the expanded one without labels.
      await expect(railNav(page).getByRole('button', { name: 'Search' })).toBeVisible()
      await expect(railNav(page).getByText(PROJECT, { exact: true })).toHaveCount(0)
      // The old icon stack, project switcher and Column tab track are gone.
      await expect(page.getByTestId('rail-column-tab-track')).toHaveCount(0)
      await expect(railNav(page).getByRole('button', { name: /^Switch project/ })).toHaveCount(0)

      // Hovering a project icon opens its card next to the Rail.
      const projB = railNav(page).getByRole('button', { name: 'Project: proj-b' })
      await projB.hover()
      await expect(page.getByTestId('rail-project-card')).toContainText('proj-b')

      // A click on the icon switches project.
      await projB.click()
      await expect(
        railNav(page).getByRole('button', { name: 'Project: proj-b (active)' })
      ).toBeVisible()

      // #903: the main area shows exactly the selected project's own tabs.
      await expect(chatTab(page, CHAT_ONE)).toHaveCount(0)
      await expect(chatTab(page, CHAT_TWO)).toHaveCount(0)

      // Back on termul's project: its three chat panes are restored.
      await railNav(page)
        .getByRole('button', { name: `Project: ${PROJECT}` })
        .click()
      await expect(
        railNav(page).getByRole('button', { name: `Project: ${PROJECT} (active)` })
      ).toBeVisible()
      for (const title of [CHAT_ONE, CHAT_TWO, CHAT_THREE]) {
        await expect(chatTab(page, title)).toBeVisible()
      }
      await expect(paneContents(page)).toHaveCount(3)

      // Hovering a chat icon opens the chat peek; a click there opens the chat.
      const chatIcon = railNav(page).getByRole('button', { name: new RegExp(`^${CHAT_TWO}`) })
      await chatIcon.hover()
      const peek = page.getByTestId('rail-chat-peek')
      await expect(peek).toContainText(PROJECT)
      await expect(peek).toContainText(CHAT_ONE)
      await peek.getByRole('button', { name: new RegExp(`^${CHAT_ONE}`) }).click()
      await expect(peek).toHaveCount(0)

      // Expand again from the top row toggle (not in the Rail any more).
      await expect(railNav(page).getByRole('button', { name: RAIL_TOGGLE })).toHaveCount(0)
      await clickRailToggle(page)
      await expect(railNav(page)).toHaveAttribute('data-expanded', 'true')
    } finally {
      // The Rail state is a persisted setting shared with later specs.
      if ((await railNav(page).getAttribute('data-expanded')) === 'false') {
        await clickRailToggle(page)
        await expect(railNav(page)).toHaveAttribute('data-expanded', 'true')
        // Let the debounced persistence write flush before the page closes.
        await page.waitForTimeout(1_500)
      }
    }
  })
})

test('Journey 2: two fixes at once, one in a new worktree', async ({ page }) => {
  const spawns = trackTerminals.get(page)
  if (!spawns) throw new Error('terminal spawn tracker missing')
  await selectProject(page, PROJECT)

  const before = new Set((await listWorktrees(page)).map((w) => w.path))
  let worktree: ListedWorktree | undefined

  await test.step('1. Launcher Workspace chip: New worktree, then send', async () => {
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    const composer = page
      .locator('[data-composer-editor="true"][aria-label="Agent prompt"]')
      .first()
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    const chip = page.getByRole('combobox', { name: 'Workspace' })
    await expect(chip).toBeVisible({ timeout: 15_000 })
    await chip.click()
    await page.getByRole('option', { name: 'New worktree' }).click()
    await expect(page.getByRole('combobox', { name: 'Base branch' })).toContainText(/\S/)
    await composer.click()
    await page.keyboard.type(CHAT_WORKTREE)
    await page.keyboard.press('Enter')

    // The worktree is created on the first send, before the chat starts.
    await expect(page.getByText(/Creating worktree|Worktree created/).first()).toBeVisible({
      timeout: 30_000
    })
    await expect(chatTab(page, CHAT_WORKTREE)).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(async () => page.locator('body').innerText(), { timeout: 30_000 })
      .toContain('chunk-1 ')

    // Durable proof: git now lists a new chat/ worktree.
    await expect
      .poll(
        async () => {
          worktree = (await listWorktrees(page)).find(
            (w) => !before.has(w.path) && w.branch.startsWith('chat/')
          )
          return worktree?.branch ?? null
        },
        { timeout: 30_000 }
      )
      .not.toBeNull()
  })

  if (!worktree) throw new Error('worktree was not created')
  const created: ListedWorktree = worktree

  await test.step('2. The chat lands in Chats, on the worktree branch, in the worktree folder', async () => {
    const card = chatCard(page, CHAT_WORKTREE)
    await expect(card).toBeVisible()
    await expect(card).toContainText(created.branch)
    await expect(card).toHaveAttribute('aria-label', /Running/)
    // The card's terminal action names the chat's working directory.
    const terminal = page.getByRole('button', {
      name: `Open terminal for chat ${CHAT_WORKTREE}`
    })
    await expect
      .poll(async () => norm((await terminal.getAttribute('title')) ?? ''))
      .toContain(norm(created.path))
  })

  await test.step('3. A second chat on the current checkout', async () => {
    await launchRevampChat(page, CHAT_CHECKOUT, 'Current checkout')
    const card = chatCard(page, CHAT_CHECKOUT)
    await expect(card).toBeVisible()
    await expect(card).toContainText('main')
    await expect(card).not.toContainText(created.branch)
  })

  await test.step('4. The project row menu switches to the worktree; the Rail chats narrow and the chip shows it', async () => {
    const list = await openWorktreeSwitcher(page)
    const worktreeRow = list.getByRole('option', { name: new RegExp(created.branch) })
    await expect(worktreeRow).toBeVisible()
    // The worktree's only open tab is its chat.
    await expect(worktreeRow.locator('[title^="1 open tab"]')).toBeVisible()
    // The project folder is listed too (first row).
    await expect(list.getByRole('option').first()).not.toContainText(created.branch)

    await worktreeRow.click()
    await expect(list).toHaveCount(0)

    await expect(railChat(page, CHAT_WORKTREE)).toBeVisible()
    await expect(railChat(page, CHAT_CHECKOUT)).toHaveCount(0)
    await expect(railChat(page, CHAT_ONE)).toHaveCount(0)
    await expect(page.getByTestId(`rail-worktree-chip-${PROJECT_ID}`)).toContainText(created.branch)
  })

  await test.step('5. The tool strip Terminal opens a new terminal tab in the worktree folder', async () => {
    await chatTab(page, CHAT_WORKTREE).click()
    for (let click = 1; click <= 2; click += 1) {
      const spawnedBefore = spawns.cwds().length
      await stripButton(page, 'New terminal').click()
      // A new tab on every click, at the active tab's working copy.
      await expect.poll(() => spawns.cwds().length).toBeGreaterThan(spawnedBefore)
      expect(norm(spawns.cwds().at(-1) ?? '')).toBe(norm(created.path))
      await chatTab(page, CHAT_WORKTREE).click()
    }
  })

  await test.step('6. The switcher row terminal action opens a terminal whose cwd is the worktree folder', async () => {
    const spawnedBefore = spawns.cwds().length
    const list = await openWorktreeSwitcher(page)
    // The action sits beside its option and shows on hover.
    await list.getByRole('option', { name: new RegExp(created.branch) }).hover()
    // Keyboard activation: the popover closes in the click handler, which makes
    // a pointer click's post-action checks see a detached element and retry.
    const rowAction = page.getByRole('button', { name: `Open terminal in ${created.branch}` })
    await rowAction.focus()
    await page.keyboard.press('Enter')

    await expect(page.getByText('Terminal opened').first()).toBeVisible()
    await expect.poll(() => spawns.cwds().length).toBeGreaterThan(spawnedBefore)
    expect(norm(spawns.cwds().at(-1) ?? '')).toBe(norm(created.path))
  })

  await skipStep(
    '2b. the worktree branch is renamed to the suggested name (chat/fix-903)',
    'the suggested name comes from a real model turn; the fake agent suggests nothing'
  )

  await test.step('cleanup: back to the project folder so the Rail shows every chat again', async () => {
    const list = await openWorktreeSwitcher(page)
    await list.getByRole('option').first().click()
    await expect(railChat(page, CHAT_CHECKOUT)).toBeVisible()
    await expect(railChat(page, CHAT_WORKTREE)).toBeVisible()
    await expect(page.getByTestId(`rail-worktree-chip-${PROJECT_ID}`)).toHaveCount(0)
  })
})
