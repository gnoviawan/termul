import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile terminal key bar E2E (spec-mobile-terminal-key-bar): a phone-sized
 * browser drives a REAL shell through the web client's mobile shell and
 * checks what jsdom cannot — measured 44px hit areas, the wrap layout at
 * 390px, focus staying in xterm when a bar control is tapped (so the
 * on-screen keyboard stays up), and the bytes each key puts on the
 * `/terminal/ws` wire.
 *
 * Every test registers its own project (fresh terminal layout, no state
 * shared with other suites) and opens its own terminal from the drawer.
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

/** Names in on-screen order: the toggle, Paste, then the nine keys. */
const BAR_BUTTONS = [
  'Show/hide key bar',
  'Paste',
  'Esc, escape',
  'Tab',
  'Ctrl+C, interrupt',
  'Left arrow',
  'Up arrow',
  'Down arrow',
  'Right arrow',
  'PgUp, page up',
  'PgDn, page down'
] as const

/** Each key's accessible name and the bytes it must write to the PTY. */
const KEY_SEQUENCES = [
  ['Esc, escape', '\u001b'],
  ['Tab', '\t'],
  ['Ctrl+C, interrupt', '\u0003'],
  ['Left arrow', '\u001b[D'],
  ['Up arrow', '\u001b[A'],
  ['Down arrow', '\u001b[B'],
  ['Right arrow', '\u001b[C'],
  ['PgUp, page up', '\u001b[5~'],
  ['PgDn, page down', '\u001b[6~']
] as const

const KEY_NAMES = KEY_SEQUENCES.map(([name]) => name)

/**
 * Register a throwaway project under the suite's workspace root and make it
 * the web client's active project, so the app boots straight into it. The
 * name is unique per call: terminal layouts persist per project id, so a
 * reused id (e.g. under --repeat-each) would restore an earlier test's shell.
 */
