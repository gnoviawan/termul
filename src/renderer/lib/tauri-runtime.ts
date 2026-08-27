import type { UnlistenFn } from '@tauri-apps/api/event'
import { logFrontendError } from '@/lib/log-api'

type MaybeUnlisten = Promise<UnlistenFn> | UnlistenFn | null | undefined

export function isTauriContext(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
  )
}
/**
 * Server write-admission capability for the web client.
 *
 * Replaces the old `isLoopbackWebClient()` hostname guess (wrong for Cloudflare
 * tunnel domains): the web client asks the same-origin server via
 * `GET /health` → `{"status":"ok","allowRemoteWrites":<bool>}` whether ITS
 * write requests would pass `check_local_only`. The server answers per-request
 * (a loopback peer is admitted regardless of `--allow-remote-writes`), so the
 * advertised bool mirrors the exact admission the client's writes face.
 *
 * Desktop (`isTauriContext()`) short-circuits to `true` without fetching (local
 * writes are always admitted). Web fails closed (`false`) until the boot fetch
 * resolves; on fetch failure / non-`res.ok` / `status !== "ok"` / non-JSON it
 * stays `false` and retries on the next `primeServerCapability()` call.
 *
 * A subscriber set lets the launcher re-render when the cache flips
 * `false`→`true` (the boot fetch resolves after the first render).
 */
type ServerCapabilityState = {
  admitted: boolean
  inFlight: boolean
  resolved: boolean
  /** Bounded backoff retry timer (cleared on success/reset). `null` when no
   * retry is pending. Tracks the `setTimeout` handle so a reset or a
   * successful resolution can clear it. */
  retryTimer: number | null
  /** Retry attempt count (bounded — caps the backoff). */
  retryCount: number
}
let serverCapability: ServerCapabilityState = {
  admitted: false,
  inFlight: false,
  resolved: false,
  retryTimer: null,
  retryCount: 0
}
const serverCapabilitySubscribers = new Set<() => void>()

function notifyServerCapabilitySubscribers(): void {
  for (const sub of serverCapabilitySubscribers) sub()
}

/** Subscribe to server-capability changes; returns an unsubscribe fn. Used by
 * `useServerAdmitsRemoteWrites` (via `useSyncExternalStore`) so the launcher
 * re-renders when the boot fetch resolves. */
export function subscribeServerCapability(listener: () => void): () => void {
  serverCapabilitySubscribers.add(listener)
  return () => {
    serverCapabilitySubscribers.delete(listener)
  }
}

/** Read the current server-capability snapshot (for `useSyncExternalStore`). */
export function getServerCapabilitySnapshot(): () => ServerCapabilityState {
  return () => serverCapability
}

/** True iff writes are admitted for this client (desktop always; web per
 * server `/health`). Returns `false` until the boot fetch resolves (fail
 * closed). Direct read — prefer `useServerAdmitsRemoteWrites` in React so the
 * component re-renders on resolution. */
export function serverAdmitsRemoteWrites(): boolean {
  if (isTauriContext()) return true
  return serverCapability.admitted
}

/** Prime the remote-write admission cache from `GET /health`. No-op on desktop
 * (always local → writes admitted). Idempotent while a fetch is in-flight; if
 * the last attempt failed (not resolved or resolved false), a later call retries
 * — so a transient boot failure (network blip, tunnel not yet up) recovers
 * without a page reload. Safe to call once at web-client boot. */
