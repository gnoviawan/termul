import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'
import { launchChat } from './ui'

/**
 * Mobile shell accessibility floor E2E (spec-mobile-a11y-floor): a phone-sized
 * browser drives the web client's mobile shell and checks what jsdom cannot —
 * the real `hideOthers` behaviour behind an open sheet, the real store-to-region
 * chain (transport events in, region text out), computed `animation-name` under
 * `prefers-reduced-motion`, measured 44px hit boxes under a coarse pointer, and
 * where `document.activeElement` lands when a sheet closes.
 *
 * Every test registers its own project(s) (fresh workspace, no state shared
 * with other suites). Project names start with `proj-floor-` on purpose: other
 * suites select `proj-a`..`proj-x` by name PREFIX.
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

interface FloorProject {
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
  options: { files?: boolean; git?: boolean } = {}
): Promise<FloorProject> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-floor-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  if (options.files) {
    await writeFile(join(path, 'notes.md'), '# notes\n')
    await writeFile(join(path, 'todo.txt'), 'todo\n')
  }
  // A real repo keeps the Git sheet free of "not a git repository" noise.
  if (options.git) execSync('git init -q -b main', { cwd: path })
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
 * warm-up — no session will follow it.
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
 * Make `project` the web client's active project and load the app on it.
 * `waitForWarmup` also waits for the agent warm-up (see `watchAgentWarmup`).
 */
async function openApp(
  page: Page,
  project: FloorProject,
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
}

/**
 * Boot the mobile shell on `project`. `waitForWarmup` is for tests that launch
 * a chat from the empty pane.
 */
async function bootShell(
  page: Page,
  project: FloorProject,
  options: { waitForWarmup?: boolean } = {}
): Promise<void> {
  await openApp(page, project, options)
  // The header names the active project until a chat takes over: seeing it
  // proves the shell booted into our fresh project.
  await expect(
    page.getByRole('heading', { level: 1, name: project.name, exact: true })
  ).toBeVisible()
  // The boot connection is healthy: the summary pill reads "Connected".
  await expect(page.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
}

function liveRegion(page: Page): Locator {
  return page.locator('[data-shell-live-region]')
}

/**
 * Record every non-empty text the live region ever shows (a repeat is recorded
 * again: the region is cleared between messages). `toHaveText` only sees the
 * current message, and a newer one replaces the older.
 */
async function trackAnnouncements(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const region = document.querySelector('[data-shell-live-region]')
    if (!region) throw new Error('no live region to track')
    const store = window as unknown as { __floorAnnounced: string[] }
    store.__floorAnnounced = []
    new MutationObserver(() => {
      const text = region.textContent ?? ''
      if (text) store.__floorAnnounced.push(text)
    }).observe(region, { childList: true, characterData: true, subtree: true })
  })
  return () =>
    page.evaluate(() => (window as unknown as { __floorAnnounced: string[] }).__floorAnnounced)
}

/**
 * A causal barrier for "nothing else was announced": make an announcement that
 * is known to land after every earlier one (the drawer search count for a query
 * that matches no chat), then close the drawer. Whatever the transition under
 * test also announced is in the history by then, so the history can be compared
 * whole. Waiting a fixed time instead would only be a guess.
 */
async function announceBarrier(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  await page.getByRole('textbox', { name: 'Search chats' }).fill('zzz-no-such-chat')
  await expect(liveRegion(page)).toHaveText('0 chats match')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Chats' })).toBeHidden()
}

/**
 * Start a chat from the mobile shell: the empty pane shows the launcher
 * composer directly, an open chat needs the header "New chat" first. Resolves
 * once the header names the new chat (the title is the prompt text).
 */
async function startChat(page: Page, prompt: string, options: { viaNewChat?: boolean } = {}) {
  if (options.viaNewChat) await page.getByRole('button', { name: 'New chat' }).tap()
  const composer = page.getByRole('textbox', { name: 'Agent prompt' })
  await composer.click()
  await page.keyboard.type(prompt)
  await page.getByRole('button', { name: 'Start agent chat' }).tap()
  await expect(page.getByRole('heading', { level: 1, name: prompt, exact: true })).toBeVisible()
}