async function registerActiveProject(): Promise<string> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-keybar-${randomUUID().slice(0, 8)}`
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
  await wsRequest(E2E_BASE_URL, 'store_write', {
    key: 'web-active-project',
    value: { _version: 1, data: id }
  })
  return name
}

/**
 * Collects what the page writes to the PTY over `/terminal/ws`. xterm's own
 * focus reports (`ESC [ I` / `ESC [ O`, emitted when a shell enables focus
 * reporting) are not input, so they are left out.
 */
function trackPtyWrites(page: Page): { sent: () => string[]; clear: () => void } {
  const writes: string[] = []
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/terminal/ws')) return
    socket.on('framesent', (frame) => {
      const message = JSON.parse(String(frame.payload)) as {
        type?: string
        payload?: { data?: string }
      }
      const data = message.payload?.data
      if (message.type !== 'write' || data === undefined) return
      if (data === '\u001b[I' || data === '\u001b[O') return
      writes.push(data)
    })
  })
  return { sent: () => [...writes], clear: () => writes.splice(0) }
}

interface TerminalBar {
  group: Locator
  input: Locator
  button: (name: string) => Locator
}

/**
 * Resolves once the app's boot-time agent warm-up has settled: the empty
 * launcher spawns the agent and creates a draft session, and that session
 * creation re-activates the pane. A terminal opened BEFORE it lands is
 * swapped out from under the key bar (a test-only race: a person needs
 * seconds to reach the drawer). An agent that fails to start also ends the
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
 * Boot the mobile shell on the fresh project, open a new terminal from the
 * drawer and put the cursor in xterm (the state a phone user is in when the
 * on-screen keyboard is up).
 */
async function openTerminalWithBar(page: Page): Promise<TerminalBar> {
  const warmedUp = watchAgentWarmup(page)
  const projectName = await registerActiveProject()
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  // The header names the active project until a terminal takes over: seeing
  // it proves the shell booted into our fresh project.
  await expect(
    page.getByRole('heading', { level: 1, name: projectName, exact: true })
  ).toBeVisible()
  await warmedUp
  await page.getByRole('button', { name: 'Open menu' }).tap()
  await page.getByRole('button', { name: 'New terminal' }).tap()

  const group = page.getByRole('group', { name: 'Terminal keys' })
  await expect(group).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Terminal input' })
  await input.focus()
  await expect(input).toBeFocused()
  return { group, input, button: (name) => group.getByRole('button', { name, exact: true }) }
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

test('key bar is one labelled group holding the toggle, Paste and the nine keys in order', async ({
  page
}) => {
  const bar = await openTerminalWithBar(page)

  await expect(bar.group.getByRole('button')).toHaveCount(BAR_BUTTONS.length)
  for (const name of BAR_BUTTONS) {
    await expect(bar.button(name)).toHaveCount(1)
    await expect(bar.button(name)).toBeVisible()
  }
  // The spoken names, in on-screen (DOM) order.
  const names = await bar.group
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
  expect(names.slice(0, 1)).toEqual(['Show/hide key bar'])
  expect(names.slice(2)).toEqual([...KEY_NAMES])
  await expect(bar.group.getByRole('button', { name: 'Paste' })).toBeVisible()

  // The toggle controls the group and reports the expanded state.
  const toggle = bar.button('Show/hide key bar')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const groupId = await bar.group.getAttribute('id')
  expect(groupId).toBeTruthy()
  await expect(toggle).toHaveAttribute('aria-controls', groupId as string)
})

test('every control is at least 44px, the bar wraps inside the viewport and hit areas never overlap', async ({
  page
}) => {
  const bar = await openTerminalWithBar(page)
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')

  const boxes: Box[] = []
  for (const name of BAR_BUTTONS) {
    const box = await boxOf(bar.button(name))
    // Layout units are CSS px; 44px is the touch-target floor.
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44)
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44)
    // #859: nothing is pushed off-screen — the keys wrap instead of scrolling.
    expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(viewport.width)
    expect(box.y + box.height, `${name} bottom edge`).toBeLessThanOrEqual(viewport.height)
    boxes.push(box)
  }

  // Wrapped into exactly two rows at 390px: toggle/Paste/Esc/Tab/Ctrl+C/Left
  // on the first, the rest on the second.
  const rowTops = new Set(boxes.map((box) => Math.round(box.y)))
  expect(rowTops.size).toBe(2)

  // 44px buttons at gap-1 do not touch: hit areas must not overlap.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const overlaps =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      expect(overlaps, `${BAR_BUTTONS[i]} overlaps ${BAR_BUTTONS[j]}`).toBe(false)
    }
  }

  // No horizontal scroll anywhere on the page or inside the group.
  const overflow = await page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Terminal keys"]')
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      group: group ? group.scrollWidth - group.clientWidth : -1
    }
  })
  expect(overflow.page).toBeLessThanOrEqual(0)
  expect(overflow.group).toBeLessThanOrEqual(0)
})

test('keys stay reachable on the narrowest phones (320px) without horizontal scroll', async ({
  page
}) => {
  const bar = await openTerminalWithBar(page)
  await page.setViewportSize({ width: 320, height: 640 })

  for (const name of BAR_BUTTONS) {
    await expect(bar.button(name)).toBeVisible()
    const box = await boxOf(bar.button(name))
    expect(box.x, `${name} left edge`).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(320)
    expect(box.y + box.height, `${name} bottom edge`).toBeLessThanOrEqual(640)
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44)
  }
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(pageOverflow).toBeLessThanOrEqual(0)
})

test('tapping each key writes its escape sequence to the terminal and xterm keeps focus', async ({
  page
}) => {
  const pty = trackPtyWrites(page)
  const bar = await openTerminalWithBar(page)
  pty.clear()

  for (const [name] of KEY_SEQUENCES) {
    await bar.button(name).tap()
    // A key tap must not pull focus out of xterm (the OSK would drop).
    await expect(bar.input).toBeFocused({ timeout: 3_000 })
  }

  await expect.poll(() => pty.sent()).toEqual(KEY_SEQUENCES.map(([, sequence]) => sequence))
})

test('a mouse click on a key behaves like a tap: same bytes, focus stays in xterm', async ({
  page
}) => {
  const pty = trackPtyWrites(page)
  const bar = await openTerminalWithBar(page)
  pty.clear()

  await bar.button('Ctrl+C, interrupt').click()
  await expect(bar.input).toBeFocused({ timeout: 3_000 })
  await expect.poll(() => pty.sent()).toEqual(['\u0003'])
})

test('Paste writes the clipboard text to the terminal without dropping xterm focus', async ({
  page,
  context
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const pty = trackPtyWrites(page)
  const bar = await openTerminalWithBar(page)
  const pasted = 'echo keybar-paste-e2e'
  await page.evaluate((text) => navigator.clipboard.writeText(text), pasted)
  pty.clear()

  await bar.button('Paste').tap()

  await expect.poll(() => pty.sent()).toEqual([pasted])
  await expect(bar.input).toBeFocused({ timeout: 3_000 })
})

test('Paste with an empty clipboard writes nothing', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const pty = trackPtyWrites(page)
  const bar = await openTerminalWithBar(page)
  await page.evaluate(() => navigator.clipboard.writeText(''))
  pty.clear()

  await bar.button('Paste').tap()
  // The (empty) read settles well within the round trips of the taps that
  // follow, so those keys are the only frames the terminal ever sees.
  await bar.button('Tab').tap()
  await bar.button('Esc, escape').tap()

  await expect.poll(() => pty.sent()).toEqual(['\t', '\u001b'])
})

test('Paste shows the existing error toast when the clipboard cannot be read', async ({
  page,
  context
}) => {
  // No clipboard-read grant: the browser denies readText().
  await context.clearPermissions()
  const pty = trackPtyWrites(page)
  const bar = await openTerminalWithBar(page)
  pty.clear()

  await bar.button('Paste').tap()

  await expect(page.getByText(/^Clipboard read failed: /)).toBeVisible()
  expect(pty.sent()).toEqual([])

  // The toast stack follows the measured bar (`--mobile-dock-height`), so the
  // toast ends above the bar's top edge instead of covering the top key row. It
  // slides in from below: poll until it settles. The intended gap is 12px
  // (plus the bar's top padding above the group); require at least 8.
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Clipboard read failed: ' })
  const groupTop = (await boxOf(bar.group)).y
  await expect
    .poll(async () => {
      const box = await boxOf(toast)
      return groupTop - (box.y + box.height)
    })
    .toBeGreaterThanOrEqual(8)
})

test('the toggle collapses the nine keys, keeps the toggle and Paste, and restores them', async ({
  page
}) => {
  const bar = await openTerminalWithBar(page)
  const toggle = bar.button('Show/hide key bar')
  const expandedBarHeight = (await boxOf(bar.group)).height

  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  for (const name of KEY_NAMES) {
    await expect(bar.button(name)).toBeHidden()
  }
  await expect(bar.group).toBeVisible()
  await expect(toggle).toBeVisible()
  await expect(bar.button('Paste')).toBeVisible()
  // The bar drops from two rows to one, and xterm still has the cursor.
  expect((await boxOf(bar.group)).height).toBeLessThan(expandedBarHeight)
  await expect(bar.input).toBeFocused({ timeout: 3_000 })

  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  for (const name of KEY_NAMES) {
    await expect(bar.button(name)).toBeVisible()
  }
  expect((await boxOf(bar.group)).height).toBe(expandedBarHeight)
  await expect(bar.input).toBeFocused({ timeout: 3_000 })
})

/**
 * Make the server refuse every PTY write that carries `refusedData`, at the
 * wire: a real failed write needs a dead PTY, which no shell dies on cue
 * across platforms. The reply is the protocol's own failure frame, so the
 * app handles it exactly as it would a server-side refusal.
 */
async function refuseTerminalWrites(page: Page, refusedData: string): Promise<void> {
  await page.routeWebSocket(/\/terminal\/ws$/, (client) => {
    const server = client.connectToServer()
    client.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { id?: string; type?: string; payload?: unknown }
      const data = (frame.payload as { data?: string } | undefined)?.data
      if (frame.type === 'write' && data === refusedData) {
        client.send(
          JSON.stringify({
            id: frame.id,
            success: false,
            error: 'pty is gone (e2e)',
            code: 'WRITE_FAILED'
          })
        )
        return
      }
      server.send(message)
    })
    server.onMessage((message) => client.send(message))
  })
}

test('a refused key write shows the existing write-failure toast', async ({ page }) => {
  await refuseTerminalWrites(page, '\u0003')
  const bar = await openTerminalWithBar(page)

  await bar.button('Ctrl+C, interrupt').tap()

  await expect(page.getByText('Terminal write failed: pty is gone (e2e)')).toBeVisible()
})

test('a refused paste write shows the existing paste-failure toast', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const pasted = 'echo keybar-refused-paste'
  await refuseTerminalWrites(page, pasted)
  const bar = await openTerminalWithBar(page)
  await page.evaluate((text) => navigator.clipboard.writeText(text), pasted)

  await bar.button('Paste').tap()

  await expect(page.getByText('Paste failed: pty is gone (e2e)')).toBeVisible()
})

// Hygiene: every test opens a shell, and the server caps live PTYs (30 per
// process). Close ours so a suite that grows past this file never starves
// later specs of terminal slots.
test.afterEach(async ({ page }) => {
  const close = page.getByRole('button', { name: 'Close terminal' })
  if ((await close.count()) === 0) return
  await close.tap()
  await page
    .locator('[data-sibling-dialog]')
    .getByRole('button', { name: 'Close', exact: true })
    .tap()
  await expect(page.getByRole('group', { name: 'Terminal keys' })).toBeHidden()
})
