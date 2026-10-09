import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Locator, Page } from 'playwright/test'
import { expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * QA E2E for spec-mobile-text-field-zoom: iOS Safari zooms the page when a
 * text field under 16px takes focus, so on a coarse pointer every field the
 * phone shell mounts must be 16px or more, and a fine pointer must keep the
 * sizes it had.
 *
 * `mobile-text-field-zoom.spec.ts` sweeps computed font sizes across the
 * dialogs and sheets without touching a field. This file covers what that
 * sweep does not:
 *
 * - the moment of focus: the field is tapped (the event that makes iOS zoom),
 *   typed into, and still computes 16px with the page at scale 1;
 * - fields the sweep never mounts: the question stepper's "write your own
 *   response" input, the snapshot rename field, and the Create branch and
 *   Stash dialogs;
 * - the pointer-keyed contrast: the same phone-sized window with a mouse keeps
 *   `Input` at 14px on a landscape phone, where a touch screen gets 16px, and
 *   keeps the raw fields at the sizes they were written with;
 * - the viewport meta never locks pinch zoom (the rejected alternative).
 *
 * Not observable here: the iOS Safari zoom itself (Chromium never auto-zooms on
 * focus), so `visualViewport.scale` staying 1 is a sanity check, not the proof;
 * the proof is the 16px computed size on a `(pointer: coarse)` emulation.
 *
 * Every test registers its own throwaway git project (one commit and one
 * untracked file, so the Git changes sheet shows its composer and the Stash
 * button) and boots the phone shell on it.
 */

const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

const PORTRAIT = { width: 390, height: 844 }
const LANDSCAPE = { width: 844, height: 390 }

test.use({
  viewport: PORTRAIT,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  userAgent: ANDROID_USER_AGENT
})

test.setTimeout(120_000)

/** Server store key holding the web client's last selected project (issue #855). */
const ACTIVE_PROJECT_KEY = 'web-active-project'

/** The store outlives this file: put back the selection the suites before it left. */
let activeProjectBefore: unknown = null

test.beforeAll(async () => {
  const reply = await wsRequest<{ value?: unknown }>(E2E_BASE_URL, 'store_read', {
    key: ACTIVE_PROJECT_KEY
  })
  activeProjectBefore = reply?.value ?? null
})

test.afterAll(async () => {
  if (activeProjectBefore === null) {
    await wsRequest(E2E_BASE_URL, 'store_delete', { key: ACTIVE_PROJECT_KEY })
  } else {
    await wsRequest(E2E_BASE_URL, 'store_write', {
      key: ACTIVE_PROJECT_KEY,
      value: activeProjectBefore
    })
  }
})

const execFileAsync = promisify(execFile)

/**
 * Register a throwaway git project under the suite's workspace root and make
 * it the web client's active project, so the app boots straight into it. The
 * name is unique per call: terminal layouts and chats persist per project id.
 */
async function registerActiveProject(): Promise<string> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-zoomqa-${randomUUID().slice(0, 8)}`
  const id = `e2e-${name}`
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  const git = (...args: string[]): Promise<unknown> =>
    execFileAsync(
      'git',
      ['-c', 'user.email=e2e@termul', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', ...args],
      { cwd: path }
    )
  await git('init', '-q', '-b', 'main')
  await git('commit', '-q', '--allow-empty', '-m', 'init')
  await writeFile(join(path, 'notes.txt'), 'untracked\n')

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
    key: ACTIVE_PROJECT_KEY,
    value: { _version: 1, data: id }
  })
  return name
}

/**
 * Boot the phone shell on a fresh project. The empty pane's launcher, with its
 * agent loaded, is the last piece of the project's hydration.
 */
async function bootShell(page: Page, projectName: string): Promise<void> {
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN,
    { timeout: 60_000 }
  )
  await page.goto(`${E2E_BASE_URL}/#/`)
  await expect(page.getByRole('banner').getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: /, switch project$/ })).toContainText(projectName)
  await expect(
    page.getByRole('button', { name: 'Agent and model. Currently Fake Longrun' })
  ).toBeVisible()
}

/** How the test reaches a control: a touch tap on a coarse pointer, a click with a mouse. */
type Press = (target: Locator) => Promise<void>
const touch: Press = (target) => target.tap()
const mouse: Press = (target) => target.click()

/**
 * Boot the shell and prove the emulation is the one the test claims: the
 * pointer type, and whether `md:` (min-width 768px) applies. Without this a
 * test could pass on the wrong pointer.
 */
