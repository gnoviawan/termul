/**
 * Timing policy shared by the browser/phone web sockets (`/ws`,
 * `/terminal/ws`, the persistence socket): handshake bound, reconnect
 * backoff with jitter, and per-request-type timers.
 *
 * Design rules (ARCHITECTURE-SPINE Conventions › Reconnect):
 * - every socket has its own ~10 s handshake timeout (upgrade + authenticate);
 * - reconnect backoff is exponential with ±25 % jitter and the attempt counter
 *   resets only after the connection has been stable for 60 s;
 * - request timers are per request type and never shorter than the host's own
 *   bound for that type.
 */
import type { WsRequestType } from '@shared/types/web-protocol.types'

/** Generic request timer for host operations that answer promptly. */
export const REQUEST_TIMEOUT_MS = 60_000

/** Upgrade + `authenticate` budget for every socket the client opens. */
export const HANDSHAKE_TIMEOUT_MS = 10_000

export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 8_000
/** Backoff delay is scaled by a uniform factor in `1 ± RECONNECT_JITTER_RATIO`. */
export const RECONNECT_JITTER_RATIO = 0.25
/** The attempt counter resets only after the connection stayed up this long. */
export const RECONNECT_STABLE_MS = 60_000
/** Minimum spacing between wake-triggered early reconnect attempts. */
export const RECONNECT_EXPEDITE_MIN_INTERVAL_MS = 1_000

/** Bounded application round-trip probe used on every browser return signal. */
export const RESUME_PROBE_TIMEOUT_MS = 5_000

/** Bound for one session's `subscribe` during a reconnect resubscribe pass. */
export const RESUBSCRIBE_TIMEOUT_MS = 15_000

/**
 * Exponential backoff `base * 2^attempt` capped at `maxMs`, then scaled by a
 * uniform jitter factor in `1 ± RECONNECT_JITTER_RATIO`. `random` is injectable
 * for tests (`() => 0` → lower bound, `() => 1` → upper bound).
 */
export function jitteredBackoffMs(
  attempt: number,
  baseMs: number = RECONNECT_BASE_MS,
  maxMs: number = RECONNECT_MAX_MS,
  random: () => number = Math.random
): number {
  const raw = Math.min(baseMs * 2 ** attempt, maxMs)
  const factor = 1 + (random() * 2 - 1) * RECONNECT_JITTER_RATIO
  return Math.max(1, Math.round(raw * factor))
}

/** Host operations that outlive the generic timer. Each value >= the host bound. */
const INSTALL_TIMEOUT_MS = 330_000 // host: 120 s download + 180 s child (+ margin)
const CATALOG_TIMEOUT_MS = 90_000 // host refresh/network fetch bound 60 s (+ margin)
const SESSION_OPEN_TIMEOUT_MS = 90_000 // host session new/reopen cap 60 s (+ grace)

const FIXED_REQUEST_TIMEOUTS_MS: Partial<Record<WsRequestType, number>> = {
  install_acp_agent: INSTALL_TIMEOUT_MS,
  list_acp_catalog: CATALOG_TIMEOUT_MS,
  create_session: SESSION_OPEN_TIMEOUT_MS,
  load_session: SESSION_OPEN_TIMEOUT_MS,
  resume_session: SESSION_OPEN_TIMEOUT_MS,
  authenticate: HANDSHAKE_TIMEOUT_MS
}

/**
 * Client timer, in ms, for a request type. `send_prompt` (server policy +
 * grace) and `authenticate_agent` (interactive, no timer) are resolved by the
 * transport itself and never reach this table.
 */
export function requestTimeoutMs(type: WsRequestType): number {
  return FIXED_REQUEST_TIMEOUTS_MS[type] ?? REQUEST_TIMEOUT_MS
}
