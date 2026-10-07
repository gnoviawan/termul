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

// ---------------------------------------------------------------------------
// Route-scoped closed-chat signal (reload chat-route UX fix).
//
// `requestCloseAgentChat` (both the tab bar and the mobile drawer path)
// releases the chat and removes the workspace tab WITHOUT clearing the
// `#/c/<sessionId>` route or removing the lingering `status: 'closed'`
// acp-store record — and it can fire while the mount-time
// `openHistorySession` is still in flight (so `openingHistoryIds` cannot
// distinguish the user's close from the reload open). ChatRoute needs one
// synchronous, route-scoped "this chat was closed while its route was
// current" signal that is independent of store timing.
//
// This is that signal: a module-level Set. `requestCloseAgentChat` marks the
// session on every user-initiated close; ChatRoute consults it on re-runs
// (never on the mount run — that is the reload path itself) and clears the
// mark when the session id changes (a new route target must re-open).
// Module-level (not a store) deliberately: it is chat-close plumbing shared
// by the idle-shutdown hook and the route component, not UI state.

/** Sessions the user closed while their chat route stayed current. */
const routeClosedChatSessions = new Set<string>()

/**
 * The chat-route session the URL currently points at (`#/c/<sessionId>`),
 * or null on a non-chat route. Reading the live hash (not a React route
 * hook) so non-component callers — the idle-shutdown interval — see the
 * CURRENT route without prop threading.
 */
function routeChatSessionId(): string | null {
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  const match = hash.match(/^#\/c\/(.+)$/)
  return match?.[1] ?? null
}

/**
 * Mark a chat closed on its own route (ChatRoute must not resurrect it).
 * Only marks when the close happens while the route is STILL on this
 * session — a delayed close (finishClosingChats after a busy turn ends)
 * that fires after the user navigated away must not leave a stale mark
 * that suppresses legitimate reactivation when they later return.
 */
export function markChatClosedOnRoute(sessionId: string): void {
  if (routeChatSessionId() !== sessionId) return
  routeClosedChatSessions.add(sessionId)
}

/**
 * Whether the user closed this chat while its route stayed current. The
 * mark is consumed by the caller (ChatRoute reads it on re-runs); a new
 * mount on a different session clears stale marks via
 * `clearChatClosedOnRoute` when the route target changes.
 */
export function isChatClosedOnRoute(sessionId: string): boolean {
  return routeClosedChatSessions.has(sessionId)
}

/** Clear the closed-on-route mark (route target changed or chat re-opened). */
export function clearChatClosedOnRoute(sessionId: string): void {
  routeClosedChatSessions.delete(sessionId)
}