async function bootOn(
  page: Page,
  expected: { coarse: boolean; mdApplies: boolean }
): Promise<void> {
  await bootShell(page, await registerActiveProject())
  const media = await page.evaluate(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    fine: matchMedia('(pointer: fine)').matches,
    wide: matchMedia('(min-width: 768px)').matches
  }))
  expect(media.coarse, '(pointer: coarse) matches').toBe(expected.coarse)
  expect(media.fine, '(pointer: fine) matches').toBe(!expected.coarse)
  expect(media.wide, '(min-width: 768px) matches').toBe(expected.mdApplies)
}

/** Computed `font-size` of one element, in px. */
function fontSizeOf(field: Locator): Promise<number> {
  return field.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
}

/** Where the page stands while a field has focus: it must stay at scale 1 and un-panned. */
interface FocusReading {
  focused: boolean
  px: number
  scale: number
  panned: boolean
}

function readFocus(field: Locator): Promise<FocusReading> {
  return field.evaluate((element) => {
    const viewport = window.visualViewport
    return {
      focused: element === document.activeElement,
      px: Number.parseFloat(getComputedStyle(element).fontSize),
      scale: viewport?.scale ?? 1,
      panned: viewport ? viewport.offsetLeft !== 0 : false
    }
  })
}

/**
 * Take a field the way a person does, then type into it: the field must hold
 * focus at 16px or more with the page still at scale 1, and keep that size once
 * it holds text. A `<select>` takes focus but no text.
 */
async function expectSafeFocus(
  field: Locator,
  press: Press,
  label: string,
  options: { text?: string } = {}
): Promise<void> {
  await expect(field, `${label} is on screen`).toBeVisible()
  await press(field)
  await expect(field, `${label} takes focus`).toBeFocused()
  const focused = await readFocus(field)
  expect(focused.px, `${label}: font-size on focus`).toBeGreaterThanOrEqual(16)
  expect(focused.scale, `${label}: page scale on focus`).toBe(1)
  expect(focused.panned, `${label}: page panned on focus`).toBe(false)
  if (options.text === undefined) return
  await field.pressSequentially(options.text)
  // `toContain`, not equality: the rename field opens pre-filled with the snapshot name.
  await expect
    .poll(() => field.inputValue(), { message: `${label} holds the typed text` })
    .toContain(options.text)
  const typed = await readFocus(field)
  expect(typed.px, `${label}: font-size once it holds text`).toBeGreaterThanOrEqual(16)
  expect(typed.scale, `${label}: page scale once it holds text`).toBe(1)
}

/** Escape until the surface is gone: a focused inline field may take the first one. */
async function dismiss(page: Page, gone: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press('Escape')
    try {
      await expect(gone).toBeHidden({ timeout: 2_000 })
      return
    } catch {
      // The surface is still up; press Escape again.
    }
  }
  await expect(gone).toBeHidden()
}

// Openers: one small function per surface, because the header changes with the
// drawer and header PRs. Today the header's ⋯ sheet reaches the palette, the
// Files sheet and the Git changes sheet.

const PALETTE_INPUT = 'Search commands, projects, settings...'
const MORE_SHEET = '#mobile-header-more-sheet'

/** Open the header ⋯ sheet and press one of its rows; the sheet closes with it. */
async function chooseMoreRow(page: Page, press: Press, row: string): Promise<void> {
  await press(page.getByRole('banner').getByRole('button', { name: 'More', exact: true }))
  const sheet = page.locator(MORE_SHEET)
  await expect(sheet).toBeVisible()
  await press(sheet.getByRole('button', { name: row, exact: true }))
  await expect(sheet).toBeHidden()
}

async function openPalette(page: Page, press: Press): Promise<Locator> {
  await chooseMoreRow(page, press, 'Command palette')
  const input = page.getByPlaceholder(PALETTE_INPUT)
  await expect(input).toBeVisible()
  return input
}

async function runPaletteCommand(page: Page, press: Press, label: string): Promise<void> {
  await openPalette(page, press)
  await press(
    page
      .getByRole('option')
      .filter({ has: page.getByText(label, { exact: true }) })
      .first()
  )
  await expect(page.getByPlaceholder(PALETTE_INPUT)).toBeHidden()
}

/** The Files sheet with its "New file name" `ui/Input` revealed. */
async function openNewFileField(page: Page, press: Press): Promise<Locator> {
  await chooseMoreRow(page, press, 'Files')
  await press(page.getByRole('button', { name: 'New file', exact: true }))
  const field = page.getByLabel('New file name')
  await expect(field).toBeVisible()
  return field
}