export function primeServerCapability(): void {
  // Desktop: no server to query; writes are always local-admitted.
  if (isTauriContext()) {
    clearRetryTimer()
    serverCapability = {
      admitted: true,
      inFlight: false,
      resolved: true,
      retryTimer: null,
      retryCount: 0
    }
    notifyServerCapabilitySubscribers()
    return
  }
  // Already in-flight: don't stack a second fetch.
  if (serverCapability.inFlight) return
  // Already resolved-true: no point re-fetching (admission is static per boot).
  if (serverCapability.resolved && serverCapability.admitted) return
  // Mark in-flight (fail-closed admitted stays false until resolution) so a
  // concurrent prime call is a no-op and the launcher can render `false` now.
  serverCapability = {
    ...serverCapability,
    admitted: false,
    inFlight: true,
    resolved: false
  }
  notifyServerCapabilitySubscribers()
  void fetch(`${window.location.origin}/health`, { method: 'GET' })
    .then((res): Promise<{ status?: unknown; allowRemoteWrites?: unknown } | null> => {
      // Trust only a 2xx JSON body with status === "ok" — a misconfigured
      // gateway returning 200 with a JSON-shaped error body must not be
      // treated as admitting writes. Return null on rejection paths; the
      // next `.then` maps null → denied.
      if (!res.ok) {
        void logFrontendError({
          level: 'warn',
          source: 'tauri-runtime.primeServerCapability',
          message: `/health returned non-2xx status ${res.status}`
        })
        return Promise.resolve(null)
      }
      return res.json() as Promise<{ status?: unknown; allowRemoteWrites?: unknown }>
    })
    .then((body) => {
      const statusOk = body?.status === 'ok'
      const admitted = statusOk && body?.allowRemoteWrites === true
      if (admitted) {
        clearRetryTimer()
        serverCapability = {
          admitted: true,
          inFlight: false,
          resolved: true,
          retryTimer: null,
          retryCount: 0
        }
      } else if (statusOk && body?.allowRemoteWrites === false) {
        // Valid `allowRemoteWrites:false` — a valid policy result, NOT a
        // failure. Stay fail-closed; no retry (policy is static per boot).
        clearRetryTimer()
        serverCapability = {
          admitted: false,
          inFlight: false,
          resolved: true,
          retryTimer: null,
          retryCount: 0
        }
      } else {
        // Invalid payload (status !== "ok", or allowRemoteWrites missing/
        // wrong type) — log it; this is a failure, not a valid denial.
        void logFrontendError({
          level: 'warn',
          source: 'tauri-runtime.primeServerCapability',
          message: `/health returned invalid payload: status=${String(body?.status)} allowRemoteWrites=${String(body?.allowRemoteWrites)}`
        })
        clearRetryTimer()
        serverCapability = {
          admitted: false,
          inFlight: false,
          resolved: true,
          retryTimer: null,
          retryCount: 0
        }
      }
      notifyServerCapabilitySubscribers()
    })
    .catch((err) => {
      // Network/parse failure: stay fail-closed and schedule a bounded
      // backoff retry so a transient boot failure (network blip, tunnel not
      // yet up) recovers without a page reload.
      void logFrontendError({
        level: 'warn',
        source: 'tauri-runtime.primeServerCapability',
        message: `/health fetch failed: ${err instanceof Error ? err.message : String(err)}`
      })
      const nextCount = serverCapability.retryCount + 1
      serverCapability = {
        admitted: false,
        inFlight: false,
        resolved: false,
        retryTimer: scheduleRetry(nextCount),
        retryCount: nextCount
      }
      notifyServerCapabilitySubscribers()
    })
}

/** Maximum retry attempts before giving up (fail-closed permanently). */
const MAX_RETRY_ATTEMPTS = 5

/** Clear any pending retry timer. */
function clearRetryTimer(): void {
  clearTimeout(serverCapability.retryTimer ?? undefined)
}

/** Schedule a bounded backoff retry. Returns the timer handle (cleared on
 * success/reset). Exponential backoff: 2s, 4s, 8s, 16s, 32s — capped at
 * MAX_RETRY_ATTEMPTS (then fail-closed permanently). */
function scheduleRetry(count: number): number | null {
  if (count > MAX_RETRY_ATTEMPTS) return null
  const delayMs = Math.min(2000 * 2 ** (count - 1), 32000)
  return setTimeout(() => {
    primeServerCapability()
  }, delayMs)
}

export function __resetServerCapabilityCache(): void {
  clearRetryTimer()
  serverCapability = {
    admitted: false,
    inFlight: false,
    resolved: false,
    retryTimer: null,
    retryCount: 0
  }
  serverCapabilitySubscribers.clear()
}

export function cleanupTauriListener(unlisten: MaybeUnlisten): void {
  if (!unlisten) return

  if (typeof unlisten === 'function') {
    unlisten()
    return
  }

  if (typeof unlisten.then === 'function') {
    void unlisten
      .then((dispose) => {
        dispose()
      })
      .catch(() => {
        // Ignore teardown failures in test/browser contexts.
      })
  }
}
