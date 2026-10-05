/**
 * Chat-notification decision helpers (issue #853, browser notifications).
 *
 * Pure predicates — no DOM/store access, no Notification calls — so the
 * notify/skip policy is unit-testable in isolation (the acceptance criteria
 * for #853: "backgrounded + turn finished → notify; focused → no notify").
 * `use-chat-notifications.ts` wires these to the acp-store events and calls
 * `sendDesktopNotification` (which branches Tauri plugin vs Web Notifications
 * API — a permission denial is a no-op there, so gating here only needs the
 * "should we notify at all" half).
 *
 * Gate: notify only when the user is NOT already looking at the chat —
 * either the document is hidden (page backgrounded, phone locked, another
 * window focused) or the session is not the visible chat. While the user is
 * watching, an OS notification is spam (the in-app card/spinner is the UX).
 *
 * Web Push (locked/backgrounded phones, VAPID, sw.js `push` handler) is NOT
 * in this slice — see the issue's proposal §2; deferred with the secure
 * context note: `Notification` requires a secure context (HTTPS or
 * localhost), so plain-HTTP LAN / `0.0.0.0` deployments get no notifications
 * at all (the send path no-ops).
 */

/**
 * Whether a chat notification is warranted for a session event.
 *
 * `pageHidden`: `document.hidden` — the tab/window is not visible at all.
 * `sessionVisible`: the session is the chat the user currently sees (the
 * active/visible chat surface). Notify when either condition says the user
 * is not watching: page hidden OR the session not visible. Do not notify
 * when the page is visible AND the session is the visible chat.
 */
export function shouldNotifyForChatEvent(input: {
  pageHidden: boolean
  sessionVisible: boolean
}): boolean {
  return input.pageHidden || !input.sessionVisible
}

/**
 * Whether a finished turn should notify. A turn that ended because the user
 * cancelled it needs no ping — the user is by definition at the controls.
 * Every other stop reason (`end_turn`, `max_tokens`, `refusal`, errors, …)
 * means the agent produced something worth looking at.
 */
export function shouldNotifyForTurnEnd(input: {
  pageHidden: boolean
  sessionVisible: boolean
  stopReason: string
}): boolean {
  if (input.stopReason === 'cancelled') return false
  return shouldNotifyForChatEvent(input)
}

/** Truncate and sanitize a string for OS notification title/body display. */
export function sanitizeNotificationText(text: string, maxLength = 64): string {
  const sanitized = text.replace(/[\r\n]+/g, ' ').trim()
  if (sanitized.length <= maxLength) return sanitized
  return `${sanitized.slice(0, maxLength - 1)}…`
}