async function openGitSheet(page: Page, press: Press): Promise<void> {
  await chooseMoreRow(page, press, 'Git changes')
  await expect(page.getByPlaceholder('Filter changes...')).toBeVisible()
  await expect(page.getByLabel('Commit summary')).toBeVisible()
}

/** The two viewports a phone has: `md:` only applies on the landscape one. */
const PHONES = [
  { label: 'portrait phone (390x844)', size: PORTRAIT, mdApplies: false },
  { label: 'landscape phone (844x390)', size: LANDSCAPE, mdApplies: true }
] as const

// ---------------------------------------------------------------------------
// The viewport meta
// ---------------------------------------------------------------------------

test('the viewport meta leaves pinch zoom available', async ({ page }) => {
  // The fix is the 16px field, not a zoom lock: `maximum-scale` or
  // `user-scalable=no` would stop iOS zooming on focus and also stop people zooming.
  await page.goto(`${E2E_BASE_URL}/`)
  const content = await page.locator('meta[name="viewport"]').getAttribute('content')
  expect(content, 'the page declares a viewport meta').toBeTruthy()
  expect(content).not.toMatch(/maximum-scale/i)
  expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/i)
})

// ---------------------------------------------------------------------------
// Touch: tap into a field, type, stay at 16px
// ---------------------------------------------------------------------------

for (const phone of PHONES) {
  test.describe(`touch focus, ${phone.label}`, () => {
    test.use({ viewport: phone.size })

    test('tapping into a field and typing keeps it at 16px with the page at scale 1', async ({
      page
    }) => {
      await bootOn(page, { coarse: true, mdApplies: phone.mdApplies })

      // Command palette: `CommandInput`.
      const palette = await openPalette(page, touch)
      await expectSafeFocus(palette, touch, 'Command palette search', { text: 'git' })
      await dismiss(page, palette)

      // Add project: the path and name fields (raw `text-sm` inputs).
      await runPaletteCommand(page, touch, 'New Project')
      await expectSafeFocus(page.getByPlaceholder('My Project'), touch, 'Add project name', {
        text: 'zoom-check'
      })
      await dismiss(page, page.getByPlaceholder('My Project'))

      // Files sheet: `ui/Input`, the field that dropped to 14px where `md:` applies.
      const newFile = await openNewFileField(page, touch)
      await expectSafeFocus(newFile, touch, 'Files sheet New file name', { text: 'zoom.md' })
      await dismiss(page, page.getByRole('button', { name: 'Refresh current folder' }))

      // Git changes sheet: the filter, the commit summary and the description.
      await openGitSheet(page, touch)
      await expectSafeFocus(page.getByPlaceholder('Filter changes...'), touch, 'Git filter', {
        text: 'notes'
      })
      await expectSafeFocus(page.getByLabel('Commit summary'), touch, 'Commit summary', {
        text: 'fix: keep fields at 16px'
      })
      await expectSafeFocus(page.getByLabel('Commit description'), touch, 'Commit description', {
        text: 'body text'
      })
    })

    test('the Create branch and Stash dialogs open onto 16px fields', async ({ page }) => {
      await bootOn(page, { coarse: true, mdApplies: phone.mdApplies })
      await openGitSheet(page, touch)

      // Stash: the header button is enabled because the project has an untracked file. The
      // keyboard opens it; the dialog's field is what this test measures, not how it was opened.
      await page.getByRole('button', { name: 'Stash changes' }).focus()
      await page.keyboard.press('Enter')
      const stashDialog = page.getByRole('dialog', { name: 'Stash Changes' })
      await expect(stashDialog).toBeVisible()
      await expectSafeFocus(
        stashDialog.getByPlaceholder('WIP on current branch...'),
        touch,
        'Stash message',
        { text: 'wip' }
      )
      await dismiss(page, stashDialog)

      // Create branch: the branch menu's first row.
      await touch(page.getByRole('button', { name: 'main', exact: true }))
      await touch(page.getByRole('menuitem', { name: 'Create new branch...' }))
      const branchDialog = page.getByRole('dialog', { name: 'Create New Branch' })
      await expect(branchDialog).toBeVisible()
      await expectSafeFocus(
        branchDialog.getByPlaceholder('e.g. feature/new-login'),
        touch,
        'Branch name',
        { text: 'feature/zoom' }
      )
    })

    test('the question stepper and the snapshot rename field are 16px', async ({ page }) => {
      await bootOn(page, { coarse: true, mdApplies: phone.mdApplies })

      // Snapshot rename: save a snapshot through the palette, then rename it on /snapshots.
      await runPaletteCommand(page, touch, 'Save Workspace Snapshot')
      const snapshotName = page.getByPlaceholder('Pre-deployment state')
      await expect(snapshotName).toBeVisible()
      await snapshotName.fill('zoom snapshot')
      await page.keyboard.press('Enter')
      await expect(snapshotName).toBeHidden()

      await page.goto(`${E2E_BASE_URL}/#/snapshots`)
      await expect(
        page.getByRole('heading', { level: 1, name: 'Workspace Snapshots' })
      ).toBeVisible()
      await expect(page.getByRole('heading', { level: 3, name: 'zoom snapshot' })).toBeVisible()
      await touch(page.getByRole('button', { name: 'Rename snapshot' }).first())
      await expectSafeFocus(
        page.getByRole('textbox', { name: 'Rename snapshot' }),
        touch,
        'Snapshot rename',
        { text: ' v2' }
      )
      await page.keyboard.press('Escape')
      await expect(page.getByRole('textbox', { name: 'Rename snapshot' })).toBeHidden()

      // Question stepper: an `[ELICIT]` turn makes the fake agent ask two questions.
      await page.goto(`${E2E_BASE_URL}/#/`)
      const launcher = page.locator('[data-composer-editor="true"][aria-label="Agent prompt"]')
      await expect(launcher).toHaveCount(1)
      await touch(launcher)
      await page.keyboard.type('color survey [ELICIT]')
      await page.keyboard.press('Enter')
      const questions = page.getByTestId('elicitation-questions')
      await expect(questions).toBeVisible({ timeout: 30_000 })

      const other = page.getByPlaceholder('Or write your own response')
      await expectSafeFocus(other, touch, 'Question 1 write-your-own', { text: 'purple' })
      await touch(page.getByTestId('elicitation-question-q0').getByRole('button', { name: /Red/ }))
      await expect(questions).toContainText('2 of 2')
      await expectSafeFocus(other, touch, 'Question 2 write-your-own', { text: 'my feature' })

      // Skip ends the held turn, so the fake agent does not wait out its timeout.
      await touch(page.getByRole('button', { name: 'Skip' }))
      await expect(questions).toBeHidden()
    })
  })
}

