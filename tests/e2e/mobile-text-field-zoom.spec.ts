import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Locator, Page } from 'playwright/test'
import { chromium, expect, request, test } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN, wsRequest } from './helpers'

/**
 * Mobile text-field zoom E2E (spec-mobile-text-field-zoom): iOS Safari zooms
 * the page when a text field under 16px takes focus, so every text-entry
 * control the phone shell mounts must compute `font-size` of 16px or more on a
 * coarse pointer. jsdom has no cascade, so this measures computed styles in a
 * real browser, once on a portrait phone (390x844) and once on a landscape
 * phone (844x390, where `md:` applies and `ui/Input` used to drop to 14px).
 *
 * One boot per viewport on a throwaway project that is a git repo with one
 * commit and one untracked file (so the Git changes sheet shows its composer).
 * Each surface is opened, measured and closed before the next.
 */

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

/**
 * Playwright's bundled Chromium is the default. A machine that never ran
 * `playwright install chromium` falls back to the system Chrome;
 * E2E_BROWSER_CHANNEL forces a channel (for example `msedge`).
 */
const browserChannel =
  process.env.E2E_BROWSER_CHANNEL || (existsSync(chromium.executablePath()) ? undefined : 'chrome')

test.use({ channel: browserChannel })

test.setTimeout(240_000)

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
 * name is unique per call: terminal layouts persist per project id.
 */
async function registerActiveProject(): Promise<string> {
  const root = process.env.E2E_WORKSPACE_ROOT
  if (!root) throw new Error('E2E_WORKSPACE_ROOT not set (global-setup)')
  const name = `proj-fieldzoom-${randomUUID().slice(0, 8)}`
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
 * Boot the mobile shell on a fresh git project. The empty pane's launcher, with
 * its agent loaded, is the last piece of the project's hydration; measuring
 * earlier would race the workspace restore.
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

interface FieldReading {
  label: string
  tag: string
  px: number
}

const BASELINE_KEY = '__fieldZoomBaseline'
const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"]'

/** Remember every field on the clean shell, so a surface is measured by what it adds. */
async function markBaseline(page: Page): Promise<void> {
  await page.evaluate(
    ({ key, selector }) => {
      const seen = new WeakSet<Element>()
      for (const element of Array.from(document.querySelectorAll(selector))) seen.add(element)
      ;(window as unknown as Record<string, WeakSet<Element>>)[key] = seen
    },
    { key: BASELINE_KEY, selector: FIELD_SELECTOR }
  )
}

/**
 * The visible text-entry controls a surface added to the shell: non-text input
 * types, `aria-hidden` or `tabindex="-1"` elements (Radix bubble selects) and
 * anything without a client rect (the xterm helper) are left out. `scope`
 * narrows the search to one section of the surface.
 */
async function readFields(page: Page, scope?: string): Promise<FieldReading[]> {
  return page.evaluate(
    ({ key, selector, scopeSelector }) => {
      const nonText = [
        'checkbox',
        'radio',
        'range',
        'file',
        'hidden',
        'button',
        'submit',
        'reset',
        'image',
        'color'
      ]
      const baseline = (window as unknown as Record<string, WeakSet<Element> | undefined>)[key]
      const root = scopeSelector ? document.querySelector(scopeSelector) : document
      if (!root) return []
      const readings: { label: string; tag: string; px: number }[] = []
      for (const element of Array.from(root.querySelectorAll(selector))) {
        if (baseline?.has(element)) continue
        if (element instanceof HTMLInputElement && nonText.includes(element.type)) continue
        if (element.getAttribute('aria-hidden') === 'true') continue
        if (element.getAttribute('tabindex') === '-1') continue
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        const label =
          element.getAttribute('aria-label') ||
          element.getAttribute('placeholder') ||
          element.id ||
          element.getAttribute('name') ||
          element.className.toString().slice(0, 60)
        readings.push({
          label,
          tag: element.tagName.toLowerCase(),
          px: Number.parseFloat(getComputedStyle(element).fontSize)
        })
      }
      return readings
    },
    { key: BASELINE_KEY, selector: FIELD_SELECTOR, scopeSelector: scope }
  )
}

/** Every control on the surface is 16px or more, and the surface contributed at least `min`. */
async function expectSixteenPx(
  page: Page,
  surface: string,
  min: number,
  scope?: string
): Promise<void> {
  const fields = await readFields(page, scope)
  expect
    .soft(fields.length, `${surface}: text-entry controls on screen (${JSON.stringify(fields)})`)
    .toBeGreaterThanOrEqual(min)
  const small = fields
    .filter((field) => field.px < 16)
    .map((field) => `${field.tag} "${field.label}" is ${field.px}px`)
  expect.soft(small, `${surface}: controls under 16px`).toEqual([])
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

// Openers: one small function per surface, because the header changes with
// the drawer and header PRs. Today the header's ⋯ sheet reaches the palette,
// the Files sheet and the Git changes sheet.

const PALETTE_INPUT = 'Search commands, projects, settings...'
const MORE_SHEET = '#mobile-header-more-sheet'

/** Open the header ⋯ sheet and tap one of its rows; the sheet closes with the tap. */
async function chooseMoreRow(page: Page, row: string): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: 'More', exact: true }).tap()
  const sheet = page.locator(MORE_SHEET)
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: row, exact: true }).tap()
  await expect(sheet).toBeHidden()
}

async function openPalette(page: Page): Promise<void> {
  await chooseMoreRow(page, 'Command palette')
  await expect(page.getByPlaceholder(PALETTE_INPUT)).toBeVisible()
}

