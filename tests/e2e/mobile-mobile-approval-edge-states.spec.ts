import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile approval edge states E2E (spec-mobile-approval-edge-states): a
 * phone-sized browser drives REAL agent chats through the web client's mobile
 * shell and checks the four edge states jsdom cannot see end to end.
 *
 * - L-10: a pending elicitation reads "Needs you" (drawer row, header pill,
 *   shell region), exactly like a permission does.
 * - L-09: a permission that was pending when the control socket dropped and
 *   then leaves the store unanswered raises a persistent notice line and one
 *   announcement. The socket is dropped with `routeWebSocket`, the way the
 *   a11y-floor suite drops it; the server's own denial (after its 60s grace)
 *   is not waited for: the page only ever sees the request leave with the
 *   turn's end, and that is the signal the feature reads.
 * - L-11: a required boolean elicitation field left untouched submits Off.
 * - L-12: an approval that mounts in a hidden chat gets its 400ms tap guard
 *   and its heading focus when that chat is opened.
 *
 * The fake agent (fake-longrun-agent.ts) supplies the approvals through
 * `[ASK:<kind>[:<seconds>]]` prompt markers and answers each with an
 * `[ANSWERED <kind> <outcome>]` transcript chunk, which is how these tests see
 * what the app sent back. Every test registers its own project (fresh chat
 * state, nothing shared with other suites). Project names start with
 * `proj-gate-` on purpose: other suites select `proj-a`..`proj-x` by name
 * PREFIX.
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
 * and the server never reaps them when it stops, so a suite that leaves them
 * running exhausts the machine's commit limit. Each test therefore kills the
 * agents it caused.
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
  // Close the page first: a page that is still open warms a replacement for
  // the agent killed below. A failed test keeps its page for the failure report.
  if (testInfo.status === testInfo.expectedStatus) await page.close()
  for (const agentId of await serverAgentIds()) {
    if (agentsBeforeTest.has(agentId)) continue
    await wsRequest(E2E_BASE_URL, 'kill_agent', { agentId }).catch(() => {
      // already gone (closed by the test itself)
    })
  }
})

/** Keeps a turn running for the whole test, so the chat stays busy. */
const LONG = '[DURATION:90]'
/** The permission guard (400ms) plus headroom, measured on the page's own clock. */
const GUARD_CLEARED_MS = 450
/** Longest chat title the app keeps whole (`deriveTitle`). */
const TITLE_LIMIT = 48
/** What the fake agent's `[ASK:permission]` request is for (the tool row title). */
const TOOL = 'npm test -- auth'
const DENIAL = `Permission for ${TOOL} was denied because this device disconnected. Ask the agent to retry.`

interface Project {
  id: string
  name: string
  path: string
}

/**
 * Register a throwaway project under the suite's workspace root. The name is
 * unique per call: chats persist per project id, so a reused id would restore
 * an earlier test's chat.
 */
async function registerProject(): Promise<Project> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-gate-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
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

/** Boot the web client on `project` (its empty-pane launcher is what shows). */
async function boot(page: Page, project: Project): Promise<void> {
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
  await expect(
    page.getByRole('heading', { level: 1, name: `What should we do in ${project.name}?` })
  ).toBeVisible()
}

/**
 * Type `prompt` into the launcher and start the chat. The launcher re-renders
 * once its git probe settles, which drops focus and any text typed before that,
 * and Start stays disabled until the agent has warmed up. Entering the prompt
 * is idempotent (focus, select all, replace), so retry it until the chat starts
 * instead of sleeping for a fixed time. The editor is focused programmatically:
 * re-tapping a focused field raises the browser's own Copy/Paste menu.
 */