/** Wait for every running CSS animation under `locator` (a slide or zoom in) to finish. */
async function settled(locator: Locator): Promise<void> {
  await locator.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished))
  )
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
 * Open the centred "Create New Branch" Dialog on the mobile shell: Git changes,
 * the branch menu, then "Create new branch...". It is the Dialog (with the
 * built-in Close) a phone can reach. The launcher's agent selector used to be a
 * Dialog, but the combined agent / model / effort selector opens a bottom sheet
 * on the mobile shell. The project needs a git repository (`registerProject({ git: true })`).
 */
async function openCreateBranchDialog(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Git changes' }).tap()
  const gitSheet = page.getByRole('dialog', { name: 'Git changes' })
  await expect(gitSheet).toBeVisible()
  // The branch picker: a repo with no commit yet reads "Detached HEAD".
  await gitSheet.getByRole('button', { name: /^(main|Detached HEAD)$/ }).tap()
  await page.getByRole('menuitem', { name: 'Create new branch...' }).tap()
  const dialog = page.getByRole('dialog', { name: 'Create New Branch' })
  await expect(dialog).toBeVisible()
  return dialog
}

// ---------------------------------------------------------------------------
// The shell live region
// ---------------------------------------------------------------------------

test.describe('shell live region', () => {
  test('is one persistent, empty, polite status region that stays exposed behind an open drawer', async ({
    page
  }) => {
    await bootShell(page, await registerProject())
    const announced = await trackAnnouncements(page)
    const region = liveRegion(page)

    await expect(region).toHaveCount(1)
    await expect(region).toHaveAttribute('role', 'status')
    await expect(region).toHaveAttribute('aria-live', 'polite')
    await expect(region).toHaveAttribute('aria-atomic', 'true')
    await expect(region).toHaveClass(/\bsr-only\b/)
    // Never mounted holding text, and the boot connect (connecting -> connected)
    // is a silent baseline.
    await expect(region).toHaveText('')
    const hidden = await boxOf(region)
    expect(hidden.width).toBeLessThanOrEqual(1)
    expect(hidden.height).toBeLessThanOrEqual(1)

    await region.evaluate((el) => el.setAttribute('data-e2e-node', 'first-mount'))

    await page.getByRole('button', { name: 'Open menu' }).tap()
    await expect(page.getByRole('dialog', { name: 'Chats' })).toBeVisible()
    // The modal drawer hid everything outside it from assistive technology
    // (Radix hideOthers)...
    await expect(page.getByRole('banner')).toHaveCount(0)
    // ...but not the region: it carries an explicit aria-live, which
    // hideOthers keeps. An announcement made now (the drawer search count) is
    // therefore still exposed.
    expect(await region.evaluate((el) => el.closest('[aria-hidden="true"]') === null)).toBe(true)
    const search = page.getByRole('textbox', { name: 'Search chats' })
    await search.fill('zzz-no-such-chat')
    await expect(region).toHaveText('0 chats match')
    // The same text again is cleared and set again, so a screen reader reads
    // it again: the region's DOM shows it twice.
    await search.fill('yyy-no-such-chat')
    await expect.poll(announced).toEqual(['0 chats match', '0 chats match'])

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Chats' })).toBeHidden()
    // The same node, never remounted.
    await expect(liveRegion(page)).toHaveCount(1)
    await expect(region).toHaveAttribute('data-e2e-node', 'first-mount')
    await expect(region).toHaveText('0 chats match')
  })

  test('the chat log stays silent while the shell announces the end of the turn once', async ({
    page
  }) => {
    await bootShell(page, await registerProject(), { waitForWarmup: true })
    const announced = await trackAnnouncements(page)

    await startChat(page, 'floor turn [DURATION:4]')

    // role="log" implies polite: the mobile timeline must say "off" outright,
    // or every streamed chunk and every scroll would be read out again.
    const log = page.getByRole('log')
    await expect(log).toHaveAttribute('aria-live', 'off')
    expect(await log.getAttribute('aria-relevant')).toBeNull()

    await expect(liveRegion(page)).toHaveText('Turn finished')
    // Streaming, the new chat becoming active and the turn ending produced one
    // announcement, not one per chunk.
    await announceBarrier(page)
    expect(await announced()).toEqual(['Turn finished', '0 chats match'])
  })

  test('announces Approval needed for the active chat, and not a second "needs you"', async ({
    page
  }) => {
    await bootShell(page, await registerProject(), { waitForWarmup: true })
    const announced = await trackAnnouncements(page)

    await startChat(page, 'floor approval [PERMISSION] [DURATION:12]')

    await expect(liveRegion(page)).toHaveText('Approval needed')
    // The active chat needs you too, but that is not announced a second time.
    await announceBarrier(page)
    expect(await announced()).toEqual(['Approval needed', '0 chats match'])
  })

  test('names another chat that starts needing you, and stays silent when the active chat switches', async ({
    page
  }) => {
    await bootShell(page, await registerProject(), { waitForWarmup: true })
    const announced = await trackAnnouncements(page)

    // The first chat asks for approval 15s after its prompt is accepted: by
    // then the second chat is the active one.
    const background = 'floor background [PERMISSION:15] [DURATION:40]'
    await startChat(page, background)
    await startChat(page, 'floor foreground [DURATION:40]', { viaNewChat: true })
    // Switching the active chat from a running chat to another is silent.
    await announceBarrier(page)
    expect(await announced()).toEqual(['0 chats match'])

    await expect(liveRegion(page)).toHaveText(`${background} needs you`, { timeout: 30_000 })
    expect(await announced()).toEqual(['0 chats match', `${background} needs you`])
  })

  test('announces the settled search count in the drawer, with the singular form for one chat', async ({
    page
  }) => {
    await bootShell(page, await registerProject(), { waitForWarmup: true })
    await startChat(page, 'floor alpha [DURATION:2]')
    await startChat(page, 'floor beta [DURATION:2]', { viaNewChat: true })
    // The active chat's turn end replaces whatever the region says, so let it
    // land before the search starts.
    const region = liveRegion(page)
    await expect(region).toHaveText('Turn finished')

    await page.getByRole('button', { name: 'Open menu' }).tap()
    const search = page.getByRole('textbox', { name: 'Search chats' })

    await search.fill('floor')
    await expect(region).toHaveText('2 chats match')
    await search.fill('alpha')
    await expect(region).toHaveText('1 chat matches')
    await search.fill('zzz-no-such-chat')
    await expect(region).toHaveText('0 chats match')
  })

  test('announces a project switch as it starts', async ({ page }) => {
    const current = await registerProject()
    const target = await registerProject()
    await bootShell(page, current)

    await page.getByRole('button', { name: 'Switch project' }).tap()
    await page
      .getByRole('dialog', { name: 'Projects' })
      .getByRole('button', { name: target.name, exact: true })
      .tap()

    await expect(liveRegion(page)).toHaveText(`Switching to ${target.name}…`)
  })

  test('announces a refused project switch', async ({ page }) => {
    const current = await registerProject()
    const target = await registerProject()
    // The server refuses switch_project for the target, with the protocol's
    // own failure frame (a real refusal needs a dead agent, which no agent
    // dies on cue across platforms). Every other frame passes through.
    await page.routeWebSocket(/:\d+\/ws$/, (client) => {
      const server = client.connectToServer()
      client.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          id?: string
          type?: string
          payload?: { projectId?: string }
        }
        if (frame.type === 'switch_project' && frame.payload?.projectId === target.id) {
          client.send(
            JSON.stringify({
              id: frame.id,
              ok: false,
              err: { code: 'e2e_refused', message: 'switch refused (e2e)' }
            })
          )
          return
        }
        server.send(message)
      })
      server.onMessage((message) => client.send(message))
    })
    await bootShell(page, current)

    await page.getByRole('button', { name: 'Switch project' }).tap()
    await page
      .getByRole('dialog', { name: 'Projects' })
      .getByRole('button', { name: target.name, exact: true })
      .tap()

    await expect(liveRegion(page)).toHaveText(`Couldn't switch to ${target.name}`)
  })

  test('announces the control channel dropping and recovering, in that order', async ({ page }) => {
    // The page-side `/ws` socket is ours to drop and to refuse: while `down`,
    // every reconnect attempt is closed on arrival, so the loss holds until we
    // say it ends. Everything else passes through to the real server.
    let down = false
    const live: Array<{ close: () => Promise<void> }> = []
    await page.routeWebSocket(/:\d+\/ws$/, (client) => {
      if (down) {
        void client.close()
        return
      }
      const server = client.connectToServer()
      client.onMessage((message) => server.send(message))
      server.onMessage((message) => client.send(message))
      live.push({
        close: async () => {
          await client.close()
          await server.close()
        }
      })
    })
    await bootShell(page, await registerProject())
    const announced = await trackAnnouncements(page)
    const region = liveRegion(page)
    await expect(region).toHaveText('')

    down = true
    for (const socket of live) await socket.close()
    await expect(region).toHaveText('Reconnecting…')

    down = false
    await expect(region).toHaveText('Connected', { timeout: 30_000 })
    expect(await announced()).toEqual(['Reconnecting…', 'Connected'])
  })

  test('announces the terminal channel dropping, giving up and recovering', async ({ page }) => {
    // The terminal client retries 10 times with a doubling backoff capped at
    // 8s before it declares the channel down, so the give-up takes about a
    // minute of real time.
    test.setTimeout(180_000)
    // Same device as the control-channel test, on `/terminal/ws`.
    let down = false
    const live: Array<{ close: () => Promise<void> }> = []
    await page.routeWebSocket(/\/terminal\/ws$/, (client) => {
      if (down) {
        void client.close()
        return
      }
      const server = client.connectToServer()
      client.onMessage((message) => server.send(message))
      server.onMessage((message) => client.send(message))
      live.push({
        close: async () => {
          await client.close()
          await server.close()
        }
      })
    })
    await bootShell(page, await registerProject(), { waitForWarmup: true })
    const announced = await trackAnnouncements(page)
    const region = liveRegion(page)

    await page.getByRole('button', { name: 'Open menu' }).tap()
    await page.getByRole('button', { name: 'New terminal' }).tap()
    const input = page.getByRole('textbox', { name: 'Terminal input' })
    await expect(input).toBeVisible()
    // The lazy first terminal connect (connected -> connecting -> connected) is silent.
    await announceBarrier(page)
    expect(await announced()).toEqual(['0 chats match'])

    down = true
    for (const socket of live) await socket.close()
    await expect(region).toHaveText('Reconnecting…')
    await expect(region).toHaveText('Disconnected', { timeout: 120_000 })

    // A key press re-arms the exhausted retry loop (the channel is
    // `reconnecting` again, then `connected`), and the retry now succeeds.
    down = false
    await input.focus()
    await page.keyboard.type('x')
    await expect(region).toHaveText('Connected', { timeout: 30_000 })
    expect(await announced()).toEqual([
      '0 chats match',
      'Reconnecting…',
      'Disconnected',
      'Reconnecting…',
      'Connected'
    ])
  })
})