async function runPaletteCommand(page: Page, label: string): Promise<void> {
  await openPalette(page)
  await page
    .getByRole('option')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first()
    .tap()
  await expect(page.getByPlaceholder(PALETTE_INPUT)).toBeHidden()
}

async function openFilesSheet(page: Page): Promise<void> {
  await chooseMoreRow(page, 'Files')
  await page.getByRole('button', { name: 'New file', exact: true }).tap()
  await expect(page.getByLabel('New file name')).toBeVisible()
}

async function openGitSheet(page: Page): Promise<void> {
  await chooseMoreRow(page, 'Git changes')
  await expect(page.getByPlaceholder('Filter changes...')).toBeVisible()
  await expect(page.getByLabel('Commit summary')).toBeVisible()
}

/** Every inventory surface on the shell, each measured while on screen. */
async function checkEverySurface(page: Page, landscape: boolean): Promise<void> {
  await bootShell(page, await registerActiveProject())

  // The test must observe the surface it claims to: a coarse pointer, and `md:` on a landscape phone.
  const media = await page.evaluate(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    wide: matchMedia('(min-width: 768px)').matches
  }))
  expect(media.coarse, '(pointer: coarse) matches in the emulation').toBe(true)
  expect(media.wide, '(min-width: 768px) matches only on the landscape phone').toBe(landscape)

  // What is on the shell already (the composer) is measured here, then left out of each surface.
  await expectSixteenPx(page, 'Shell', 0)
  await markBaseline(page)

  // Command palette.
  await openPalette(page)
  await expectSixteenPx(page, 'Command palette', 1)
  await dismiss(page, page.getByPlaceholder(PALETTE_INPUT))

  // Add project, with Advanced options open for the two selects.
  await runPaletteCommand(page, 'New Project')
  await expect(page.getByPlaceholder('My Project')).toBeVisible()
  await page.getByText('Advanced options').tap()
  await expect(page.getByText('Project Template')).toBeVisible()
  await expectSixteenPx(page, 'Add project', 3)
  await dismiss(page, page.getByPlaceholder('My Project'))

  // Save Workspace Snapshot.
  await runPaletteCommand(page, 'Save Workspace Snapshot')
  await expect(page.getByPlaceholder('Pre-deployment state')).toBeVisible()
  await expectSixteenPx(page, 'Save Workspace Snapshot', 2)
  await dismiss(page, page.getByPlaceholder('Pre-deployment state'))

  // Command History.
  await runPaletteCommand(page, 'Command History')
  await expect(page.getByPlaceholder('Search commands...')).toBeVisible()
  // Escape is handled by the search field's own key handler, so it must hold focus.
  await expect(page.getByPlaceholder('Search commands...')).toBeFocused()
  await expectSixteenPx(page, 'Command History', 1)
  await dismiss(page, page.getByPlaceholder('Search commands...'))

  // Theme picker.
  await runPaletteCommand(page, 'Change Color Theme')
  await expect(page.getByLabel('Search themes')).toBeVisible()
  await expectSixteenPx(page, 'Theme picker', 1)
  await dismiss(page, page.getByLabel('Search themes'))

  // App Preferences: the search field, then the four categories with native selects.
  await runPaletteCommand(page, 'App Preferences')
  const preferences = page.getByRole('dialog', { name: 'Application Preferences' })
  await expect(preferences).toBeVisible()
  const categories = [
    ['appearance', 'Terminal Appearance'],
    ['shell', 'Default Shell'],
    ['behavior', 'Behavior'],
    ['ai-agents', 'AI Agents']
  ] as const
  for (const [id, name] of categories) {
    await preferences
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name, exact: true })
      .tap()
    await expectSixteenPx(page, `App Preferences > ${name}`, 1, `[data-settings-section="${id}"]`)
  }
  await expectSixteenPx(page, 'App Preferences', 1)
  // Escape cannot close Preferences: its Shortcuts section keeps a `data-shortcut-recorder` in the
  // DOM, and `SettingsModal` yields Escape to one. Use the dialog's own close button.
  await preferences.getByRole('button', { name: 'Close Application Preferences' }).tap()
  await expect(preferences).toBeHidden()

  // Project Settings.
  await runPaletteCommand(page, 'Project Settings')
  const projectSettings = page.getByRole('dialog', { name: 'Project Settings' })
  await expect(projectSettings).toBeVisible()
  await expectSixteenPx(page, 'Project Settings', 1)
  await projectSettings.getByRole('button', { name: 'Close Project Settings' }).tap()
  await expect(projectSettings).toBeHidden()

  // Files sheet, with the New file field open.
  await openFilesSheet(page)
  await expectSixteenPx(page, 'Files sheet', 1)
  // The inline field cancels on its own Escape, so wait for the sheet itself to close.
  await dismiss(page, page.getByRole('button', { name: 'Refresh current folder' }))

  // Git changes sheet: filter, commit summary and description.
  await openGitSheet(page)
  await expectSixteenPx(page, 'Git changes sheet', 3)
  await dismiss(page, page.getByPlaceholder('Filter changes...'))
}

test.describe('portrait phone (390x844)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent: USER_AGENT
  })

  test('every text field on the phone shell is 16px or more', async ({ page }) => {
    await checkEverySurface(page, false)
  })
})

test.describe('landscape phone (844x390)', () => {
  test.use({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent: USER_AGENT
  })

  test('every text field stays 16px or more where md: applies', async ({ page }) => {
    await checkEverySurface(page, true)
  })
})