async function startFromLauncher(
  page: Page,
  prompt: string,
  press: (target: Locator) => Promise<void> = (target) => target.tap()
): Promise<void> {
  // The chat's title is its first prompt, and the app cuts a title at 48
  // characters: a longer prompt would no longer name its chat.
  if (Array.from(prompt).length > TITLE_LIMIT) {
    throw new Error(`prompt is over ${TITLE_LIMIT} characters, so the app would shorten its title`)
  }
  const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
  const start = page.getByRole('button', { name: 'Start agent chat' })
  // On a launcher opened with "New chat", Start has been seen enabled and yet doing
  // nothing when pressed at once: the launcher stays up with the text in it. So the
  // press is part of the retried step, and a launcher that closed is the proof.
  await expect(async () => {
    await launcher.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(prompt)
    await expect(start).toBeEnabled({ timeout: 2_500 })
    await press(start)
    await expect(launcher).toBeHidden({ timeout: 8_000 })
  }).toPass({ timeout: 40_000 })
}

/**
 * Start a chat on the mobile shell: from the empty pane (the first chat) or via
 * the header "New chat". Resolves once the header names the chat (its title is
 * the prompt text).
 */
async function startChat(
  page: Page,
  prompt: string,
  options: { viaNewChat?: boolean } = {}
): Promise<void> {
  if (options.viaNewChat) {
    await expectStreaming(page)
    await page.getByRole('button', { name: 'New chat', exact: true }).tap()
  }
  await startFromLauncher(page, prompt)
  await expect(page.getByRole('heading', { level: 1, name: prompt, exact: true })).toBeVisible()
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
    const store = window as unknown as { __edgeAnnounced: string[] }
    store.__edgeAnnounced = []
    new MutationObserver(() => {
      const text = region.textContent ?? ''
      if (text) store.__edgeAnnounced.push(text)
    }).observe(region, { childList: true, characterData: true, subtree: true })
  })
  return () =>
    page.evaluate(() => (window as unknown as { __edgeAnnounced: string[] }).__edgeAnnounced)
}

/**
 * A causal barrier for "nothing else was announced": make an announcement that
 * is known to land after every earlier one (the drawer search count), then close
 * the drawer. Whatever the transition under test also announced is in the
 * history by then, so the history can be checked whole. Waiting a fixed time
 * instead would only be a guess. The region keeps its last text, so a second
 * barrier in one test needs a different count than the first.
 */
async function announceBarrier(
  page: Page,
  search: { query: string; count: string } = { query: 'zzz-no-such-chat', count: '0 chats match' }
): Promise<void> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  await page.getByRole('textbox', { name: 'Search chats' }).fill(search.query)
  await expect(liveRegion(page)).toHaveText(search.count)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
}

