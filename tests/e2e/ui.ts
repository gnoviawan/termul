import type { Page } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN } from './helpers'

/**
 * Page-level helpers for the termul-server web client E2E suite.
 *
 * The web auth token is seeded via the `#token=` fragment bootstrap (the
 * production first-visit flow): one goto to the fragment URL persists the
 * token to localStorage, then the app is used from `/#/`.
 */

export const TOKEN_STORAGE_KEY = 'termul/web-auth-token'

/** Bootstrap the auth token then land on the workspace root. */
export async function openWorkspace(page: Page): Promise<void> {
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForTimeout(500)
  await page.goto(`${E2E_BASE_URL}/#/`)
  // Wait for the project sidebar to load (projects fetched + auth accepted).
  await page.locator('[aria-label^="Project: proj-"]').first().waitFor({ state: 'visible' })
}

/** Select a project in the sidebar. */
export async function selectProject(page: Page, name: string): Promise<void> {
  // Prefix match: the active project's label carries an " (active)" suffix.
  await page
    .locator(`[aria-label^="Project: ${cssEscape(name)}"]`)
    .first()
    .click()
  // Wait for the sidebar to mark it active (the workspace restore follows).
  await page
    .locator(`[aria-label^="Project: ${cssEscape(name)} (active)"]`)
    .first()
    .waitFor({ state: 'visible' })
  await page.waitForTimeout(1_000)
}

/**
 * Start a NEW chat in the active project through the Agent launcher dialog
 * (deterministic: the launcher's composer always launches a fresh chat,
 * while an already-open chat's composer would QUEUE the prompt to that
 * session's running turn).
 * Resolves when the chat tab appears (the placeholder turns into a real
 * session tab once `create_session` completes).
 */
export async function launchChat(page: Page, prompt: string): Promise<void> {
  // The launcher composer carries aria-label "Agent prompt" (the open chat's
  // composer does not) — works for both the overlay dialog and the
  // empty-pane launcher.
  const composer = page.locator('[data-composer-editor="true"][aria-label="Agent prompt"]').first()
  // Retry the rail button: on a pane with an active chat the first click can
  // race the launcher overlay mount (observed as a flake).
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator('[aria-label="New agent chat"]').first().click()
    try {
      await composer.waitFor({ state: 'visible', timeout: 5_000 })
      break
    } catch {
      if (attempt === 2) throw new Error('Agent launcher composer never appeared')
    }
  }
  await composer.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  // The chat tab's aria-label is the session title (= the first prompt text).
  await chatTab(page, prompt).waitFor({ state: 'visible' })
}

/**
 * Wait for an agent-chat tab whose aria-label starts with `title`.
 * Scoped to the tab bar's draggable rows (`[draggable="true"]`) — the
 * sidebar's history rows and chat surfaces reuse the same aria-label text.
 */
export function chatTab(page: Page, title: string) {
  return page.locator(`[draggable="true"][aria-label^="${cssEscape(title)}"]`).first()
}

export function expectTabTitled(page: Page, title: string) {
  return chatTab(page, title).waitFor({ state: 'visible' })
}

/**
 * Wait until the chat's transcript (message list region) contains `text`.
 * Chat messages render in the agent-chat pane; matching against body text
 * keeps this robust across markup changes.
 */
export function expectTranscript(page: Page, text: string) {
  return page.locator('body', { hasText: text }).first()
}

/** The "Working" tab status (turn in flight) on a chat tab. */
export async function tabShowsWorking(page: Page, title: string): Promise<boolean> {
  const label = await chatTab(page, title).getAttribute('aria-label')
  return label?.includes('Working') ?? false
}

/** The chat panel's turn status text (spinner row) — "Working…" while busy. */
export function turnStatus(page: Page) {
  return page.getByText('Working…', { exact: false })
}

function cssEscape(text: string): string {
  return text.replace(/["\\]/g, '\\$&')
}