// ---------------------------------------------------------------------------
// Focus returns to where the person was when a sheet closes
// ---------------------------------------------------------------------------

test.describe('sheet focus return', () => {
  test('closing the Files sheet by Escape, its close button or the back button returns focus to Browse files', async ({
    page
  }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)
    const opener = page.getByRole('button', { name: 'Browse files' })
    const filesSheet = page.getByRole('dialog', { name: project.name })

    await opener.tap()
    await expect(filesSheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(filesSheet).toBeHidden()
    await expect(opener).toBeFocused()

    await opener.tap()
    await expect(filesSheet).toBeVisible()
    await filesSheet.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(filesSheet).toBeHidden()
    await expect(opener).toBeFocused()

    // The hardware back button closes the topmost overlay.
    await opener.tap()
    await expect(filesSheet).toBeVisible()
    await page.goBack()
    await expect(filesSheet).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test('opening a file lands focus on the header title, not on Browse files or the editor', async ({
    page
  }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)

    await page.getByRole('button', { name: 'Browse files' }).tap()
    await page.getByRole('button', { name: 'Open notes.md' }).tap()
    await expect(page.getByRole('dialog', { name: project.name })).toBeHidden()

    await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toBeFocused()
  })

  test('the file actions sheet returns focus to its row button, and Rename lands on the input', async ({
    page
  }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)
    await page.getByRole('button', { name: 'Browse files' }).tap()
    const actions = page.getByRole('button', { name: 'Actions for notes.md' })
    // Radix names the dialog by its title (the file name), ahead of the aria-label.
    const actionsSheet = page.getByRole('dialog', { name: 'notes.md', exact: true })

    // Escape.
    await actions.tap()
    await expect(actionsSheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(actionsSheet).toBeHidden()
    await expect(actions).toBeFocused()

    // Its close button.
    await actions.tap()
    await actionsSheet.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(actionsSheet).toBeHidden()
    await expect(actions).toBeFocused()

    // Duplicate closes the sheet too.
    await actions.tap()
    await actionsSheet.getByRole('button', { name: 'Duplicate' }).tap()
    await expect(actionsSheet).toBeHidden()
    await expect(page.getByRole('button', { name: 'Open notes copy.md' })).toBeVisible()
    await expect(actions).toBeFocused()

    // Rename mounts an autofocused input before the sheet finishes closing:
    // focus must stay on it.
    await actions.tap()
    await actionsSheet.getByRole('button', { name: 'Rename' }).tap()
    await expect(actionsSheet).toBeHidden()
    await expect(page.getByRole('textbox', { name: 'Rename notes.md' })).toBeFocused()
  })

  test('closing the Git sheet by Escape, its close button or its scrim returns focus to Git changes', async ({
    page
  }) => {
    await bootShell(page, await registerProject({ git: true }))
    const opener = page.getByRole('button', { name: 'Git changes' })
    const gitSheet = page.getByRole('dialog', { name: 'Git changes' })

    await opener.tap()
    await expect(gitSheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(gitSheet).toBeHidden()
    await expect(opener).toBeFocused()

    await opener.tap()
    await expect(gitSheet).toBeVisible()
    await gitSheet.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(gitSheet).toBeHidden()
    await expect(opener).toBeFocused()

    // The sheet is 90vh tall: a tap in the strip above it lands on the scrim.
    await opener.tap()
    await expect(gitSheet).toBeVisible()
    await page.touchscreen.tap(195, 30)
    await expect(gitSheet).toBeHidden()
    await expect(opener).toBeFocused()
  })
})

// ---------------------------------------------------------------------------
// Touch targets and reduced motion on the shared overlay primitives
// ---------------------------------------------------------------------------

test.describe('touch targets and reduced motion', () => {
  test('the sheet close is a 44px box whose glyph has not moved', async ({ page }) => {
    const project = await registerProject({ files: true })
    await bootShell(page, project)

    await page.getByRole('button', { name: 'Browse files' }).tap()
    const filesSheet = page.getByRole('dialog', { name: project.name })
    await expect(filesSheet).toBeVisible()
    await settled(filesSheet)

    const close = await boxOf(filesSheet.getByRole('button', { name: 'Close', exact: true }))
    const sheet = await boxOf(filesSheet)
    expect(close.width).toBeGreaterThanOrEqual(44)
    expect(close.height).toBeGreaterThanOrEqual(44)
    // The 16px glyph is centred in the box: it sits 24px from the sheet's top
    // right corner, where it was before the box grew.
    expect(Math.abs(sheet.x + sheet.width - (close.x + close.width / 2) - 24)).toBeLessThanOrEqual(
      1
    )
    expect(Math.abs(close.y + close.height / 2 - sheet.y - 24)).toBeLessThanOrEqual(1)
  })

  test('the dialog close is a 44px box whose glyph has not moved', async ({ page }) => {
    await bootShell(page, await registerProject({ git: true }))

    // A centred Dialog on the mobile shell (opened over the Git sheet).
    const dialog = await openCreateBranchDialog(page)
    await settled(dialog)

    const close = await boxOf(dialog.getByRole('button', { name: 'Close', exact: true }))
    const frame = await boxOf(dialog)
    expect(close.width).toBeGreaterThanOrEqual(44)
    expect(close.height).toBeGreaterThanOrEqual(44)
    // 24px from the corner plus the dialog's 1px border, as before the change.
    expect(Math.abs(frame.x + frame.width - (close.x + close.width / 2) - 25)).toBeLessThanOrEqual(
      1
    )
    expect(Math.abs(close.y + close.height / 2 - frame.y - 25)).toBeLessThanOrEqual(1)
  })

  test('every context menu row is at least 44px tall', async ({ page }) => {
    await bootShell(page, await registerProject())

    // The app-wide Copy / Cut / Paste / Select All menu (a long press on a phone).
    await page.getByRole('banner').click({ button: 'right', position: { x: 200, y: 10 } })
    const items = page.getByRole('menuitem')
    await expect(items).toHaveCount(4)
    // The menu zooms in: measure the rows once it has settled.
    await settled(page.getByRole('menu'))
    for (const item of await items.all()) {
      expect((await boxOf(item)).height).toBeGreaterThanOrEqual(44)
    }
  })

  test('sheet, dialog and context menu animate normally, and not at all under reduced motion', async ({
    page
  }) => {
    const project = await registerProject({ files: true, git: true })
    await bootShell(page, project)

    const surfaces: Array<{
      name: string
      open: () => Promise<void>
      content: Locator
      /** Closes whatever `open` left behind once the surface itself is gone. */
      cleanup?: () => Promise<void>
    }> = [
      {
        name: 'sheet',
        open: () => page.getByRole('button', { name: 'Browse files' }).tap(),
        content: page.getByRole('dialog', { name: project.name })
      },
      {
        name: 'dialog',
        open: async () => {
          await openCreateBranchDialog(page)
        },
        content: page.getByRole('dialog', { name: 'Create New Branch' }),
        // The Dialog opens over the Git sheet: Escape closed the Dialog only.
        // The sheet is aria-hidden until the Dialog's `hideOthers` is undone, and
        // under reduced motion the Dialog is gone at once: wait for the sheet to
        // be exposed again before dismissing it (a role query skips aria-hidden
        // nodes, so `toBeHidden` alone would pass at once).
        cleanup: async () => {
          const gitSheet = page.getByRole('dialog', { name: 'Git changes' })
          await expect(gitSheet).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(gitSheet).toBeHidden()
          await expect(page.getByRole('banner')).toBeVisible()
        }
      },
      {
        name: 'context menu',
        open: () =>
          page.getByRole('banner').click({ button: 'right', position: { x: 200, y: 10 } }),
        content: page.getByRole('menu')
      }
    ]
    // Content and, where there is one, its overlay (the content's previous sibling).
    const animationNames = (content: Locator): Promise<string[]> =>
      content.evaluate((el) =>
        [el, el.previousElementSibling]
          .filter(
            (node): node is Element => node instanceof Element && node.hasAttribute('data-state')
          )
          .map((node) => getComputedStyle(node).animationName)
      )

    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion })
      for (const surface of surfaces) {
        await surface.open()
        await expect(surface.content).toBeVisible()
        const names = await animationNames(surface.content)
        expect(names.length, `${surface.name} animated surfaces`).toBeGreaterThan(0)
        for (const name of names) {
          // Tailwind's `animate-in` names its keyframes `enter`; under reduced
          // motion `animate-none!` must win over the data-state variant.
          if (reducedMotion === 'reduce') expect(name, `${surface.name} (reduced)`).toBe('none')
          else expect(name, `${surface.name} (motion)`).toBe('enter')
        }
        await page.keyboard.press('Escape')
        await expect(surface.content).toBeHidden()
        await surface.cleanup?.()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Desktop is untouched
// ---------------------------------------------------------------------------

test.describe('desktop shell', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  })

  test('has no shell live region, a polite chat log and compact context menu rows', async ({
    page
  }) => {
    const project = await registerProject()
    await openApp(page, project, { waitForWarmup: true })
    await expect(page.locator(`[aria-label^="Project: ${project.name}"]`).first()).toBeVisible()
    await expect(liveRegion(page)).toHaveCount(0)

    await launchChat(page, 'floor desktop [DURATION:3]')
    const log = page.getByRole('log')
    await expect(log).toHaveAttribute('aria-live', 'polite')
    await expect(log).toHaveAttribute('aria-relevant', 'additions')
    await expect(liveRegion(page)).toHaveCount(0)

    // A fine pointer keeps the compact rows.
    await page.getByRole('log').click({ button: 'right', position: { x: 40, y: 40 } })
    const items = page.getByRole('menuitem')
    await expect(items).toHaveCount(4)
    for (const item of await items.all()) {
      expect((await boxOf(item)).height).toBeLessThan(44)
    }
  })
})