/** Tap the shell's ☰ and wait for the drawer to be on screen. */
async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open menu' }).tap()
  const drawer = page.getByRole('dialog', { name: 'Menu' })
  await expect(drawer).toBeVisible()
  return drawer
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** An Open-section chat row: named `{title}` or `{title}, {status…}`. */
function chatRow(drawer: Locator, title: string): Locator {
  return drawer
    .getByRole('group', { name: 'Open', exact: true })
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}(,|$)`) })
}

/** Open the chat titled `title` from the drawer and wait for the shell to show it. */
async function openChatFromDrawer(page: Page, title: string): Promise<void> {
  const drawer = await openDrawer(page)
  await chatRow(drawer, title).tap()
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
}

/** The header pill that counts the OTHER chats that need you. */
function attentionPill(page: Page, name: string | RegExp): Locator {
  return page.getByRole('button', { name })
}

/** The heading of a generic elicitation form. */
function requestHeading(page: Page): Locator {
  return page.getByRole('heading', { level: 2, name: 'Request from the agent' })
}

/**
 * The notice line in the chat (`ChatErrorNotice`). The shell region carries the
 * same words for assistive tech, so the line is looked up inside `main`.
 */
function noticeLine(page: Page): Locator {
  return page.getByRole('main').getByText(DENIAL, { exact: true })
}

function permissionPrompt(page: Page): Locator {
  return page.getByRole('region', { name: 'Approval needed' })
}

/** The chat composer card: the focus target after an approval resolves. */
function composerCard(page: Page): Locator {
  return page.locator('[data-chat-composer="true"]')
}

/** How many times the transcript carries the agent's `[ANSWERED …]` chunk. */
async function answeredCount(page: Page, summary: string): Promise<number> {
  const text = await page.locator('main').innerText()
  return text.split(`[ANSWERED ${summary}]`).length - 1
}

/** Frames the page sent on the app's `/ws` relay, filtered by message type. */
function trackWsFrames(page: Page): (type: string) => Array<Record<string, unknown>> {
  const frames: Array<{ type?: string; payload?: Record<string, unknown> }> = []
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/ws')) return
    socket.on('framesent', (frame) => {
      try {
        frames.push(JSON.parse(String(frame.payload)))
      } catch {
        // not a JSON frame
      }
    })
  })
  return (type) => frames.filter((f) => f.type === type).map((f) => f.payload ?? {})
}

/** Messages the page posted to the server log (`/log/frontend-error`). */
function trackFrontendLogs(page: Page): () => string[] {
  const posted: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/log/frontend-error')) {
      posted.push(req.postData() ?? '')
    }
  })
  return () => posted
}

interface Wire {
  /** Close the control socket now and refuse every reconnect until `restore`. */
  drop: () => Promise<void>
  /** Let the next reconnect attempt through to the real server. */
  restore: () => void
}

/**
 * Put the page's control socket (`/ws`) under test control: while down, every
 * connection attempt is closed on arrival, so the loss holds until `restore`.
 * Everything else passes through to the real server. Install before `boot`.
 */
async function installWire(page: Page): Promise<Wire> {
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
  return {
    drop: async () => {
      down = true
      for (const socket of live.splice(0)) await socket.close().catch(() => {})
    },
    restore: () => {
      down = false
    }
  }
}

/**
 * The chat on screen is streaming. Chats started within a second of each other
 * have been seen to leave the next launcher's Start doing nothing, so a test that
 * stacks chats waits for each to stream before starting the next.
 */
async function expectStreaming(page: Page): Promise<void> {
  await expect(page.locator('[data-chat-tab-state="visible"]')).toContainText('chunk-1')
}

/**
 * Drop the control socket and bring it back while an approval is pending:
 * resolves once the shell has announced the loss and the recovery. The chat on
 * screen has to be streaming first: a socket dropped while a chat is still being
 * created takes that creation down with it, which is not what is under test.
 */
async function loseAndRegainConnection(page: Page, wire: Wire): Promise<void> {
  await expectStreaming(page)
  await wire.drop()
  await expect(liveRegion(page)).toHaveText('Reconnecting…')
  wire.restore()
  await expect(liveRegion(page)).toHaveText('Connected', { timeout: 30_000 })
}

// ---------------------------------------------------------------------------
// L-10: an elicitation reads "Needs you"
// ---------------------------------------------------------------------------

test('an elicitation in another chat reads Needs you in the drawer row and the header pill, and the region names the chat once', async ({
  page
}) => {
  const project = await registerProject()
  await boot(page, project)
  const announced = await trackAnnouncements(page)

  // The first chat asks 15s after its prompt is accepted: by then the second
  // chat is the one on screen.
  const background = `[ASK:elicitation:15] ${LONG} hidden-a`
  await startChat(page, background)
  await startChat(page, `${LONG} foreground`, { viaNewChat: true })

  await expect.poll(announced, { timeout: 40_000 }).toContain(`${background} needs you`)
  const history = await announced()
  expect(history.filter((text) => text === `${background} needs you`)).toHaveLength(1)
  // Another chat's request is not the active chat's "Approval needed".
  expect(history).not.toContain('Approval needed')

  // The header pill counts it.
  const pill = attentionPill(page, '1 other chat needs you')
  await expect(pill).toBeVisible()
  await expect(pill).toHaveText('1')

  // The drawer row says so, beside the live turn.
  const drawer = await openDrawer(page)
  await expect(chatRow(drawer, background)).toHaveAccessibleName(
    `${background}, Needs you, Working`
  )

  // Landing in that chat takes it out of the count: it is the chat on screen now.
  await chatRow(drawer, background).tap()
  await expect(drawer).toBeHidden()
  await expect(requestHeading(page)).toBeVisible()
  await expect(attentionPill(page, /other chats? needs? you$/)).toHaveCount(0)
})

test('the active chat with an elicitation is announced as Approval needed and is left out of the pill', async ({
  page
}) => {
  const project = await registerProject()
  await boot(page, project)
  const announced = await trackAnnouncements(page)

  const prompt = `[ASK:elicitation] ${LONG} active`
  await startChat(page, prompt)

  await expect(liveRegion(page)).toHaveText('Approval needed')
  await expect(requestHeading(page)).toBeVisible()
  // The chat on screen needs you, but it is not an "other" chat: no pill, and
  // no second "needs you" announcement for it.
  await expect(attentionPill(page, /other chats? needs? you$/)).toHaveCount(0)
  await announceBarrier(page)
  expect(await announced()).toEqual(['Approval needed', '0 chats match'])

  // The drawer still reads the chat's own state.
  const drawer = await openDrawer(page)
  await expect(chatRow(drawer, prompt)).toHaveAccessibleName(`${prompt}, Needs you, Working`)
})

// ---------------------------------------------------------------------------
// L-11: a required boolean left untouched is sent Off
// ---------------------------------------------------------------------------

test('a required boolean left untouched submits Off and an untouched optional one is left out', async ({
  page
}) => {
  const project = await registerProject()
  await boot(page, project)
  await startChat(page, `[ASK:elicitation-boolean] ${LONG} off`)

  const heading = requestHeading(page)
  await expect(heading).toBeVisible()
  const confirm = page.getByRole('switch', { name: 'confirm' })
  const notify = page.getByRole('switch', { name: 'notify' })
  // The Switch shows Off for both, and the required one says so to assistive tech.
  await expect(confirm).toHaveAttribute('aria-checked', 'false')
  await expect(confirm).toHaveAttribute('aria-required', 'true')
  await expect(notify).toHaveAttribute('aria-checked', 'false')
  await expect(notify).not.toHaveAttribute('aria-required', /.*/)

  await page.getByRole('button', { name: 'Submit', exact: true }).tap()

  // No "is required" complaint: the agent got `confirm=false` and no `notify` at all.
  await expect(heading).toBeHidden()
  await expect.poll(() => answeredCount(page, 'elicitation-boolean accept confirm=false')).toBe(1)
  await expect(page.getByText('confirm is required.')).toHaveCount(0)
  await expect(composerCard(page)).toBeFocused()
})

test('a required boolean toggled on submits On, beside the optional one when it is toggled too', async ({
  page
}) => {
  const project = await registerProject()
  await boot(page, project)
  await startChat(page, `[ASK:elicitation-boolean] ${LONG} on`)

  const heading = requestHeading(page)
  await expect(heading).toBeVisible()
  const confirm = page.getByRole('switch', { name: 'confirm' })
  const notify = page.getByRole('switch', { name: 'notify' })
  await confirm.tap()
  await expect(confirm).toHaveAttribute('aria-checked', 'true')
  await notify.tap()
  await expect(notify).toHaveAttribute('aria-checked', 'true')

  await page.getByRole('button', { name: 'Submit', exact: true }).tap()

  await expect(heading).toBeHidden()
  await expect
    .poll(() => answeredCount(page, 'elicitation-boolean accept confirm=true notify=true'))
    .toBe(1)
})

// ---------------------------------------------------------------------------
// L-12: an approval that mounted in a hidden chat
// ---------------------------------------------------------------------------

test('a permission that mounted in a hidden chat ignores a tap in the first 400ms after the chat is opened', async ({
  page
}) => {
  const sent = trackWsFrames(page)
  const logs = trackFrontendLogs(page)
  const project = await registerProject()
  await boot(page, project)
  const announced = await trackAnnouncements(page)

  // The permission arrives 15s after the prompt is accepted: by then the
  // second chat is on screen and this chat's pane is hidden.
  const background = `[ASK:permission:15] ${LONG} hidden-p`
  await startChat(page, background)
  await startChat(page, `${LONG} foreground`, { viaNewChat: true })
  await expect.poll(announced, { timeout: 40_000 }).toContain(`${background} needs you`)
  // The request mounted while the chat's pane was hidden.
  await expect(page.locator('[data-chat-tab-state="hidden"]').first()).toBeAttached()

  // A tap aimed at the chat's editor lands on Allow as the pane shows: click
  // Allow once in the same task the pane turns visible.
  await page.evaluate(() => {
    const w = window as unknown as { __shownAt?: number }
    new MutationObserver((records) => {
      if (w.__shownAt !== undefined) return
      for (const record of records) {
        const pane = record.target as HTMLElement
        if (pane.getAttribute('data-chat-tab-state') !== 'visible') continue
        const allow = [
          ...pane.querySelectorAll('[data-approval-prompt^="permission:"] button')
        ].find((button) => button.textContent?.trim() === 'Allow once') as HTMLElement | undefined
        if (!allow) continue
        w.__shownAt = performance.now()
        allow.click()
      }
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-chat-tab-state'],
      subtree: true
    })
  })
  await openChatFromDrawer(page, background)
  const prompt = permissionPrompt(page)
  await expect(prompt).toBeVisible()
  await page.waitForFunction(
    () => (window as unknown as { __shownAt?: number }).__shownAt !== undefined
  )

  // Ignored: the request is still pending, nothing went to the agent, and the
  // guard logged it.
  await expect
    .poll(() =>
      logs().some((message) => message.includes('Ignored early tap on permission request'))
    )
    .toBe(true)
  await expect(prompt).toBeVisible()
  expect(sent('respond_permission')).toHaveLength(0)
  expect(await answeredCount(page, 'permission allow-once')).toBe(0)

  // 400ms after the chat showed, the very same control answers, once.
  await page.waitForFunction((ms) => {
    const shown = (window as unknown as { __shownAt: number }).__shownAt
    return performance.now() - shown >= ms
  }, GUARD_CLEARED_MS)
  await prompt.getByRole('button', { name: 'Allow once' }).tap()

  await expect(prompt).toBeHidden()
  await expect.poll(() => answeredCount(page, 'permission allow-once')).toBe(1)
  const responses = sent('respond_permission')
  expect(responses).toHaveLength(1)
  expect(responses[0]).toMatchObject({ optionId: 'allow-once' })
})

test('an elicitation that mounted in a hidden chat takes heading focus when the chat is opened, not before', async ({
  page
}) => {
  // Every focus the page moves, by element: the heading of a generic form is
  // an `h2` named "Request from the agent".
  await page.addInitScript(() => {
    const w = window as unknown as { __focused: string[] }
    w.__focused = []
    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target as HTMLElement
        w.__focused.push(`${target.tagName.toLowerCase()}:${(target.textContent ?? '').trim()}`)
      },
      true
    )
  })
  const focused = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __focused: string[] }).__focused)
  const HEADING = 'h2:Request from the agent'

  const project = await registerProject()
  await boot(page, project)
  const announced = await trackAnnouncements(page)

  const background = `[ASK:elicitation:15] ${LONG} hidden-e`
  await startChat(page, background)
  await startChat(page, `${LONG} foreground`, { viaNewChat: true })
  await expect.poll(announced, { timeout: 40_000 }).toContain(`${background} needs you`)
  // The form mounted in the hidden chat without taking focus.
  expect(await focused()).not.toContain(HEADING)

  await openChatFromDrawer(page, background)
  await expect(requestHeading(page)).toBeVisible()
  await expect.poll(focused).toContain(HEADING)
})

// ---------------------------------------------------------------------------
// L-09: a permission denied because this device disconnected
// ---------------------------------------------------------------------------

test('a permission that left unanswered after a connection loss shows one notice line, announced once, with no Retry', async ({
  page
}) => {
  const logs = trackFrontendLogs(page)
  const wire = await installWire(page)
  const project = await registerProject()
  await boot(page, project)
  const announced = await trackAnnouncements(page)

  // The turn ends 12s after the prompt is accepted, with the request still
  // unanswered: that is the end the notice reads.
  await startChat(page, `[ASK:permission] [DURATION:12] denied`)
  await expect(permissionPrompt(page)).toBeVisible()
  await loseAndRegainConnection(page, wire)

  const notice = noticeLine(page)
  await expect(notice).toBeVisible({ timeout: 40_000 })
  // One persistent line with only a Dismiss control: the agent has to ask again.
  const line = notice.locator('xpath=..')
  await expect(line.getByRole('button')).toHaveCount(1)
  await expect(line.getByRole('button', { name: 'Dismiss error' })).toBeVisible()
  await expect(line.getByRole('button', { name: /retry/i })).toHaveCount(0)

  // The shell region said the same words once; the turn's end did not replace them.
  await expect.poll(announced).toContain(DENIAL)
  await announceBarrier(page)
  const history = await announced()
  expect(history.filter((text) => text === DENIAL)).toHaveLength(1)
  expect(history).not.toContain('Turn finished')
  await expect(notice).toBeVisible()

  // The log carries ids only, never the tool text.
  const denialLogs = logs().filter((body) => body.includes('acp.permissionDeniedByDisconnect'))
  expect(denialLogs).toHaveLength(1)
  expect(denialLogs[0]).not.toContain(TOOL)
})

test('the notice line clears when the next turn starts, without a second announcement', async ({
  page
}) => {
  const wire = await installWire(page)
  const project = await registerProject()
  await boot(page, project)
  const announced = await trackAnnouncements(page)

  await startChat(page, `[ASK:permission] [DURATION:12] then next`)
  await expect(permissionPrompt(page)).toBeVisible()
  await loseAndRegainConnection(page, wire)
  const notice = noticeLine(page)
  await expect(notice).toBeVisible({ timeout: 40_000 })

  // The user sends the next prompt from the composer.
  const editor = composerCard(page).getByRole('textbox')
  await editor.tap()
  await page.keyboard.insertText('next turn [DURATION:4]')
  await page.keyboard.press('Enter')

  await expect(notice).toBeHidden()
  // Its own end is announced as usual, and the denial is not repeated.
  await expect(liveRegion(page)).toHaveText('Turn finished', { timeout: 30_000 })
  expect((await announced()).filter((text) => text === DENIAL)).toHaveLength(1)
  await expect(notice).toBeHidden()
})

test('answering the permission after the connection came back raises no notice', async ({
  page
}) => {
  const wire = await installWire(page)
  const project = await registerProject()
  await boot(page, project)
  const announced = await trackAnnouncements(page)

  await startChat(page, `[ASK:permission] [DURATION:25] answered`)
  const prompt = permissionPrompt(page)
  await expect(prompt).toBeVisible()
  await loseAndRegainConnection(page, wire)

  // The user answers: that is the user's call, not a denial.
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: 'Allow once' }).tap()
  await expect(prompt).toBeHidden()
  await expect.poll(() => answeredCount(page, 'permission allow-once')).toBe(1)

  // The turn then ends on its own: the end of the turn is announced, a denial is not.
  await expect(liveRegion(page)).toHaveText('Turn finished', { timeout: 45_000 })
  await announceBarrier(page)
  const history = await announced()
  expect(history.filter((text) => text.includes('was denied'))).toHaveLength(0)
  await expect(noticeLine(page)).toHaveCount(0)
})

test("another chat's denied permission is stored silently and shows its line when that chat is opened", async ({
  page
}) => {
  const wire = await installWire(page)
  const project = await registerProject()
  await boot(page, project)
  const announced = await trackAnnouncements(page)

  // The first chat holds an unanswered permission while the second is on screen.
  const background = `[ASK:permission] [DURATION:30] background`
  await startChat(page, background)
  await expect(permissionPrompt(page)).toBeVisible()
  await startChat(page, `${LONG} foreground`, { viaNewChat: true })
  await loseAndRegainConnection(page, wire)

  // The first chat's turn ends with the request unanswered: its drawer row stops
  // reading Needs you.
  const drawer = await openDrawer(page)
  await expect(chatRow(drawer, background)).not.toHaveAccessibleName(/Needs you/, {
    timeout: 60_000
  })
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  // Nothing was said about it: it is not the chat on screen.
  await announceBarrier(page)
  expect((await announced()).filter((text) => text.includes('was denied'))).toHaveLength(0)
  // (Its line is already in the hidden chat, just not on screen.)
  await expect(noticeLine(page)).toBeHidden()

  // Opening that chat shows the line, without announcing it now.
  await openChatFromDrawer(page, background)
  const notice = noticeLine(page)
  await expect(notice).toBeVisible()
  // Only the foreground chat's title has "foreground" in it: one match.
  await announceBarrier(page, { query: 'foreground', count: '1 chat matches' })
  expect((await announced()).filter((text) => text.includes('was denied'))).toHaveLength(0)

  // Dismiss hides it.
  await page.getByRole('button', { name: 'Dismiss error' }).tap()
  await expect(notice).toBeHidden()
})

// ---------------------------------------------------------------------------
// Desktop browser: the shell-gated behaviour stays as it was
// ---------------------------------------------------------------------------

test.describe('desktop browser', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  })

  const click = (target: Locator): Promise<void> => target.click()

  test('a chat with an elicitation reads Needs you in the tab and the status bar, and its heading takes no focus', async ({
    page
  }) => {
    const project = await registerProject()
    await boot(page, project)
    const prompt = `[ASK:elicitation] ${LONG} desktop`
    await startFromLauncher(page, prompt, click)

    const heading = requestHeading(page)
    await expect(heading).toBeVisible()
    // The tab chrome names the status beside the title.
    await expect(
      page.locator(`[draggable="true"][aria-label="${prompt}, Needs you"]`).first()
    ).toBeVisible()
    // So does the status bar's needs-you pill for the active project.
    await expect(page.getByRole('button', { name: `${prompt} needs you` })).toBeVisible()
    // Desktop never moves focus into the form or makes its heading focusable.
    await expect(heading).not.toHaveAttribute('tabindex', /.*/)
    await expect(heading).not.toBeFocused()
  })

  test('an untouched required boolean is still "required" and does not submit; checked, it submits On', async ({
    page
  }) => {
    const project = await registerProject()
    await boot(page, project)
    await startFromLauncher(page, `[ASK:elicitation-boolean] ${LONG} desktop`, click)

    const dialog = page.getByRole('dialog', { name: 'Confirm the deployment' })
    await expect(dialog).toBeVisible()
    const confirm = dialog.getByRole('checkbox', { name: 'confirm' })
    await expect(confirm).not.toBeChecked()

    await dialog.getByRole('button', { name: 'Submit', exact: true }).click()
    // The shipped complaint, and nothing went to the agent.
    await expect(page.getByText('confirm is required.')).toBeVisible()
    await expect(dialog).toBeVisible()
    expect(await answeredCount(page, 'elicitation-boolean accept confirm=false')).toBe(0)

    await confirm.check()
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => answeredCount(page, 'elicitation-boolean accept confirm=true')).toBe(1)
  })
})
