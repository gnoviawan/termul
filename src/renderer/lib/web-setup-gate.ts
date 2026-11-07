/**
 * Setup-mode detection gate for the web client (gh-1105) — web only; the
 * desktop root (`TauriApp.tsx`) never mounts it and `isTauriContext()`
 * resolves `ok` without probing.
 *
 * An unconfigured `termul-server` boots a minimal setup-mode router that
 * serves only `/health`, the token-gated `/setup/*` API and the SPA bundle
 * (`src-tauri/src/web/setup.rs`). The web client must detect that mode at
 * boot — before any server-dependent hooks mount — or the workspace would
 * sit on "Loading..." forever: every app route 404s in setup mode.
 *
 * `checkWebSetupGate()` therefore probes the PUBLIC `${location.origin}/health`
 * once (the `primeServerCapability` precedent, `tauri-runtime.ts`): both the
 * setup-mode router and the normal router emit `setupRequired` there.
 *
 * - `'checking'` — probe in flight or scheduled for retry; the gate
 *   component (`components/setup/ServerSetupGate`) owns what renders.
 * - `'setup'` — the server affirmatively answered `setupRequired: true`;
 *   the wizard replaces the whole app tree (AppEffects' hooks assume a
 *   configured server and must never mount). Terminal for the life of this
 *   page: after `apply` the server re-execs and the restarting screen lands
 *   the browser on the post-restart origin via a full reload, which
 *   re-probes from a clean slate.
 * - `'ok'` — `setupRequired` was `false` or absent (a configured server, or
 *   a pre-1105 server that predates the flag). Also the give-up verdict:
 *   like the web auth gate's `network-error`, a dead/unreachable host is
 *   NOT a setup signal — after the bounded retries run out the gate opens
 *   and the app's own offline handling (the 15s host-offline probe) takes
 *   over, instead of stranding a working deployment behind a spinner.
 *
 * Modeled on `web-auth-gate.ts` (external store + `useSyncExternalStore`)
 * and `primeServerCapability` (raw `/health` fetch, bounded backoff,
 * generation fence so a late probe can never overwrite a reset/newer run).
 */

import { useEffect, useSyncExternalStore } from 'react'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

const LOG_SOURCE = 'web-setup-gate'

export type WebSetupGateStatus = 'checking' | 'setup' | 'ok'

interface WebSetupGateState {
  status: WebSetupGateStatus
  /** A fetch is in flight — concurrent primes must not stack requests. */
  inFlight: boolean
  /** Pending backoff retry timer, `null` when none is scheduled. */
  retryTimer: number | null
  /** Failed probe attempts so far (drives the backoff + give-up). */
  retryCount: number
}

let gateState: WebSetupGateState = {
  status: 'checking',
  inFlight: false,
  retryTimer: null,
  retryCount: 0
}

const subscribers = new Set<() => void>()

/** Bumps on every probe start and reset: a late reply can only land on the run that sent it. */
let probeGeneration = 0

/** Total probe attempts before the gate gives up and opens (fail → `ok`). */
const MAX_PROBE_ATTEMPTS = 5

