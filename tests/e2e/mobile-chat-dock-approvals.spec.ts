import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile chat dock and approvals E2E (spec-mobile-chat-dock-approvals): a
 * phone-sized browser drives a REAL agent chat through the web client's mobile
 * shell and checks what jsdom cannot: measured touch targets and hit areas,
 * which element holds focus after approvals appear and resolve, the 400ms
 * early-tap guard against the real clock, the keyboard-up compact dock and the
 * Git sheet opening on the chat's own worktree.
 *
 * The fake agent (fake-longrun-agent.ts) supplies the dock content through
 * prompt markers: `[DOCK]` (plan + three edits, +17 -2) and `[ASK:<kind>]`
 * (permission, permission-none, question, elicitation). It answers each
 * request with an `[ANSWERED <kind> <outcome>]` transcript chunk, which is how
 * these tests see what the app sent back. Every test registers its own
 * project (fresh chat state, nothing shared with other suites).
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

/**
 * Every chat (and every launcher warm-up) runs its own `bun` fake-agent process
 * and the server never reaps them when it stops, so a suite that leaves them
 * running exhausts the machine's commit limit (`memory allocation ... failed`
 * in the server). Each test therefore kills the agents it caused.
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

/** Keeps a turn running for the whole test, so the dock stays busy. */
const LONG = '[DURATION:90]'
/** The permission guard (400ms) plus headroom, measured on the page's own clock. */
const GUARD_CLEARED_MS = 450

interface Project {
  id: string
  name: string
  path: string
}

/**
 * Register a throwaway project under the suite's workspace root. The name is
 * unique per call: chats persist per project id, so a reused id would restore
 * an earlier test's chat. `files` are written into the project; `git` makes it
 * a repository with one commit (the launcher then offers worktree isolation).
 */
async function registerProject(
  opts: { git?: boolean; files?: Record<string, string> } = {}
): Promise<Project> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-dock-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  if (opts.git) {
    execSync('git init -q -b main', { cwd: path })
    execSync('git -c user.email=e2e@termul -c user.name=e2e commit -q --allow-empty -m init', {
      cwd: path
    })
  }
  for (const [file, content] of Object.entries(opts.files ?? {})) {
    await mkdir(dirname(join(path, file)), { recursive: true })
    await writeFile(join(path, file), content)
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
 * Page-side probes, installed before the app loads:
 * - `__approvalSeenAt`: when each approval prompt first appeared, on the
 *   page's own clock, so a tap can wait until the 400ms guard has cleared.
 * - `__scrolled`: every `scrollIntoView` call (text of the element, options).
 */
async function installPageProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __approvalSeenAt: Map<string, number>
      __scrolled: Array<{ text: string; block?: string }>
    }
    w.__approvalSeenAt = new Map()
    w.__scrolled = []
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-approval-prompt]')) {
        const key = el.getAttribute('data-approval-prompt') ?? ''
        if (!w.__approvalSeenAt.has(key)) w.__approvalSeenAt.set(key, performance.now())
      }
    }).observe(document, { childList: true, subtree: true })
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
      const block = typeof arg === 'object' ? arg.block : undefined
      w.__scrolled.push({ text: (this.textContent ?? '').trim(), block })
      return original.call(this, arg as ScrollIntoViewOptions)
    }
  })
}

/**
 * Emulate the on-screen keyboard: the visual viewport reports `px` less height
 * than the layout viewport, which is what the dock's keyboard hook reads.
 */
async function installFakeKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const vv = window.visualViewport
    if (!vv) return
    Object.defineProperty(vv, 'height', {
      configurable: true,
      get: () =>
        window.innerHeight - ((window as unknown as { __keyboardPx?: number }).__keyboardPx ?? 0)
    })
  })
}

async function setKeyboardHeight(page: Page, px: number): Promise<void> {
  await page.evaluate((height) => {
    ;(window as unknown as { __keyboardPx: number }).__keyboardPx = height
    window.visualViewport?.dispatchEvent(new Event('resize'))
  }, px)
}

