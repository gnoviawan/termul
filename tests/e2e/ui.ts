import { expect, type Page } from 'playwright/test'
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
  // Wait for the Rail's project list to load (projects fetched + auth
  // accepted). A Rail restored collapsed lists projects as icons only, so a
  // collapsed Rail counts as loaded too.
  await page
    .locator('[aria-label^="Project: proj-"], nav[aria-label="Projects"][data-expanded="false"]')
    .first()
    .waitFor({ state: 'visible' })
}

/** Select a project in the Rail. */
export async function selectProject(page: Page, name: string): Promise<void> {
  // Prefix match: the active project's label carries an " (active)" suffix.
  // Click the icon column: hovering the row reveals its settings gear over
  // the name, and with status marks showing the gear sits at the row's center.
  await page
    .locator(`[aria-label^="Project: ${cssEscape(name)}"]`)
    .first()
    .locator('[data-rail-icon-column]')
    .click()
  // Wait for the Rail to mark it active (the workspace restore follows).
  await page
    .locator(`[aria-label^="Project: ${cssEscape(name)} (active)"]`)
    .first()
    .waitFor({ state: 'visible' })
  await page.waitForTimeout(1_000)
}

/**
 * Open the New project modal from the Rail's Projects `+` menu (desktop
 * shell, Rail expanded).
 */
export async function openRailNewProjectModal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add project or folder group' }).click()
  await page.getByRole('menuitem', { name: 'New project' }).click()
}

/**
 * Select a Side panel Column tab (Chats, Explorer or Changes) and wait until
 * it is selected. The last tab is remembered per project, so a spec that needs
 * a specific one selects it instead of assuming the default.
 */
export async function selectColumnTab(
  page: Page,
  name: 'Chats' | 'Explorer' | 'Changes' | 'GitHub'
): Promise<void> {
  const tab = page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', {
    name: new RegExp(`^${name}`)
  })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

/**
 * The Chats list card whose aria-label starts with `title` (the active
 * project's chats, closed ones included). Select the Chats tab first.
 */
export function chatCard(page: Page, title: string) {
  return page.locator(`button[data-chat-card-index][aria-label^="${cssEscape(title)}"]`).first()
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
  // Retry the Side panel's New chat button: on a pane with an active chat the
  // first click can race the launcher overlay mount (observed as a flake).
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    try {
      await composer.waitFor({ state: 'visible', timeout: 5_000 })
      break
    } catch {
      if (attempt === 2) throw new Error('Agent launcher composer never appeared')
    }
  }
  // The launcher shows its composer before the selected agent is ready, and
  // keeps it non-editable ("Composer unavailable") until then.
  await expect(composer).toHaveAttribute('contenteditable', 'true')
  await composer.click()
  await page.keyboard.type(prompt)
  await expect(composer).toHaveText(prompt)
  await page.keyboard.press('Enter')
  // The chat tab's aria-label is the session title (= the first prompt text).
  await chatTab(page, prompt).waitFor({ state: 'visible' })
}

/**
 * Wait for an agent-chat tab whose aria-label starts with `title`.
 * Scoped to the tab bar's draggable rows (`[draggable="true"]`) — the Chats
 * list cards and chat surfaces reuse the same aria-label text.
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
