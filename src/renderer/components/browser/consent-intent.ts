/**
 * Shared user-facing copy for the agent browser-automation consent surfaces
 * (spec-acp-browser-automation-v2 CAP-5): the in-pane `BrowserConsentStrip`
 * and the in-chat `BrowserConsentCard` render the same title, agent summary,
 * and action intent so the prompt reads identically wherever it surfaces.
 */

/** Title for both consent surfaces. */
export const BROWSER_CONSENT_TITLE = 'Allow browser automation?'

/** Generic actor when the requesting agent's live id is unmapped. */
export const BROWSER_CONSENT_ACTOR = 'The agent'

/**
 * Agent-stated intent suffix, e.g. ` — it wants to navigate "Search button"`.
 */
export function browserConsentIntent(action: string, element?: string): string {
  return element ? ` — it wants to ${action} "${element}"` : ` — it wants to ${action}`
}

/**
 * One-line summary naming the requesting agent, e.g. `Claude wants to drive
 * this app's browser for this session — it wants to navigate.`.
 */
export function browserConsentSummary(
  agentName: string | undefined,
  action: string,
  element?: string
): string {
  return `${agentName ?? BROWSER_CONSENT_ACTOR} wants to drive this app's browser for this session${browserConsentIntent(action, element)}.`
}

/**
 * Sanitized DOM id for the card's `aria-labelledby` target. The requestId is
 * host-generated, but strip non-alphanumeric characters defensively so the
 * id is always a valid HTML/CSS identifier.
 */
export function browserConsentTitleId(requestId: string): string {
  const safe = requestId.replace(/[^a-zA-Z0-9-]/g, '')
  return `browser-consent-title-${safe}`
}