function notify(): void {
  for (const sub of subscribers) sub()
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

function snapshot(): WebSetupGateStatus {
  return gateState.status
}

/** The `/health` fields this gate reads (`status`/`allowRemoteWrites` belong to `primeServerCapability`). */
interface SetupHealthBody {
  setupRequired?: unknown
}

function clearRetryTimer(): void {
  clearTimeout(gateState.retryTimer ?? undefined)
}

/** Schedule a backoff retry: 2s, 4s, 8s, 16s (attempts 1-4 — the 5th gives up). */
function scheduleRetry(count: number): number {
  const delayMs = Math.min(2000 * 2 ** (count - 1), 16000)
  return setTimeout(() => {
    // The timer fired: clear the stale handle first so the re-check is not
    // mistaken for an already-scheduled retry (the `retryTimer` guard above).
    gateState = { ...gateState, retryTimer: null }
    checkWebSetupGate()
  }, delayMs)
}

function resolve(status: 'setup' | 'ok'): void {
  clearRetryTimer()
  gateState = { status, inFlight: false, retryTimer: null, retryCount: 0 }
  notify()
}

/**
 * Probe `/health` for the `setupRequired` flag. Idempotent: resolved
 * `setup`/`ok` states are terminal for this page and an in-flight probe is
 * never duplicated, so every boot consumer can call it freely. Never throws.
 */
export function checkWebSetupGate(): void {
  // Desktop: no setup-mode server exists — the shared-live host never
  // serves /setup/* or the flag. Resolve `ok` so an accidental mount is inert.
  if (isTauriContext()) {
    resolve('ok')
    return
  }
  if (gateState.status !== 'checking') return
  if (gateState.inFlight) return
  // A backoff retry is already scheduled — treat it as in-flight so a second
  // consumer mounting during the wait cannot bypass the backoff.
  if (gateState.retryTimer !== null) return
  if (typeof window === 'undefined' || !window.location) {
    // No origin to probe (SSR/test) — nothing to gate on; open the app.
    resolve('ok')
    return
  }
  const generation = ++probeGeneration
  gateState = { ...gateState, inFlight: true }
  notify()
  void fetch(`${window.location.origin}/health`, { method: 'GET' })
    .then((res): Promise<SetupHealthBody> => {
      if (!res.ok) {
        return Promise.reject(new Error(`HTTP ${res.status} ${res.statusText}`))
      }
      return res.json() as Promise<SetupHealthBody>
    })
    .then((body) => {
      // Generation fence: a reply landing after a reset (or a superseding
      // probe) must never overwrite the newer state.
      if (generation !== probeGeneration) return
      if (body?.setupRequired === true) {
        void logFrontendError({
          level: 'info',
          source: LOG_SOURCE,
          message: '/health reports setupRequired — mounting the server setup wizard'
        })
        resolve('setup')
      } else {
        // `false`, or absent on a pre-1105 server — a configured deployment.
        resolve('ok')
      }
    })
    .catch((err) => {
      if (generation !== probeGeneration) return
      const attempt = gateState.retryCount + 1
      if (attempt >= MAX_PROBE_ATTEMPTS) {
        // Fail OPEN to 'ok', not to 'setup': a host that cannot answer
        // /health is an outage the app already knows how to render — the
        // wizard must never appear on guesswork.
        void logFrontendError({
          level: 'warn',
          source: LOG_SOURCE,
          message: `setup probe /health failed ${attempt} times; opening the app (${err instanceof Error ? err.message : String(err)})`
        })
        resolve('ok')
        return
      }
      void logFrontendError({
        level: 'warn',
        source: LOG_SOURCE,
        message: `setup probe /health failed (attempt ${attempt}/${MAX_PROBE_ATTEMPTS}); retrying — ${err instanceof Error ? err.message : String(err)}`
      })
      gateState = {
        status: 'checking',
        inFlight: false,
        retryTimer: scheduleRetry(attempt),
        retryCount: attempt
      }
      notify()
    })
}

/** Non-React state read (event handlers, tests, non-React callers). */
export function getWebSetupGateStatus(): WebSetupGateStatus {
  return gateState.status
}

/**
 * React hook: the live setup-gate status ('checking' | 'setup' | 'ok').
 * The first consumer primes the boot probe via `checkWebSetupGate()` —
 * idempotent, so `ServerSetupGate` needs no separate wiring. Re-renders on
 * every state change.
 */
export function useWebSetupGate(): WebSetupGateStatus {
  const status = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    checkWebSetupGate()
  }, [])
  return status
}

/** @internal Reset for tests — clears state, pending retry and stale in-flight probes. */
export function _resetWebSetupGateForTesting(): void {
  clearRetryTimer()
  probeGeneration += 1
  gateState = { status: 'checking', inFlight: false, retryTimer: null, retryCount: 0 }
}
