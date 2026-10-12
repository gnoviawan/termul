/**
 * Protocol-mismatch recovery for the browser client (AD-15, no compat shim).
 *
 * A cached old tab speaks a stale wire protocol; the host refuses its
 * `authenticate` with `protocol_version_mismatch` (terminal socket:
 * `PROTOCOL_VERSION_MISMATCH`). All three WS clients (`/ws`, `/terminal/ws`,
 * persistence) funnel that refusal into {@link handleProtocolVersionMismatch}
 * so the page reloads ONCE to fetch the matching bundle.
 *
 * A sessionStorage latch (survives the reload, dies with the tab) keyed to the
 * host and the protocol version this bundle speaks stops a persistent
 * mismatch (e.g. a stale CDN) from reload-storming: when the latch is already
 * set the helper reports `halted`, logs a clear terminal error, and the caller
 * surfaces it through its normal connection-status path. A successful
 * handshake clears the latch ({@link clearProtocolMismatchLatch}) so a later,
 * legitimate host upgrade can reload again.
 */

import { WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import { logFrontendError } from './log-api'

export const PROTOCOL_RELOAD_LATCH_KEY = 'termul.protocolMismatchReload'

/** Outcome of a mismatch report: a reload was (already) scheduled, or the loop latch stopped it. */
export type ProtocolMismatchOutcome = 'reloading' | 'halted'

/** Set once this page has scheduled its reload; further reports are no-ops. */
let reloadScheduled = false

function latchValue(): string {
  const host = typeof window === 'undefined' ? 'unknown' : window.location.host
  return `${host}|v${WS_PROTOCOL_VERSION}`
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function haltWith(source: string, reason: string): ProtocolMismatchOutcome {
  void logFrontendError({
    level: 'error',
    source: `${source}.protocolMismatch`,
    message: `Host protocol version mismatch: ${reason}. Reload the page manually or clear the cache; reconnecting is stopped.`
  })
  return 'halted'
}

/**
 * Handle a version-mismatch refusal. Reloads the page at most once per
 * (host, protocol) per tab session. `source` is the reporting client's dotted
 * log label (e.g. `WsAcpTransport`). Never logs tokens.
 */
export function handleProtocolVersionMismatch(source: string): ProtocolMismatchOutcome {
  // Three sockets may be refused in the same tick: one reload covers them all.
  if (reloadScheduled) return 'reloading'

  const storage = safeSessionStorage()
  if (!storage) {
    return haltWith(source, 'session storage unavailable, so a reload loop cannot be ruled out')
  }

  const value = latchValue()
  try {
    if (storage.getItem(PROTOCOL_RELOAD_LATCH_KEY) === value) {
      return haltWith(source, 'the host still refuses this client after a reload')
    }
    storage.setItem(PROTOCOL_RELOAD_LATCH_KEY, value)
    if (storage.getItem(PROTOCOL_RELOAD_LATCH_KEY) !== value) {
      return haltWith(source, 'the reload loop latch could not be persisted')
    }
  } catch {
    return haltWith(source, 'session storage failed, so a reload loop cannot be ruled out')
  }

  reloadScheduled = true
  void logFrontendError({
    level: 'warn',
    source: `${source}.protocolMismatch`,
    message: 'Host protocol version mismatch; reloading the page once to fetch the matching client'
  })
  window.location.reload()
  return 'reloading'
}

/** A handshake succeeded: the client matches the host, re-arm the reload latch. */
export function clearProtocolMismatchLatch(): void {
  // A mismatch reload is already pending: keep the loop latch it set, so a
  // sibling socket succeeding in the meantime cannot re-arm a reload storm.
  if (reloadScheduled) return
  try {
    safeSessionStorage()?.removeItem(PROTOCOL_RELOAD_LATCH_KEY)
  } catch {
    /* best effort — a stuck latch only makes the next mismatch halt instead of reload */
  }
}

/** Test seam: forget this page's scheduled-reload memo. */
export function __resetProtocolMismatchForTesting(): void {
  reloadScheduled = false
}
