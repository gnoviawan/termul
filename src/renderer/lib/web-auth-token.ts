/**
 * Web auth token source of truth for the browser client (CAP-1 interim,
 * QA remediation Story 1).
 *
 * A gated `termul-server` (public bind or explicit `--web-auth-token`)
 * requires one bearer token on the `/ws` `authenticate` handshake,
 * `/terminal/ws`, and every gated HTTP API route. The token reaches the
 * browser via the `?token=` URL param (the server's first-boot banner prints
 * a ready-to-open URL); it is then persisted to localStorage so reloads and
 * deep links keep working. Absent a token the client sends the legacy `'dev'`
 * placeholder on `/ws`, which ungated servers still accept.
 */

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
 * Resolve the current web auth token. Precedence: the URL `?token=` param
 * (persisted to localStorage on first sight, so reloads survive) then the
 * persisted localStorage value; `null` when neither exists.
 */
export function getWebAuthToken(): string | null {
  if (typeof window === 'undefined' || !window.location) return null
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('token')
  if (fromUrl) {
    safeLocalStorage()?.setItem(STORAGE_KEY, fromUrl)
    stripTokenFromUrl(params)
    return fromUrl
  }
  const stored = safeLocalStorage()?.getItem(STORAGE_KEY)
  return stored || null
}

/**
 * Remove the (just-captured) `token` param from the address bar via
 * `history.replaceState` so the secret does not linger in the visible URL,
 * browser history, bookmarks, or `Referer` headers. All other params and the
 * hash are preserved. Best-effort: a failure leaves the working token in
 * localStorage and is not an error.
 */
function stripTokenFromUrl(params: URLSearchParams): void {
  try {
    params.delete('token')
    const query = params.toString()
    const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
    window.history.replaceState(window.history.state, '', url)
  } catch {
    // replaceState can throw on opaque origins — the token still works.
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