/** Resolves once the newest approval prompt has been on screen past the guard. */
async function waitPastApprovalGuard(page: Page): Promise<void> {
  await page.waitForFunction((ms) => {
    const seen = [
      ...(window as unknown as { __approvalSeenAt: Map<string, number> }).__approvalSeenAt.values()
    ]
    return seen.length > 0 && performance.now() - Math.max(...seen) >= ms
  }, GUARD_CLEARED_MS)
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

interface LaunchOptions {
  project?: Project
  /** Choose "New worktree" isolation in the launcher (needs `project` with git). */
  worktree?: boolean
  /** Drive the page with a mouse instead of touch (the desktop-parity test). */
  mouse?: boolean
}

/**
 * Boot the shell on a project and start a chat from the empty-pane launcher.
 * Resolves once the launcher has handed over to the chat.
 */
async function launchChat(page: Page, prompt: string, opts: LaunchOptions = {}): Promise<Project> {
  const project = opts.project ?? (await registerProject())
  const press = (target: Locator): Promise<void> => (opts.mouse ? target.click() : target.tap())
  await installPageProbes(page)
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

  const launcher = page.getByRole('textbox', { name: 'Agent prompt' })
  const start = page.getByRole('button', { name: 'Start agent chat' })
  if (opts.worktree) {
    await press(page.getByRole('combobox', { name: 'Isolation mode' }))
    await press(page.getByRole('option', { name: 'New worktree' }))
    await expect(page.getByRole('combobox', { name: 'Base branch' })).toContainText('main')
  }
  // The launcher re-renders once its git probe settles, which drops focus and
  // any text typed before that, and Start stays disabled until the agent has
  // warmed up. Entering the prompt is idempotent (focus, select all, replace),
  // so retry it until Start enables instead of sleeping for a fixed time. The
  // editor is focused programmatically: re-tapping a focused field raises the
  // browser's own Copy/Paste menu over the page.
  await expect(async () => {
    await launcher.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(prompt)
    await expect(start).toBeEnabled({ timeout: 2_500 })
  }).toPass({ timeout: 40_000 })
  await press(start)
  // The launcher hands over to the chat at once. The composer card is not a
  // reliable signal: a pending question replaces it.
  await expect(launcher).toBeHidden()
  return project
}

/** The chat composer card: the focus target after an approval resolves. */
function composerCard(page: Page): Locator {
  return page.locator('[data-chat-composer="true"]')
}

function chatEditor(page: Page): Locator {
  return composerCard(page).getByRole('textbox')
}

function permissionPrompt(page: Page): Locator {
  return page.getByRole('region', { name: 'Approval needed' })
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
 * The area where a tap reaches `locator`'s button: scans outwards from its
 * centre until another element takes over, so a clipped or covered hit-slop
 * counts for what it really is.
 */
async function hitArea(
  locator: Locator
): Promise<{ left: number; right: number; top: number; bottom: number; height: number }> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const reaches = (x: number, y: number): boolean =>
      document.elementFromPoint(x, y)?.closest('button') === el
    const scan = (dx: number, dy: number): number => {
      let n = 0
      while (n < 40 && reaches(cx + dx * (n + 1), cy + dy * (n + 1))) n++
      return n
    }
    const up = scan(0, -1)
    const down = scan(0, 1)
    return {
      left: cx - scan(-1, 0),
      right: cx + scan(1, 0),
      top: cy - up,
      bottom: cy + down,
      height: up + down + 1
    }
  })
}

/** How many times the transcript carries the agent's `[ANSWERED …]` chunk. */
async function answeredCount(page: Page, summary: string): Promise<number> {
  const text = await page.locator('main').innerText()
  return text.split(`[ANSWERED ${summary}]`).length - 1
}

async function fontSizeOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
}

