/**
 * Web auth token source of truth for the browser client (CAP-1 interim,
 * QA remediation Story 1).
 *
 * A gated `termul-server` (public bind or explicit `--web-auth-token`)
 * requires one bearer token on the `/ws` `authenticate` handshake,
 * `/terminal/ws`, and every gated HTTP API route. The token reaches the
 * browser via the `#token=` URL FRAGMENT (the operator reads it from the
 * server host's owner-protected token file and appends it to the URL — the
 * server never prints it) — never the query string, so the secret is not
 * sent to the server, logged by proxies, or leaked via `Referer` headers.
 * It is then persisted to localStorage so reloads and deep links keep
 * working. Absent a token the client sends the legacy `'dev'` placeholder on
 * `/ws`, which ungated servers still accept.
 *
 * Transport posture: the interim gate rides whatever transport the page was
 * loaded over. Loopback plaintext (http://localhost) is safe; sending the
 * bearer token to a NON-loopback origin over plaintext http/ws exposes it
 * to the network path. That is a legitimate deployment shape for the
 * interim gate (LAN/NAS), so it is NOT rejected — but it is surfaced loudly
 * once per session (console + durable frontend-error log) from
 * `getWebAuthToken`, so every consumer (REST adapters, ACP transport,
 * persistence, terminal) inherits the warning.
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
  const hash = window.location.hash ?? ''
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
    warnIfInsecureTransport()
    return fromUrl
  }
  try {
    const stored = safeLocalStorage()?.getItem(STORAGE_KEY) || null
    if (stored) warnIfInsecureTransport()
    return stored
  } catch {
    reportStorageFailure('read')
    return null
  }
}

/**
 * Insecure-transport warning latch. Once per SESSION: the token may be
 * resolved many times per page load (every REST call, WS handshake).
 */
let warnedInsecureTransport = false

/**
 * Loudly warn — once per session, on the console AND via the durable
 * frontend-error log — when a bearer token is about to be used from a
 * plaintext (http) non-loopback page origin (which also means plaintext ws
 * sockets). Deliberately a warning, not a rejection: legitimate LAN/NAS
 * deployments are exactly what the interim gate is designed for. The
 * message carries the host only — never the token.
 */
function warnIfInsecureTransport(): void {
  if (warnedInsecureTransport) return
  if (typeof window === 'undefined' || !window.location) return
  // Tolerate stubbed/partial locations (test doubles): missing fields read
  // as empty strings, which never match the insecure predicate.
  const protocol = window.location.protocol ?? ''
  const hostname = window.location.hostname ?? ''
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  if (protocol !== 'http:' || isLoopback) return
  // Latch BEFORE reporting: the durable report flows through log-api →
  // authHeader → getWebAuthToken → here, so the flag must already be set on
  // re-entry (same pattern as `reportingStorageFailure` above).
  warnedInsecureTransport = true
  const message =
    `web auth token will be sent over PLAINTEXT HTTP/WebSocket to non-loopback host ` +
    `'${hostname}' — anyone on the network path can read it. Prefer HTTPS ` +
    `(e.g. a TLS-terminating reverse proxy) for non-local access.`
  console.warn(`[termul] ${message}`)
  void logFrontendError({ level: 'warn', source: 'web-auth-token', message })
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
