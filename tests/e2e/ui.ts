import type { Page } from 'playwright/test'
import { E2E_BASE_URL, E2E_TOKEN } from './helpers'

/**
 * Page-level helpers for the termul-server web client E2E suite.
 *
 * The web auth token is seeded via the `#token=` fragment bootstrap (the
 * production first-visit flow): one goto to the fragment URL persists the
 * token to localStorage, then the app is used from `/#/`.
 */

/**
 * Bootstrap the auth token then land on the workspace root. Waits for the
 * token to actually land in localStorage (a fixed sleep races slow boots —
 * the token gate would then show instead of the workspace).
 */
export async function openWorkspace(page: Page): Promise<void> {
  await page.goto(`${E2E_BASE_URL}/#token=${E2E_TOKEN}`)
  await page.waitForFunction(
    (token) => localStorage.getItem('termul.webAuthToken') === token,
    E2E_TOKEN
  )
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

/**
 * Count of streamed chunk markers currently visible in the page body.
 * `chunk-N` markers are word-bounded (`chunk-10` is NOT a `chunk-1` match).
 */
export async function visibleChunkCount(page: Page): Promise<number> {
  const text = await page.locator('body').innerText()
  return (text.match(/\bchunk-\d+\b/g) ?? []).length
}

function cssEscape(text: string): string {
  return text.replace(/["\\]/g, '\\$&')
}
