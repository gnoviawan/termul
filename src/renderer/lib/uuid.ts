/**
 * Safe UUID helper (CAP-1 / GH-587).
 *
 * `crypto.randomUUID()` is only available in secure contexts (HTTPS or
 * localhost). The shared `dist-web` bundle is served by `termul-server` over
 * plain HTTP on a bare IP, where `crypto.randomUUID` is `undefined` — every
 * direct call site threw `TypeError: crypto.randomUUID is not a function`,
 * blank-screening the web client. This helper centralizes a safe fallback so
 * all ~24 renderer call sites share one testable seam: native
 * `crypto.randomUUID()` when present, else an RFC 4122 v4-shaped string built
 * from `crypto.getRandomValues` (available in all browser contexts, HTTP+HTTPS).
 *
 * The fallback is RFC-4122 v4-shaped (not `Math.random`) so server-side id
 * matching (`turn:<uuid>`, WS frame ids) stays valid. A one-shot warn log
 * fires on the first fallback use so the degradation is observable in the
 * backend log (issue #244). Never throws.
 */

import { logFrontendError } from './log-api'

let warnedFallback = false

/**
 * Build an RFC 4122 v4 UUID from `crypto.getRandomValues`. CSPRNG-backed,
 * available in every browser context (HTTP + HTTPS). Sets the v4 version and
 * RFC-4122 variant bits so the result validates as a real v4 UUID.
 */
function fallbackRandomUUID(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // RFC 4122 v4: version nibble = 0b0100 (4), variant nibble = 0b10xxxxxx.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Generate an RFC 4122 v4 UUID. Uses native `crypto.randomUUID()` in secure
 * contexts; falls back to a `crypto.getRandomValues`-based v4 in non-secure
 * (HTTP) contexts. Never throws.
 */
export function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  if (!warnedFallback) {
    warnedFallback = true
    void logFrontendError({
      level: 'warn',
      message: 'crypto.randomUUID unavailable (non-secure context); using getRandomValues fallback',
      source: 'lib/uuid'
    })
  }
  return fallbackRandomUUID()
}

/**
 * Reset the one-shot fallback warn guard. Exported for unit tests so the
 * warn-once behavior is deterministic across isolated test cases.
 */
export function __resetUuidFallbackWarnForTesting(): void {
  warnedFallback = false
}