const slashes = (p: string): string => p.replace(/\\+/g, '/').replace(/\/+$/, '')

/**
 * Root of the git worktree the app created for the project's chat (not the
 * project itself). The chat's composer shows while `git worktree add` is still
 * running, so this waits for the worktree to be registered.
 */
async function worktreePathOf(project: Project): Promise<string> {
  let found = ''
  await expect
    .poll(
      () => {
        const listed = execSync('git worktree list --porcelain', {
          cwd: project.path,
          encoding: 'utf8'
        })
          .split('\n')
          .filter((line) => line.startsWith('worktree '))
          .map((line) => line.slice('worktree '.length).trim())
        found =
          listed.find((p) => slashes(p).toLowerCase() !== slashes(project.path).toLowerCase()) ?? ''
        return found
      },
      { message: `a git worktree beside ${project.path}` }
    )
    .not.toBe('')
  return found
}

// ---------------------------------------------------------------------------
// Plan bar, changed-files bar and queue: compact by default
// ---------------------------------------------------------------------------

test('plan bar starts collapsed as "Plan 3/5" above the chat and expands in place', async ({
  page
}) => {
  await launchChat(page, `[DOCK] ${LONG} plan bar`)
  const plan = page.getByRole('button', { name: /^Plan, 3 of 5 tasks/ })
  const entry = page.getByText('Cover login with tests')

  await expect(plan).toBeVisible()
  await expect(plan).toHaveAttribute('aria-expanded', 'false')
  await expect(plan).toContainText('3/5')
  expect((await boxOf(plan)).height).toBeGreaterThanOrEqual(44)
  await expect(entry).toBeHidden()
  // Above the thread and the dock, not inside them.
  const changed = page.getByRole('button', { name: 'Changed files 3 +17 −2', exact: true })
  await expect(changed).toBeVisible()
  expect((await boxOf(plan)).y).toBeLessThan((await boxOf(changed)).y)

  await plan.tap()
  await expect(plan).toHaveAttribute('aria-expanded', 'true')
  await expect(entry).toBeVisible()

  await plan.tap()
  await expect(plan).toHaveAttribute('aria-expanded', 'false')
  await expect(entry).toBeHidden()
})

test('changed-files bar is named by its text, starts collapsed and opens a row in the editor', async ({
  page
}) => {
  await launchChat(page, `[DOCK] ${LONG} changed files`, {
    project: await registerProject({
      files: { 'src/auth.ts': "export const authMarker = 'e2e-auth-file'" }
    })
  })
  const bar = page.getByRole('button', { name: 'Changed files 3 +17 −2', exact: true })

  await expect(bar).toBeVisible()
  // The visible text names it: no overriding aria-label such as "Expand changed files".
  await expect(bar).not.toHaveAttribute('aria-label', /.*/)
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: /^src\/auth\.ts/ })).toBeHidden()

  await bar.tap()
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('button', { name: /^src\/session\.ts/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^src\/token\.ts/ })).toBeVisible()

  // A row still opens the file in an editor tab.
  await page.getByRole('button', { name: /^src\/auth\.ts/ }).tap()
  await expect(page.getByText('e2e-auth-file')).toBeVisible()
  await page.getByRole('button', { name: 'Open menu' }).tap()
  await expect(
    page.locator('#mobile-chat-drawer').getByText('auth.ts', { exact: true })
  ).toBeVisible()
})

test('the Git action reaches a 44px hit area with the bar collapsed and expanded', async ({
  page
}) => {
  await launchChat(page, `[DOCK] ${LONG} git hit area`)
  const bar = page.getByRole('button', { name: 'Changed files 3 +17 −2', exact: true })
  const git = page.getByRole('button', { name: 'Open Git changes', exact: true })
  await expect(git).toBeVisible()
  await expect(git).toHaveText('Git')

  // Collapsed is the state the bar starts in; part of its hit-slop sits under
  // the composer and behind the card edge, so only a measurement tells.
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await hitArea(git)).height).toBeGreaterThanOrEqual(44)

  await bar.tap()
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('button', { name: /^src\/auth\.ts/ })).toBeVisible()
  await expect.poll(async () => (await hitArea(git)).height).toBeGreaterThanOrEqual(44)
  // The Git action is its own control: tapping the header toggles, Git does not.
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
})

