/**
 * Web auth bootstrap gate (issue #854): missing or wrong token hangs the web
 * client on "Loading..." forever.
 *
 * On a token-gated `termul-server`, `GET /projects` answers 401 with
 * `{success:false, code:'UNAUTHORIZED'}` until a valid bearer token is
 * presented (the auth gate refuses gated API routes — see
 * `src-tauri/src/web/router.rs`). The projects loader (`useProjectsLoader`)
 * silently discards the failure, so `isLoaded` never flips and the workspace
 * stays on its Loading screen with no way to enter a token. An installed iOS
 * PWA cannot even add `#token=` to its URL.
 *
 * This module probes a gated REST route once at web-client boot and exposes
 * the auth state for the renderer:
 * - `'ok'` — the request succeeded (already authed, or an ungated server).
 * - `'unauthorized'` — 401/UNAUTHORIZED: show the token-entry screen.
 * - `'network-error'` — server unreachable / invalid body: NOT a token
 *   problem; keep the existing loading/retry behavior (a transient blip must
 *   not strand the user on a token screen).
 *
 * The desktop (`isTauriContext()`) never probes — the Tauri transport has no
 * bearer gate.
 *
 * After the user submits a token it is stored EXACTLY the way the
 * `#token=` URL-fragment flow stores it (`web-auth-token.ts` persists to
 * localStorage + the session cache and the REST helpers pick it up via
 * `authHeader()`), then a re-probe decides whether bootstrap may continue.
 */

import type { IpcResult } from '@shared/types/ipc.types'
import { useSyncExternalStore } from 'react'
import { getJson } from './ipc/http'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'
import { setWebAuthToken } from './web-auth-token'

export type WebAuthGateStatus = 'checking' | 'ok' | 'unauthorized' | 'network-error'

interface WebAuthGateState {
  status: WebAuthGateStatus
  /** True while a user-submitted token is being verified by the server. */
  submitting: boolean
}

let gateState: WebAuthGateState = { status: 'checking', submitting: false }

const subscribers = new Set<() => void>()

function notify(): void {
  for (const sub of subscribers) sub()
}

