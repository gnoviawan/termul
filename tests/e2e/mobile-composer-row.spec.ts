import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Locator, type Page, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN } from './helpers'

/**
 * Mobile composer row E2E (termul-server web client on a phone).
 *
 * Covers spec-mobile-composer-row.md in a REAL browser, where the jsdom unit
 * tests cannot reach: layout on a 390 / 360 / 320px phone viewport, the focus
 * order of the "Add to chat" sheet (Radix focus trap, synchronous editor focus
 * from a tap), the picker opening from a tap (user activation), the nested
 * SelectorModal over the sheet, `dvh` height caps, system Back and the toast
 * clearance above the composer.
 *
 * Every test creates its OWN project (a directory whose name carries the
 * `composer-row-e2e` marker) and launches its own chat through the phone shell,
 * so no test depends on another suite's or test's state. The fake agent
 * (fake-longrun-agent.ts) answers `session/new` for a marker cwd with two modes
 * plus a model and a thought-level option, and a `[USAGE]` prompt reports
 * context-window usage so the ring renders.
 *
 * Not automated here (unit tests own them): a closed session (`disabled`) —
 * reaching it needs an agent crash, whose surface depends on a teardown race
 * (see crash-recovery.spec.ts) — and MCP server rows, which need a reachable
 * MCP server. The attachment PREVIEW also needs an agent that advertises
 * embedded-context; the fake advertises none, so the attach test asserts the
 * picker and the composer's capability toast instead.
 */

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  locale: 'en-US',
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'
})

test.setTimeout(120_000)

/** Marker the fake agent looks for in the `session/new` cwd. */
const CWD_MARKER = 'composer-row-e2e'
const AGENT = 'Fake Longrun'
const MODEL_CHIP = `Model: Opus 5.5 (${AGENT})`
const VIEWPORT_HEIGHT = 844
/** A file in every project, for the @ mention menu to find. */
const MENTION_TARGET = 'mention-target.md'

const createdProjectIds: string[] = []

test.afterEach(async ({ request }) => {
  // Best effort: the throwaway server and workspace are reaped by global teardown.
  for (const id of createdProjectIds.splice(0)) {
    await request
      .delete(`${E2E_BASE_URL}/projects/${id}`, {
        headers: { Authorization: `Bearer ${E2E_TOKEN}` }
      })
      .catch(() => {})
  }
})

async function createProject(api: APIRequestContext, slug: string): Promise<string> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT unset — run under tests/e2e global-setup')
  // Unique per call: chats persist per project id, so a reused id (for example
  // under --repeat-each) would restore an earlier run's chat.
  const unique = `${slug}-${randomUUID().slice(0, 6)}`
  const path = join(root, `${CWD_MARKER}-${unique}`)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, MENTION_TARGET), '# mention target\n')
  const id = `e2e-proj-row-${unique}`
  const name = `row-${unique}`
  const res = await api.post(`${E2E_BASE_URL}/projects`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'content-type': 'application/json' },
    data: { id, name, path, color: 'blue' }
  })
  if (!res.ok()) throw new Error(`project registration failed: ${res.status()}`)
  createdProjectIds.push(id)
  return name
}

/**
 * Phone flow: open the workspace, switch to a fresh project through the
 * "Switch project" sheet, and launch a chat from the empty-pane launcher. Ready
 * once the chat's one-row composer shows the model chip.
 */
async function openChat(
  page: Page,
  api: APIRequestContext,
  slug: string,
  prompt: string
): Promise<void> {
  const projectName = await createProject(api, slug)
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
  await page.goto(`${E2E_BASE_URL}/#/`)

  await page.getByRole('button', { name: 'Switch project' }).tap()
  await page.getByRole('button', { name: projectName, exact: true }).tap()
  await expect(page.getByRole('heading', { name: projectName, exact: true })).toBeVisible()

  const launcher = page.locator('[data-composer-editor="true"][aria-label="Agent prompt"]')
  // The project switch swaps the pane tree: wait until only the new launcher is left.
  await expect(launcher).toHaveCount(1)
  await launcher.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: MODEL_CHIP })).toBeVisible()
}

const composerCard = (page: Page): Locator => page.locator('[data-chat-composer="true"]')
const toolbarRow = (page: Page): Locator =>
  composerCard(page).locator('[data-composer-toolbar-row="mobile"]')
/** `includeHidden`: Radix marks the composer aria-hidden while a sheet or modal is open. */
const editorOf = (page: Page): Locator =>
  composerCard(page).getByRole('textbox', { includeHidden: true })