test('queue starts collapsed with a touch-height trigger and names each action by its row', async ({
  page
}) => {
  await launchChat(page, `${LONG} queue`)
  for (const text of ['first queued note', 'second queued note']) {
    await chatEditor(page).tap()
    await page.keyboard.insertText(text)
    await page.keyboard.press('Enter')
  }

  const trigger = page.getByRole('button', { name: '2 Queued', exact: true })
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect((await boxOf(trigger)).height).toBeGreaterThanOrEqual(44)

  await trigger.tap()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  for (const note of ['first queued note', 'second queued note']) {
    for (const action of ['Send now', 'Remove from queue']) {
      const button = page.getByRole('button', { name: `${action}: ${note}`, exact: true })
      await expect(button).toBeVisible()
      expect((await boxOf(button)).height).toBeGreaterThanOrEqual(44)
    }
  }

  await page.getByRole('button', { name: 'Remove from queue: first queued note' }).tap()
  await expect(page.getByRole('button', { name: '1 Queued', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /first queued note/ })).toHaveCount(0)

  // Send now on the remaining row empties the queue and sends it to the agent.
  await page.getByRole('button', { name: 'Send now: second queued note' }).tap()
  await expect(page.getByRole('button', { name: /Queued/ })).toHaveCount(0)
  await expect(page.locator('main')).toContainText('second queued note')
})

// ---------------------------------------------------------------------------
// Git sheet: opens on the chat's own worktree
// ---------------------------------------------------------------------------

test('the Git action opens the sheet on the chat worktree, not the project root', async ({
  page
}) => {
  const gitRequests: string[] = []
  page.on('request', (req) => {
    if (req.url().endsWith('/git/status')) gitRequests.push(req.postData() ?? '')
  })
  const logs = trackFrontendLogs(page)
  const project = await launchChat(page, `[DOCK] ${LONG} worktree git`, {
    project: await registerProject({ git: true }),
    worktree: true
  })
  const worktree = await worktreePathOf(project)
  await writeFile(join(worktree, 'worktree-only.txt'), 'only in the worktree\n')

  await page.getByRole('button', { name: 'Open Git changes', exact: true }).tap()

  const sheet = page.getByRole('dialog', { name: 'Git changes' })
  await expect(sheet).toBeVisible()
  // The project root is on `main`; the chat's worktree is on its own `chat/…` branch.
  await expect(sheet).toContainText(/chat\/[0-9a-f]+/)
  await expect(sheet).toContainText('worktree-only.txt')
  await expect(sheet.getByText('main', { exact: true })).toHaveCount(0)
  expect(gitRequests.some((body) => slashes(body).includes('.termul/worktrees'))).toBe(true)
  await expect
    .poll(() => logs().some((message) => message.includes('Git sheet opened from explicit cwd')))
    .toBe(true)

  // Escape closes it again; the dock is still there.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open Git changes', exact: true })).toBeVisible()
})

test('the header Git changes button opens the same worktree from the active chat', async ({
  page
}) => {
  const logs = trackFrontendLogs(page)
  const project = await launchChat(page, `${LONG} header git`, {
    project: await registerProject({ git: true }),
    worktree: true
  })
  // The launcher opens the chat on the project root and only re-points it at
  // the worktree once `git worktree add` is done. The agent's first chunk
  // arrives after that, so wait for it before asking for the chat's directory.
  await expect(page.locator('main')).toContainText('chunk-1')
  await writeFile(
    join(await worktreePathOf(project), 'worktree-only.txt'),
    'only in the worktree\n'
  )

  await page.getByRole('button', { name: 'Git changes', exact: true }).tap()

  const sheet = page.getByRole('dialog', { name: 'Git changes' })
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText(/chat\/[0-9a-f]+/)
  await expect(sheet).toContainText('worktree-only.txt')
  // Resolved from the active chat's own session, not from the project's
  // active-worktree fallback that lands on the same directory here.
  await expect
    .poll(() => logs().some((message) => message.includes('Git sheet opened from active-chat cwd')))
    .toBe(true)
})

