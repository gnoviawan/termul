/**
 * Web auth token source of truth for the browser client (CAP-1 interim,
 * QA remediation Story 1).
 *
 * A gated `termul-server` (public bind or explicit `--web-auth-token`)
 * requires one bearer token on the `/ws` `authenticate` handshake,
 * `/terminal/ws`, and every gated HTTP API route. The token reaches the
 * browser via the `#token=` URL FRAGMENT (the server's first-boot banner
 * prints a ready-to-open URL) — never the query string, so the secret is not
 * sent to the server, logged by proxies, or leaked via `Referer` headers.
 * It is then persisted to localStorage so reloads and deep links keep
 * working. Absent a token the client sends the legacy `'dev'` placeholder on
 * `/ws`, which ungated servers still accept.
 */

import { logFrontendError } from './log-api'

const STORAGE_KEY = 'termul.webAuthToken'

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // Access can throw (disabled storage / opaque origins) — treat as absent.
    return null
  }
}

/**
 * Re-entry guard: reporting a storage failure flows through the REST logger,
 * whose `authHeader()` resolves the token again — without the guard, a
 * throwing localStorage would loop the failure report indefinitely.
 */
let reportingStorageFailure = false

/**
 * Best-effort, redacted report of a localStorage failure (operation only —
 * never the token or any value).
 */
function reportStorageFailure(operation: 'read' | 'write'): void {
  if (reportingStorageFailure) return
  reportingStorageFailure = true
  void logFrontendError({
    level: 'warn',
    source: 'web-auth-token',
    message: `localStorage ${operation} for the web auth token failed; the token is kept for this session only`
  }).finally(() => {
    reportingStorageFailure = false
  })
}

/**
 * Resolve the current web auth token. Precedence: the `#token=` URL fragment
 * (persisted to localStorage on first sight, so reloads survive) then the
 * persisted localStorage value; `null` when neither exists. A storage write
 * failure is non-fatal: the fragment token still applies to this session.
 */
export function getWebAuthToken(): string | null {
  if (typeof window === 'undefined' || !window.location) return null
  const hash = window.location.hash
  const fromUrl = hash.length > 1 ? new URLSearchParams(hash.slice(1)).get('token') : null
  if (fromUrl) {
    // Strip the token from the address bar FIRST: the secret leaves the
    // visible URL / history / bookmarks immediately, and a re-entrant
    // resolution (storage-failure report → REST logger → authHeader) no
    // longer sees a fragment token. Best-effort: replaceState can throw on
    // opaque origins — the token still works.
    try {
      const hashParams = new URLSearchParams(hash.slice(1))
      hashParams.delete('token')
      const rest = hashParams.toString()
      const url = `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`
      window.history.replaceState(window.history.state, '', url)
    } catch {
      // Opaque origin — ignore.
    }
    // Persist so reloads and deep links keep working. Quota/SecurityError is
    // non-fatal: the fragment token still applies to THIS session; reloads
    // then need a fresh bootstrap link.
    try {
      safeLocalStorage()?.setItem(STORAGE_KEY, fromUrl)
    } catch {
      reportStorageFailure('write')
    }
    return fromUrl
  }
  try {
    return safeLocalStorage()?.getItem(STORAGE_KEY) || null
  } catch {
    reportStorageFailure('read')
    return null
  }
}

/** Forget the persisted token (e.g. after a 401 the user re-opens with a fresh URL). */
export function clearWebAuthToken(): void {
  safeLocalStorage()?.removeItem(STORAGE_KEY)
}

/** The `Authorization` header to merge into gated REST calls (absent when no token). */
export function authHeader(): Record<string, string> | undefined {
  const token = getWebAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}