// ---------------------------------------------------------------------------
// Mouse: the same phone-sized window keeps the sizes it had
// ---------------------------------------------------------------------------

/** Sizes the fields were written with, which a fine pointer must keep (px). */
const FINE_POINTER_SIZES = {
  commandInput: 14, // `CommandInput` text-sm
  rawTextSm: 14, // the Add project fields, text-sm
  rawTextXs: 12 // the Git filter and commit fields, text-xs
} as const

for (const phone of PHONES) {
  test.describe(`mouse, ${phone.label}`, () => {
    // A mouse on a window this size: the same viewport as the touch tests, no touch input.
    test.use({
      viewport: phone.size,
      isMobile: false,
      hasTouch: false,
      userAgent: undefined
    })

    test('a fine pointer keeps the sizes the fields were written with', async ({ page }) => {
      await bootOn(page, { coarse: false, mdApplies: phone.mdApplies })

      const palette = await openPalette(page, mouse)
      expect(await fontSizeOf(palette), 'Command palette search').toBe(
        FINE_POINTER_SIZES.commandInput
      )
      await dismiss(page, palette)

      await runPaletteCommand(page, mouse, 'New Project')
      expect(await fontSizeOf(page.getByPlaceholder('My Project')), 'Add project name').toBe(
        FINE_POINTER_SIZES.rawTextSm
      )
      await dismiss(page, page.getByPlaceholder('My Project'))

      // `ui/Input` is `text-base md:text-sm`: 16px on a narrow window, 14px once `md:` applies.
      const newFile = await openNewFileField(page, mouse)
      expect(await fontSizeOf(newFile), 'Files sheet New file name').toBe(phone.mdApplies ? 14 : 16)
      await dismiss(page, page.getByRole('button', { name: 'Refresh current folder' }))

      await openGitSheet(page, mouse)
      expect(await fontSizeOf(page.getByPlaceholder('Filter changes...')), 'Git filter').toBe(
        FINE_POINTER_SIZES.rawTextXs
      )
      expect(await fontSizeOf(page.getByLabel('Commit summary')), 'Commit summary').toBe(
        FINE_POINTER_SIZES.rawTextXs
      )
      expect(await fontSizeOf(page.getByLabel('Commit description')), 'Commit description').toBe(
        FINE_POINTER_SIZES.rawTextXs
      )
    })
  })
}