// ---------------------------------------------------------------------------
// Permission prompt
// ---------------------------------------------------------------------------

test('permission options are touch-sized, ordered allows then rejects, with one filled primary', async ({
  page
}) => {
  await launchChat(page, `[ASK:permission] ${LONG} options`)
  const prompt = permissionPrompt(page)
  await expect(prompt).toBeVisible()
  const options = prompt.getByRole('group', { name: 'Permission options' }).getByRole('button')

  // The agent sent Reject first; the prompt shows the allows, then the reject.
  await expect(options).toHaveText(['Always allow', 'Allow once', 'Reject'])
  await expect(options.nth(1)).toHaveClass(/bg-primary-fill/)
  await expect(options.nth(0)).not.toHaveClass(/bg-primary-fill/)
  await expect(options.nth(2)).not.toHaveClass(/bg-primary-fill/)

  const boxes: Box[] = []
  const areas = []
  for (let i = 0; i < 3; i++) {
    const option = options.nth(i)
    const box = await boxOf(option)
    expect(box.height, `option ${i} height`).toBeGreaterThanOrEqual(44)
    expect(await fontSizeOf(option), `option ${i} font size`).toBeGreaterThanOrEqual(14)
    boxes.push(box)
    areas.push(await hitArea(option))
  }
  // gap-3 between options, so the 6px hit-slop of one never reaches the next.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = areas[i]
      const b = areas[j]
      const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      expect(overlaps, `hit areas of option ${i} and ${j} overlap`).toBe(false)
    }
  }

  // Mobile drops the section's own live region and keeps the readable footnote.
  await expect(prompt).not.toHaveAttribute('aria-live', /.*/)
  await expect(prompt.locator('[aria-live]')).toHaveCount(0)
  await expect(prompt.getByText('Choose an option to resume the agent.')).toBeVisible()
})

test('a permission arriving while the user types does not take focus from the editor', async ({
  page
}) => {
  await launchChat(page, '[DURATION:3] opening turn')
  await expect(page.locator('main')).toContainText('[DONE after')

  const editor = chatEditor(page)
  await editor.tap()
  await page.keyboard.insertText(`[ASK:permission] ${LONG} second turn`)
  await page.keyboard.press('Enter')

  await expect(permissionPrompt(page)).toBeVisible()
  await expect(editor).toBeFocused()
  // Typing carries on in the editor, not on an approval button.
  await page.keyboard.insertText('still typing')
  await expect(editor).toContainText('still typing')
  await expect(permissionPrompt(page)).toBeVisible()
})