function setState(next: Partial<WebAuthGateState>): void {
  gateState = { ...gateState, ...next }
  notify()
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

function snapshot(): WebAuthGateState {
  return gateState
}

/**
 * Whether an `IpcResult` failure is the web auth gate's refusal. The server
 * answers 401 with the `IpcBody` failure shape (`{success:false, error:
 * 'Unauthorized', code:'UNAUTHORIZED'}`), which `parseBody` preserves on any
 * HTTP status — so the check is the structured code, not the status text.
 */
/**
 * Issue #907 (F3): a live session's WS `authenticate` was refused
 * `unauthorized` — the token is (or became) invalid mid-session. Web-only:
 * flips the gate to `unauthorized` so the token-entry screen re-surfaces
 * (even after projects loaded) and resets the `checkWebAuthGate`
 * `probeInFlight` guard so a subsequent `submitWebAuthToken` re-probe can
 * flip the gate back to `ok`. No-op on Tauri desktop (the gate never leaves
 * `ok` there). Never throws; logs a warn boundary entry (source only —
 * never the token itself).
 */
export function flagWebAuthUnauthorized(source: string): void {
  if (isTauriContext()) return
  void logFrontendError({
    level: 'warn',
    source: 'web-auth-gate',
    message: `web auth gate flagged unauthorized by ${source}; showing the token-entry screen`
  })
  setState({ status: 'unauthorized', submitting: false })
  // `checkWebAuthGate` early-returns while the status is `ok`/`unauthorized`,
  // so no extra REST probe fires on this WS refusal path; the user's next
  // `submitWebAuthToken` performs its own probe and decides ok vs invalid.
  // Reset `probeInFlight` so a boot-time probe that raced this flag cannot
  // wedge the guard (its `.finally` would otherwise clear it only later —
  // harmless, but a clean re-arm keeps the invariant obvious).
  probeInFlight = false
}

export function isUnauthorizedResult(result: IpcResult<unknown>): boolean {
  return !result.success && result.code === 'UNAUTHORIZED'
}

/**
 * Probe the gated REST surface once. Idempotent-ish: a resolved `ok` or
 * `unauthorized` state is only re-probed by an explicit
 * `submitWebAuthToken` call, so concurrent boot consumers do not stack
 * fetches. Never throws.
 */
export function checkWebAuthGate(): void {
  if (isTauriContext()) {
    setState({ status: 'ok' })
    return
  }
  if (gateState.status === 'ok' || gateState.status === 'unauthorized') return
  if (probeInFlight) return
  probeInFlight = true
  setState({ status: 'checking' })
  void getJson<unknown>('/projects')
    .then((result) => {
      // #907: a token-class refusal may have flagged the gate WHILE this
      // probe was in flight (token rotated after the request was sent; the
      // answer reflects the pre-rotation state). Never let a stale probe
      // overwrite the fresher `unauthorized` verdict — the token-entry
      // screen must stay up and the WS transport's halt with it.
      if (gateState.status === 'unauthorized') return
      if (result.success) {
        setState({ status: 'ok' })
      } else if (isUnauthorizedResult(result)) {
        // Durable boundary log (AGENTS.md): the gate refused the token —
        // the token-entry screen appears. NEVER log the token.
        void logFrontendError({
          level: 'info',
          message: 'web auth gate refused the boot probe; showing the token-entry screen',
          source: 'web-auth-gate'
        })
        setState({ status: 'unauthorized' })
      } else {
        // getJson maps transport failures (fetch throw, invalid body) to
        // NETWORK_ERROR results — a network blip is NOT a token problem:
        // keep the loading/retry behavior, never the token-entry screen.
        void logFrontendError({
          level: 'info',
          message: `web auth gate boot probe failed (code ${result.code}); keeping the loading state`,
          source: 'web-auth-gate'
        })
        setState({ status: 'network-error' })
      }
    })
    .catch(() => {
      // A synchronous throw from the helper (never expected) is a transport
      // boundary only.
      setState({ status: 'network-error' })
    })
    .finally(() => {
      probeInFlight = false
    })
}

let probeInFlight = false

/**
 * Store a user-entered token (same persistence as the `#token=` fragment
 * flow) and verify it against the gated REST surface.
 *
 * Returns `'ok'` when the server accepted the token — bootstrap may
 * continue; `'invalid'` when it still refuses (the UI shows "invalid token");
 * `'error'` for transport problems. Never throws.
 */
export async function submitWebAuthToken(token: string): Promise<'ok' | 'invalid' | 'error'> {
  const trimmed = token.trim()
  if (!trimmed) return 'invalid'
  setWebAuthToken(trimmed)
  setState({ submitting: true })
  try {
    const result = await getJson<unknown>('/projects')
    const accepted = result.success
    const status: WebAuthGateStatus = isUnauthorizedResult(result) ? 'unauthorized' : 'ok'
    setState({ status, submitting: false })
    // Durable boundary log (AGENTS.md): the outcome of the user-submitted
    // token verification — outcome only, never the token itself.
    void logFrontendError({
      level: 'info',
      message: `web auth token submission ${accepted ? 'accepted' : 'refused'}`,
      source: 'web-auth-gate'
    })
    return accepted ? 'ok' : 'invalid'
  } catch {
    setState({ submitting: false })
    return 'error'
  }
}

/** @internal Reset for tests. */
export function _resetWebAuthGateForTesting(): void {
  gateState = { status: 'checking', submitting: false }
  probeInFlight = false
}

/** Non-React state read (event handlers, tests, non-React callers). */
export function getWebAuthGateState(): WebAuthGateState {
  return gateState
}

/** React hook: the live web-auth-gate state (re-renders on change). */
export function useWebAuthGate(): WebAuthGateState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
/**
 * True when the web auth gate permits REST calls: `ok` (authed/ungated) or
 * `network-error` (NOT a token refusal — the caller's own retry behavior
 * applies; blocking on a network blip would strand a working session).
 * Desktop is always true (the gate resolves `ok` without probing).
 */
export function useWebAuthGateOk(): boolean {
  const gate = useWebAuthGate()
  return gate.status === 'ok' || gate.status === 'network-error'
}
