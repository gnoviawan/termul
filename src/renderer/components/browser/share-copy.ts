/**
 * Copy for the "Share to chat" surfaces: the in-pane consent strip and the
 * composer chips. Only host-supplied fields (origin, scopes, expiry, status)
 * are shown, never the page title or text, which the page controls.
 */

import type {
  BrowserShareErrorCode,
  BrowserShareScope,
  BrowserShareStatus
} from '@/lib/browser-share-api'

const SCOPE_LABELS: Record<BrowserShareScope, string> = {
  content: 'Page content',
  screenshot: 'Screenshot',
  console_errors: 'Console errors',
  network_failures: 'Failed requests'
}

const SCOPE_DETAILS: Record<BrowserShareScope, string> = {
  content: 'Accessibility snapshot, address and title',
  screenshot: 'An image of what this tab shows',
  console_errors: 'Error messages from this page',
  network_failures: 'Failure kind and status code only'
}

export function browserShareScopeLabel(scope: BrowserShareScope): string {
  return SCOPE_LABELS[scope]
}

export function browserShareScopeDetail(scope: BrowserShareScope): string {
  return SCOPE_DETAILS[scope]
}

/** e.g. `Page content · Console errors`. */
export function browserShareScopeSummary(scopes: readonly BrowserShareScope[]): string {
  return scopes.map((s) => SCOPE_LABELS[s]).join(' · ')
}

export const BROWSER_SHARE_SCREENSHOT_WARNING =
  'A screenshot shows everything visible in this tab, including personal or secret data.'

export const BROWSER_SHARE_NETWORK_NOTE = 'Never headers, cookies, request bodies or query strings.'

export const BROWSER_SHARE_LIFETIME_NOTE =
  'Read only. Sharing stops when you stop it, when it expires, or when the page changes.'

const ENDED_LABELS: Record<Exclude<BrowserShareStatus, 'active'>, string> = {
  expired: 'Expired',
  revoked: 'Stopped',
  navigated: 'Page changed, share again',
  closed: 'Tab closed'
}

/** Remaining time or the reason a share ended, e.g. `8 min left`. */
export function browserShareStatusLabel(
  status: BrowserShareStatus,
  expiresAtMs: number,
  nowMs: number
): string {
  if (status !== 'active') return ENDED_LABELS[status]
  const leftMs = expiresAtMs - nowMs
  if (leftMs <= 0) return ENDED_LABELS.expired
  const minutes = Math.ceil(leftMs / 60_000)
  return minutes <= 1 ? 'Less than 1 min left' : `${minutes} min left`
}

const ERROR_MESSAGES: Record<BrowserShareErrorCode, string> = {
  UNSUPPORTED: 'Sharing a browser tab is only available in the desktop app.',
  UNAVAILABLE: 'Sharing a browser tab is not available in this version yet.',
  ORIGIN_CHANGED: 'The page changed to another site. Check it and share again.',
  TAB_NOT_FOUND: 'This tab is no longer open.',
  NOT_FOUND: 'This share already ended.',
  INVALID_RESPONSE: 'Could not share this tab. Try again.',
  FAILED: 'Could not share this tab. Try again.'
}

export function browserShareErrorMessage(code: BrowserShareErrorCode): string {
  return ERROR_MESSAGES[code]
}