test('a tap within 400ms of the request is ignored; a later tap answers exactly once', async ({
  page
}) => {
  const sent = trackWsFrames(page)
  const logs = trackFrontendLogs(page)
  // A tap aimed at the editor lands on Allow as the prompt appears under the
  // thumb: click Allow once in the same task the prompt is first rendered.
  await page.addInitScript(() => {
    const w = window as unknown as { __earlyTapAt?: number }
    new MutationObserver(() => {
      if (w.__earlyTapAt !== undefined) return
      const allow = [
        ...document.querySelectorAll('[data-approval-prompt^="permission:"] button')
      ].find((b) => b.textContent?.trim() === 'Allow once') as HTMLElement | undefined
      if (!allow) return
      w.__earlyTapAt = performance.now()
      allow.click()
    }).observe(document, { childList: true, subtree: true })
  })
  await launchChat(page, `[ASK:permission] ${LONG} early tap`)

  const prompt = permissionPrompt(page)
  await expect(prompt).toBeVisible()
  await page.waitForFunction(
    () => (window as unknown as { __earlyTapAt?: number }).__earlyTapAt !== undefined
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

  // 400ms after that tap the very same control answers, once.
  await page.waitForFunction((ms) => {
    const tapped = (window as unknown as { __earlyTapAt: number }).__earlyTapAt
    return performance.now() - tapped >= ms
  }, GUARD_CLEARED_MS)
  await prompt.getByRole('button', { name: 'Allow once' }).tap()

  await expect(prompt).toBeHidden()
  await expect.poll(() => answeredCount(page, 'permission allow-once')).toBe(1)
  const responses = sent('respond_permission')
  expect(responses).toHaveLength(1)
  expect(responses[0]).toMatchObject({ optionId: 'allow-once' })
})

test('rejecting answers with the reject option and returns focus to the composer card', async ({
  page
}) => {
  const sent = trackWsFrames(page)
  await launchChat(page, `[ASK:permission] ${LONG} reject`)
  const prompt = permissionPrompt(page)
  await expect(prompt).toBeVisible()
  await waitPastApprovalGuard(page)

  await prompt.getByRole('button', { name: 'Reject' }).tap()

  await expect(prompt).toBeHidden()
  await expect.poll(() => answeredCount(page, 'permission reject-once')).toBe(1)
  expect(sent('respond_permission')).toHaveLength(1)
  // Focus goes to the composer card, never the editor (that would raise the keyboard).
  await expect(composerCard(page)).toBeFocused()
  await expect(chatEditor(page)).not.toBeFocused()
})

test('allowing returns focus to the composer card too', async ({ page }) => {
  await launchChat(page, `[ASK:permission] ${LONG} allow`)
  const prompt = permissionPrompt(page)
  await expect(prompt).toBeVisible()
  await waitPastApprovalGuard(page)

  await prompt.getByRole('button', { name: 'Allow once' }).tap()

  await expect(prompt).toBeHidden()
  await expect.poll(() => answeredCount(page, 'permission allow-once')).toBe(1)
  await expect(composerCard(page)).toBeFocused()
})

test('a request with no options offers a touch-sized "Cancel request" that cancels it', async ({
  page
}) => {
  const sent = trackWsFrames(page)
  await launchChat(page, `[ASK:permission-none] ${LONG} no options`)
  const prompt = permissionPrompt(page)
  await expect(prompt).toBeVisible()
  const cancel = prompt.getByRole('button', { name: 'Cancel request' })
  await expect(cancel).toBeVisible()
  expect((await boxOf(cancel)).height).toBeGreaterThanOrEqual(44)
  await waitPastApprovalGuard(page)

  await cancel.tap()

  await expect(prompt).toBeHidden()
  await expect.poll(() => answeredCount(page, 'permission-none cancelled')).toBe(1)
  const responses = sent('respond_permission')
  expect(responses).toHaveLength(1)
  expect(responses[0].optionId ?? null).toBeNull()
})

test('focus the user already moved stays put when the permission resolves elsewhere', async ({
  page
}) => {
  await launchChat(page, `[ASK:permission] ${LONG} elsewhere`)
  await expect(permissionPrompt(page)).toBeVisible()

  // The user went back to the editor, then cancelled the turn (Escape), which
  // drops the pending request without them touching the prompt.
  const editor = chatEditor(page)
  await editor.tap()
  await expect(editor).toBeFocused()
  await page.keyboard.press('Escape')

  await expect(permissionPrompt(page)).toBeHidden()
  await expect.poll(() => answeredCount(page, 'permission cancelled')).toBe(1)
  await expect(editor).toBeFocused()
  await expect(composerCard(page)).not.toBeFocused()
})

// ---------------------------------------------------------------------------
// Question and elicitation
// ---------------------------------------------------------------------------

test('a question takes focus on its first option, answers with the choice and hands focus back', async ({
  page
}) => {
  await launchChat(page, `[ASK:question] ${LONG} question`)
  const question = page.getByRole('dialog', { name: 'Which test suite should run?' })
  await expect(question).toBeVisible()

  const unit = question.getByRole('button', { name: /^Unit tests/ })
  await expect(unit).toBeFocused()
  for (const button of [
    unit,
    question.getByRole('button', { name: /^End-to-end tests/ }),
    question.getByRole('button', { name: 'Submit' })
  ]) {
    expect((await boxOf(button)).height).toBeGreaterThanOrEqual(44)
  }
  // The stepper's header × is a compact icon control (36px on a coarse pointer).
  expect(
    (await boxOf(question.getByRole('button', { name: 'Cancel' }))).height
  ).toBeGreaterThanOrEqual(36)

  await unit.tap()
  await expect(unit).toHaveAttribute('aria-pressed', 'true')
  await question.getByRole('button', { name: 'Submit' }).tap()

  await expect(question).toBeHidden()
  await expect.poll(() => answeredCount(page, 'question unit')).toBe(1)
  await expect(composerCard(page)).toBeFocused()
})

test('an elicitation takes heading focus, shows an inline error beside its toast and then submits', async ({
  page
}) => {
  await launchChat(page, `[ASK:elicitation] ${LONG} elicitation`)
  const heading = page.getByRole('heading', { level: 2, name: 'Request from the agent' })
  await expect(heading).toBeVisible()
  await expect(heading).toBeFocused()

  const field = page.getByRole('textbox', { name: 'branch' })
  await expect(field).toHaveAttribute('aria-required', 'true')
  expect((await boxOf(field)).height).toBeGreaterThanOrEqual(44)
  expect(await fontSizeOf(field)).toBeGreaterThanOrEqual(16)
  for (const name of ['Cancel', 'Decline', 'Submit']) {
    expect(
      (await boxOf(page.getByRole('button', { name, exact: true }))).height
    ).toBeGreaterThanOrEqual(44)
  }
  // The other field kinds are touch-sized too: a select with 16px text (the
  // browser never zooms the page on focus) and a boolean as a switch row.
  const env = page.getByRole('combobox', { name: 'env' })
  expect((await boxOf(env)).height).toBeGreaterThanOrEqual(44)
  expect(await fontSizeOf(env)).toBeGreaterThanOrEqual(16)
  const verbose = page.getByRole('switch', { name: 'verbose' })
  await expect(verbose).toHaveAttribute('aria-checked', 'false')
  expect(
    (await boxOf(page.locator('label').filter({ has: verbose }))).height
  ).toBeGreaterThanOrEqual(44)
  await verbose.tap()
  await expect(verbose).toHaveAttribute('aria-checked', 'true')

  // Required field empty: the existing toast and an inline alert say the same thing.
  await page.getByRole('button', { name: 'Submit', exact: true }).tap()
  const alert = page.getByRole('alert')
  await expect(alert).toHaveText('branch is required.')
  await expect(page.getByText('branch is required.')).toHaveCount(2)
  // The toast stack follows the measured dock, so the toast ends above the
  // prompt instead of covering its buttons. It slides in from below: poll until
  // it settles. The intended gap is 12px; require at least 8.
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'branch is required.' })
  const promptTop = (await boxOf(page.locator('[data-approval-prompt^="elicitation:"]'))).y
  await expect
    .poll(async () => {
      const box = await boxOf(toast)
      return promptTop - (box.y + box.height)
    })
    .toBeGreaterThanOrEqual(8)
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  const alertId = await alert.getAttribute('id')
  expect(alertId).toBeTruthy()
  await expect(field).toHaveAttribute('aria-describedby', alertId as string)
  await expect(field).toBeFocused()

  // The error clears as soon as the field changes.
  await page.keyboard.insertText('main')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(field).not.toHaveAttribute('aria-invalid', /.*/)

  await page.getByRole('button', { name: 'Submit', exact: true }).tap()
  await expect(heading).toBeHidden()
  await expect.poll(() => answeredCount(page, 'elicitation accept')).toBe(1)
  await expect(composerCard(page)).toBeFocused()
})

