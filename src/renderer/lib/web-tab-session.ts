/**
 * Tab↔session focus pointer for the browser / web client (architecture D6).
 *
 * Architecture D6 asked for "single-session per tab" without rewriting
 * `acp-store`. The store remains a global multi-session Zustand map with
 * `activeSessionId` as an in-process UI convenience (especially desktop /
 * prepared-chat reaping). Cross-tab isolation uses this module instead:
 *
 * - Storage: `sessionStorage` (per browser tab; survives refresh; fresh on new tab)
 * - Desktop / Tauri MAY ignore this for now (Stories 1.6 / 1.8 decide wiring)
 *
 * Do NOT treat `acp-store.activeSessionId` as the cross-tab isolation boundary.
 */

const STORAGE_KEY = 'termul.web.focusedSessionId'

function canUseSessionStorage(): boolean {
  try {
    return typeof sessionStorage !== 'undefined'
  } catch {
    // Accessing sessionStorage can throw in sandboxed / privacy-restricted contexts.
    return false
  }
}

/** Focused ACP session id for this browser tab, or null if unset. */
export function getTabFocusedSessionId(): string | null {
  if (!canUseSessionStorage()) return null
  try {
    const value = sessionStorage.getItem(STORAGE_KEY)
    return value && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** Persist (or clear) the focused session id for this browser tab. */
export function setTabFocusedSessionId(sessionId: string | null): void {
  if (!canUseSessionStorage()) return
  try {
    if (sessionId === null || sessionId === '') {
      sessionStorage.removeItem(STORAGE_KEY)
    } else {
      sessionStorage.setItem(STORAGE_KEY, sessionId)
    }
  } catch {
    // Ignore quota / private-mode failures — focus is best-effort.
  }
}

/** Clear the focused session pointer for this tab. */
export function clearTabFocusedSessionId(): void {
  setTabFocusedSessionId(null)
}

/** Storage key constant — exported for tests and diagnostics. */
export const WEB_TAB_FOCUSED_SESSION_KEY = STORAGE_KEY