/** The + trigger. `includeHidden`: Radix marks everything outside an open sheet aria-hidden. */
const addButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Add to chat', includeHidden: true })
const addSheet = (page: Page): Locator => page.getByRole('dialog', { name: 'Add to chat' })
/**
 * The @ file menu: a listbox of files, or its empty/loading label while the file
 * index has nothing to show yet (which of the two depends on how far the index
 * walk got, so both count as open). The two never render together.
 */
const mentionMenu = (page: Page): Locator =>
  page
    .getByRole('listbox')
    .or(page.getByText(/^(Searching files…|No files match\. Try another name\.)$/))
const contextRing = (page: Page): Locator =>
  page.getByRole('button', { name: /^Context \d+ percent used$/ })

async function boxOf(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no layout box')
  return box
}

/** The row holds exactly these buttons, in this DOM order. */
async function expectControls(row: Locator, names: string[]): Promise<void> {
  const buttons = row.getByRole('button')
  await expect(buttons).toHaveCount(names.length)
  for (const [index, name] of names.entries()) {
    await expect(buttons.nth(index)).toHaveAccessibleName(name)
  }
}

async function openAddSheet(page: Page): Promise<void> {
  await addButton(page).tap()
  await expect(addSheet(page)).toBeVisible()
}

/** Open the sheet and tap one action row; resolves once the sheet is fully gone. */
async function tapSheetAction(page: Page, name: string): Promise<void> {
  await openAddSheet(page)
  await addSheet(page).getByRole('button', { name, exact: true }).tap()
  // The closed sheet stays mounted until its exit animation ends.
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function clearDraft(page: Page): Promise<void> {
  await editorOf(page).tap()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await expect(editorOf(page)).toHaveText('')
}

/**
 * Put a draft into the editor with ONE input event (a tap to focus, then an
 * insert). The editor reports every change to React state, and the Send/Queue
 * handlers read that state, so a draft typed key by key can be tapped away
 * before its last keystrokes are committed (the message then goes out missing
 * its tail). One insert has a single commit, and the Send/Queue button only
 * becomes enabled in that same commit, so awaiting the button is a state-based
 * signal that the whole draft is captured.
 */
async function enterDraft(page: Page, text: string): Promise<void> {
  await editorOf(page).tap()
  await page.keyboard.insertText(text)
  await expect(editorOf(page)).toHaveText(text)
}

test('lays the composer out as one row: +, model, mode, context ring, send', async ({
  page,
  request
}) => {
  await openChat(page, request, 'layout', '[USAGE] [DURATION:2] layout check')
  const row = toolbarRow(page)
  await expect(row).toHaveCount(1)
  // The turn is over: the last control is the (disabled, empty draft) Send button.
  await expect(row.getByRole('button', { name: 'Send message' })).toBeDisabled()
  await expect(contextRing(page)).toBeVisible()

  await expectControls(row, [
    'Add to chat',
    MODEL_CHIP,
    'Default',
    'Context 28 percent used',
    'Send message'
  ])

  // The two-row and single-row desktop layouts and their controls are gone.
  await expect(
    page.locator(
      '[data-composer-toolbar-row="1"], [data-composer-toolbar-row="2"], [data-composer-toolbar-row="single"]'
    )
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Attach files' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /MCP servers/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Switch agent/ })).toHaveCount(0)
  await expect(page.locator('[data-chat-composer-context-strip]')).toHaveCount(0)

  // One visual line: every control shares a centre line and nothing spills sideways.
  const controls = await row.getByRole('button').all()
  expect(controls).toHaveLength(5)
  const boxes = await Promise.all(controls.map(boxOf))
  const centres = boxes.map((b) => b.y + b.height / 2)
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(3)
  expect((await boxOf(row)).height).toBeLessThanOrEqual(48)
  for (const b of boxes) expect(b.x + b.width).toBeLessThanOrEqual(390)
  // The + keeps the 44px touch floor.
  const plus = await boxOf(addButton(page))
  expect(plus.width).toBeGreaterThanOrEqual(44)
  expect(plus.height).toBeGreaterThanOrEqual(44)
})

test('the model chip and mode chip open dvh-capped pickers', async ({ page, request }) => {
  await openChat(page, request, 'pickers', '[USAGE] [DURATION:2] picker check')

  // The chip shows the agent glyph and the model name; the agent name lives
  // only in the accessible name.
  const modelChip = page.getByRole('button', { name: MODEL_CHIP })
  await expect(modelChip).toContainText('Opus 5.5')
  await expect(modelChip).not.toContainText(AGENT)
  await expect(modelChip.locator('svg').first()).toBeVisible()
  await modelChip.tap()
  const modelPicker = page.getByRole('dialog', { name: 'Model' })
  await expect(modelPicker).toBeVisible()
  await expect(modelPicker).toHaveClass(/max-h-\[80dvh\]/)
  await expect(modelPicker).not.toHaveClass(/max-h-\[80vh\]/)
  await expect(modelPicker).toHaveCSS('max-height', `${VIEWPORT_HEIGHT * 0.8}px`)
  await modelPicker.getByRole('button', { name: 'Sonnet 5.5' }).tap()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Model: Sonnet 5.5 (${AGENT})` })).toBeFocused()

  await page.getByRole('button', { name: 'Default', exact: true }).tap()
  const modePicker = page.getByRole('dialog', { name: 'Agent' })
  await expect(modePicker).toBeVisible()
  await expect(modePicker).toHaveCSS('max-height', `${VIEWPORT_HEIGHT * 0.8}px`)
  await expect(modePicker.getByRole('button', { name: 'Default' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(modePicker.getByRole('button', { name: 'Plan' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Default', exact: true })).toBeFocused()
})

test('the + sheet lists its sections and dismisses back to the + button', async ({
  page,
  request
}) => {
  await openChat(page, request, 'sheet', '[USAGE] [DURATION:2] sheet check')

  await editorOf(page).tap()
  await expect(editorOf(page)).toBeFocused()
  await openAddSheet(page)
  const sheet = addSheet(page)
  // Tapping + hands the keyboard back: the editor is blurred.
  await expect(editorOf(page)).not.toBeFocused()

  await expect(sheet).toHaveClass(/max-h-\[85dvh\]/)
  await expect(sheet).toHaveClass(/overflow-y-auto/)
  await expect(sheet).toHaveClass(/overscroll-contain/)
  await expect(sheet).toHaveCSS('max-height', `${VIEWPORT_HEIGHT * 0.85}px`)
  await expect(sheet.getByRole('button', { name: 'Attach files' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Mention file' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Commands' })).toBeVisible()
  await expect(sheet.getByRole('heading', { name: 'Chat options' })).toBeVisible()
  await expect(
    sheet.getByRole('button', { name: `Switch agent. Currently ${AGENT}` })
  ).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Medium' })).toBeVisible()
  await expect(sheet.getByRole('heading', { name: 'MCP servers' })).toBeVisible()
  await expect(sheet.getByText('No servers attached yet.')).toBeVisible()
  await expect(sheet.getByText('Takes effect on the next chat.')).toHaveCount(0)
  // The sheet sits at the bottom edge of the phone and never outgrows it.
  // (Poll: it is still sliding in right after it becomes visible.)
  await expect
    .poll(async () => {
      const box = await boxOf(sheet)
      return box.y + box.height
    })
    .toBeCloseTo(VIEWPORT_HEIGHT, 0)
  expect((await boxOf(sheet)).height).toBeLessThanOrEqual(VIEWPORT_HEIGHT * 0.85 + 1)

  // Dismiss by ✕, Escape and system back: focus returns to + each time.
  await sheet.getByRole('button', { name: 'Close' }).tap()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(addButton(page)).toBeFocused()

  await openAddSheet(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(addButton(page)).toBeFocused()

  await openAddSheet(page)
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(addButton(page)).toBeFocused()
})

test('Mention file focuses the editor with an @ trigger and opens the file menu', async ({
  page,
  request
}) => {
  await openChat(page, request, 'mention', '[USAGE] [DURATION:2] mention check')
  const editor = editorOf(page)

  // Empty draft: the bare @ opens the file menu.
  await tapSheetAction(page, 'Mention file')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('@')
  await expect(mentionMenu(page)).toBeVisible()
  // Still focused once the sheet's own focus restore has settled.
  await expect(editor).toBeFocused()
  // Keystrokes land in the editor and drive the open menu down to a file.
  await page.keyboard.type('mention-t')
  const option = page.getByRole('option', { name: MENTION_TARGET })
  await expect(option).toBeVisible()
  await option.tap()
  await expect(editor).toContainText(MENTION_TARGET)

  // A draft without a trailing space gets one before the trigger.
  await clearDraft(page)
  await page.keyboard.type('fix the bug')
  await tapSheetAction(page, 'Mention file')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('fix the bug @')
  await expect(mentionMenu(page)).toBeVisible()

  // A draft already ending in whitespace does not get a second one.
  await clearDraft(page)
  await page.keyboard.type('fix ')
  await tapSheetAction(page, 'Mention file')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('fix @')
  await expect(mentionMenu(page)).toBeVisible()
})

test('Commands focuses the editor with a / trigger and opens the slash menu', async ({
  page,
  request
}) => {
  await openChat(page, request, 'commands', '[USAGE] [DURATION:2] commands check')
  const editor = editorOf(page)

  await tapSheetAction(page, 'Commands')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('/')
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect(editor).toBeFocused()

  await clearDraft(page)
  await page.keyboard.type('hello')
  await tapSheetAction(page, 'Commands')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('hello /')
  await expect(page.getByRole('listbox')).toBeVisible()
})

test('Attach files opens the picker from the tap and closes the sheet', async ({
  page,
  request
}) => {
  await openChat(page, request, 'attach', '[USAGE] [DURATION:2] attach check')
  await openAddSheet(page)

  // The picker has to open synchronously from the tap (user activation), or the
  // browser never shows the chooser.
  const chooserOpened = page.waitForEvent('filechooser')
  await addSheet(page).getByRole('button', { name: 'Attach files' }).tap()
  const chooser = await chooserOpened
  expect(chooser.isMultiple()).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(addButton(page)).toBeFocused()

  // The chosen file reaches the composer. The fake agent advertises no embedded
  // context, so the composer answers with its capability toast.
  await chooser.setFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello')
  })
  await expect(page.getByText("This agent can't embed files", { exact: false })).toBeVisible()
})

test('the toast stack sits above the composer card', async ({ page, request }) => {
  await openChat(page, request, 'toast', '[USAGE] [DURATION:2] toast check')
  await openAddSheet(page)
  const chooserOpened = page.waitForEvent('filechooser')
  await addSheet(page).getByRole('button', { name: 'Attach files' }).tap()
  const chooser = await chooserOpened
  await chooser.setFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello')
  })

  const toast = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: "This agent can't embed files" })
  await expect(toast).toBeVisible()
  const cardTop = (await boxOf(composerCard(page))).y
  // The toast slides in from below: poll until it settles clear of the card's
  // top edge instead of covering the composer. The offset is measured from the
  // viewport bottom, so this only holds if it counts the 24px StatusBar that
  // the mobile shell renders under the chat pane (a 136px offset left the toast
  // 12px inside the card). The intended gap is 12px; require at least 8.
  await expect
    .poll(async () => {
      const box = await boxOf(toast)
      return box.y + box.height
    })
    .toBeLessThanOrEqual(cardTop - 8)
  // ...and keeps its width: the object offset only lifts the bottom edge.
  const toastBox = await boxOf(toast)
  expect(toastBox.x).toBeGreaterThanOrEqual(0)
  expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(390)
  expect(toastBox.width).toBeGreaterThan(300)
})

test('a chip in the sheet opens its picker over the sheet and returns focus to the chip', async ({
  page,
  request
}) => {
  await openChat(page, request, 'nested', '[USAGE] [DURATION:2] nested check')
  await openAddSheet(page)

  await addSheet(page).getByRole('button', { name: 'Medium' }).tap()
  const picker = page.getByRole('dialog', { name: 'Thinking Level' })
  await expect(picker).toBeVisible()
  await expect(picker).toHaveCSS('max-height', `${VIEWPORT_HEIGHT * 0.8}px`)
  // The + sheet stays open beneath the picker (hidden from the a11y tree only).
  await expect(page.getByRole('dialog', { name: 'Add to chat', includeHidden: true })).toBeVisible()

  await picker.getByRole('button', { name: 'High' }).tap()
  await expect(picker).toBeHidden()
  await expect(addSheet(page)).toBeVisible()
  await expect(addSheet(page).getByRole('button', { name: 'High' })).toBeFocused()

  // Escape closes only the picker; a second Escape closes the sheet.
  await addSheet(page).getByRole('button', { name: 'High' }).tap()
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden()
  await expect(addSheet(page)).toBeVisible()
  await expect(addSheet(page).getByRole('button', { name: 'High' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(addButton(page)).toBeFocused()
})

test('the context ring opens a details sheet and returns focus to the ring', async ({
  page,
  request
}) => {
  await openChat(page, request, 'ring', '[USAGE] [DURATION:2] ring check')
  await contextRing(page).tap()
  const details = page.getByRole('dialog', { name: 'Context window' })
  await expect(details).toBeVisible()
  await expect(details).toHaveClass(/max-h-\[85dvh\]/)
  // The same lines the desktop popover shows (the sheet title replaces its heading).
  await expect(details.getByText('28% conversation used')).toBeVisible()
  await expect(details.getByText('50K / 180K tokens')).toBeVisible()
  await expect(details.getByText('130K remaining')).toBeVisible()
  await expect(details.getByText('Total in context: 70K / 200K')).toBeVisible()
  await expect(details.getByText('Reported cost')).toBeVisible()
  await expect(details.getByText('$0.0421')).toBeVisible()
  await expect(details.getByText('Reported by agent')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(contextRing(page)).toBeFocused()

  // System back closes it too.
  await contextRing(page).tap()
  await expect(details).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(contextRing(page)).toBeFocused()
})

test('Send message dispatches the draft once the turn is idle', async ({ page, request }) => {
  await openChat(page, request, 'send', '[DURATION:2] send check')
  const row = toolbarRow(page)
  await expect(row.getByRole('button', { name: 'Send message' })).toBeDisabled()

  await enterDraft(page, 'second message')
  const send = row.getByRole('button', { name: 'Send message' })
  await expect(send).toBeEnabled()
  await send.tap()

  await expect(page.getByText('second message')).toBeVisible()
  await expect(editorOf(page)).toHaveText('')
  // The new turn is running: the button became Stop.
  await expect(row.getByRole('button', { name: 'Cancel turn' })).toBeVisible()
})

test('a running turn queues a draft and cancels on an empty draft; no ring without usage', async ({
  page,
  request
}) => {
  await openChat(page, request, 'busy', 'busy check')
  const row = toolbarRow(page)
  // No usage reported: no ring (and no empty gap where it would be).
  await expect(contextRing(page)).toHaveCount(0)
  await expectControls(row, ['Add to chat', MODEL_CHIP, 'Default', 'Cancel turn'])

  // Draft text on a busy turn: the button queues.
  await enterDraft(page, 'queued note')
  const queue = row.getByRole('button', { name: 'Queue message' })
  await expect(queue).toBeEnabled()
  await queue.tap()
  await expect(page.getByText('queued note')).toBeVisible()
  await expect(editorOf(page)).toHaveText('')

  // Empty draft on a busy turn: the button cancels.
  const cancel = row.getByRole('button', { name: 'Cancel turn' })
  await expect(cancel).toBeVisible()
  await cancel.tap()
  await expect(page.getByText(/\[CANCELLED after \d+ chunks\]/)).toBeVisible()
})

for (const width of [360, 320]) {
  test(`stays one row at ${width}px with the mode label icon-only`, async ({ page, request }) => {
    await openChat(page, request, `narrow-${width}`, '[USAGE] [DURATION:2] narrow check')
    const row = toolbarRow(page)
    // All five controls must be on the row before it is measured: the ring only
    // appears once the agent has reported usage.
    await expect(contextRing(page)).toBeVisible()
    const modeChip = page.getByRole('button', { name: 'Default', exact: true })
    const modeLabel = modeChip.getByText('Default', { exact: true })
    // At 390px and still at 361px the mode label is visible text...
    expect((await boxOf(modeLabel)).width).toBeGreaterThan(20)
    await page.setViewportSize({ width: 361, height: VIEWPORT_HEIGHT })
    await expect(modeChip).toBeVisible()
    expect((await boxOf(modeLabel)).width).toBeGreaterThan(20)

    // ...and it collapses once the pane is 360px or narrower.
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT })
    // The label collapses to screen-reader-only text; the accessible name stays.
    await expect.poll(async () => (await boxOf(modeLabel)).width).toBeLessThanOrEqual(2)
    await expect(modeChip).toBeVisible()

    const controls = await row.getByRole('button').all()
    expect(controls).toHaveLength(5)
    const boxes = await Promise.all(controls.map(boxOf))
    const centres = boxes.map((b) => b.y + b.height / 2)
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(3)
    expect((await boxOf(row)).height).toBeLessThanOrEqual(48)
    // Nothing overlaps and the send button stays on the phone's screen.
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 1)
    }
    const last = boxes[boxes.length - 1]
    expect(last.x + last.width).toBeLessThanOrEqual(width)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
  })
}