// ---------------------------------------------------------------------------
// Keyboard up with an approval pending
// ---------------------------------------------------------------------------

test('with the keyboard up and an approval pending the plan and changed-files bars collapse, then show the user state', async ({
  page
}) => {
  await installFakeKeyboard(page)
  await launchChat(page, `[DOCK] [ASK:permission] ${LONG} keyboard`)
  const plan = page.getByRole('button', { name: /^Plan, 3 of 5 tasks/ })
  const files = page.getByRole('button', { name: 'Changed files 3 +17 −2', exact: true })
  await expect(permissionPrompt(page)).toBeVisible()

  // The user opens both bars, then the keyboard comes up.
  await plan.tap()
  await files.tap()
  await expect(plan).toHaveAttribute('aria-expanded', 'true')
  await expect(files).toHaveAttribute('aria-expanded', 'true')
  await setKeyboardHeight(page, 300)

  // Approval pending + keyboard: both render collapsed.
  await expect(plan).toHaveAttribute('aria-expanded', 'false')
  await expect(files).toHaveAttribute('aria-expanded', 'false')

  // A header tap during that window still flips the rendered state.
  await plan.tap()
  await expect(plan).toHaveAttribute('aria-expanded', 'true')
  await expect(files).toHaveAttribute('aria-expanded', 'false')

  // The focused approval button scrolls into view, nearest edge only.
  await waitPastApprovalGuard(page)
  await permissionPrompt(page).getByRole('button', { name: 'Allow once' }).tap()
  await expect(permissionPrompt(page)).toBeHidden()
  const scrolled = await page.evaluate(
    () => (window as unknown as { __scrolled: Array<{ text: string; block?: string }> }).__scrolled
  )
  expect(scrolled).toContainEqual(expect.objectContaining({ text: 'Allow once', block: 'nearest' }))

  // Approval resolved: each bar shows the user's last own state again, with the keyboard still up.
  await expect(plan).toHaveAttribute('aria-expanded', 'true')
  await expect(files).toHaveAttribute('aria-expanded', 'true')
})

// ---------------------------------------------------------------------------
// Desktop browser keeps the baseline
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

  test('keeps the baseline dock: plan open, no Git action, small immediate-tap options, no focus moves', async ({
    page
  }) => {
    const sent = trackWsFrames(page)
    await launchChat(page, `[DOCK] [ASK:permission] ${LONG} desktop`, { mouse: true })

    // Plan expanded from the start; changed-files header keeps its action names; no Git action.
    await expect(page.getByRole('button', { name: /^Plan, 3 of 5 tasks/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await expect(page.getByText('Cover login with tests')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Expand changed files' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Git changes', exact: true })).toHaveCount(0)

    // Permission prompt: baseline size, live region and no focus move.
    const prompt = permissionPrompt(page)
    await expect(prompt).toBeVisible()
    await expect(prompt).toHaveAttribute('aria-live', 'polite')
    const allow = prompt.getByRole('button', { name: 'Allow once' })
    expect((await boxOf(allow)).height).toBeLessThan(40)
    expect(await fontSizeOf(allow)).toBeLessThan(14)
    await expect(composerCard(page)).not.toBeFocused()

    // No guard on desktop: the first click answers at once, and focus is not moved.
    await allow.click()
    await expect(prompt).toBeHidden()
    await expect.poll(() => answeredCount(page, 'permission allow-once')).toBe(1)
    expect(sent('respond_permission')).toHaveLength(1)
    await expect(composerCard(page)).not.toBeFocused()
  })
})
