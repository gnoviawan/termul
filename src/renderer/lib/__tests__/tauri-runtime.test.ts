/**
 * Unit tests for the server write-admission capability cache
 * (`primeServerCapability` / `serverAdmitsRemoteWrites` /
 * `subscribeServerCapability` / `getServerCapabilitySnapshot` /
 * `__resetServerCapabilityCache`) in `tauri-runtime.ts`.
 *
 * These pin the REAL fetch/parse/cache path the worktree-picker gate depends
 * on (the AgentLauncher test mocks the whole module, so it never exercises
 * this). Covers: fetch success→admitted, false-body→denied, rejected fetch→
 * fail-closed, non-`res.ok`/bad-`status`→denied, idempotency (fetch once while
 * in-flight), and the desktop short-circuit (no fetch, admitted).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn()
}))

// jsdom provides `window.location` (defaults to http://localhost/) so
// `primeServerCapability`'s `window.location.origin` + `!isTauriContext()`
// web branch executes. Desktop is exercised by setting __TAURI_INTERNALS__.
vi.stubGlobal('fetch', mockFetch)

import {
  __resetServerCapabilityCache,
  getServerCapabilitySnapshot,
  primeServerCapability,
  serverAdmitsRemoteWrites,
  subscribeServerCapability
} from '../tauri-runtime'

/** Build a fetch Response resolving to the given JSON body. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body
  } as Response
}
/** Flush the microtask queue enough ticks for `primeServerCapability`'s
 * `.then(res => res.json()).then(body => …)` two-step chain to fully resolve
 * (each `.then` is a separate microtask). Drains a few extra ticks to be safe. */
async function flushMicrotasks(): Promise<void> {
  // eslint-disable-next-line no-await-promise
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

/** Set / clear the desktop Tauri-webview flag on `window`. */
function setTauriContext(on: boolean): void {
  if (on) {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

describe('server write-admission capability cache (web branch)', () => {
  beforeEach(() => {
    __resetServerCapabilityCache()
    mockFetch.mockReset()
    setTauriContext(false)
  })

  afterEach(() => {
    __resetServerCapabilityCache()
    setTauriContext(false)
  })

  it('admits writes when /health reports allowRemoteWrites:true', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', allowRemoteWrites: true }))
    primeServerCapability()
    await flushMicrotasks()
    expect(serverAdmitsRemoteWrites()).toBe(true)
  })

  it('denies writes when /health reports allowRemoteWrites:false', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', allowRemoteWrites: false }))
    primeServerCapability()
    await flushMicrotasks()
    expect(serverAdmitsRemoteWrites()).toBe(false)
  })

  it('fails closed (denies) when the fetch rejects (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('network blip'))
    primeServerCapability()
    await flushMicrotasks()
    expect(serverAdmitsRemoteWrites()).toBe(false)
  })

  it('fails closed when res.ok is false (e.g. a gateway 502)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', allowRemoteWrites: true }, false, 502))
    primeServerCapability()
    await flushMicrotasks()
    // The body says true, but a non-2xx must not be trusted.
    expect(serverAdmitsRemoteWrites()).toBe(false)
  })

  it('fails closed when status !== "ok" (degraded server)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'degraded', allowRemoteWrites: true }))
    primeServerCapability()
    await flushMicrotasks()
    expect(serverAdmitsRemoteWrites()).toBe(false)
  })

  it('fails closed when the body is non-JSON / throws on .json()', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid JSON')
      }
    } as Response)
    primeServerCapability()
    await flushMicrotasks()
    expect(serverAdmitsRemoteWrites()).toBe(false)
  })

  it('fires fetch only once while in-flight (idempotency)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', allowRemoteWrites: true }))
    primeServerCapability()
    primeServerCapability() // second call while in-flight → no-op
    primeServerCapability() // third call → still no-op
    await flushMicrotasks()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('does not re-fetch after resolving admitted (static per boot)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', allowRemoteWrites: true }))
    primeServerCapability()
    await flushMicrotasks()
    primeServerCapability() // resolved-true → no re-fetch
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('schedules a bounded backoff retry after a failed fetch', async () => {
    vi.useFakeTimers()
    // First attempt fails.
    mockFetch.mockRejectedValueOnce(new Error('tunnel not up'))
    primeServerCapability()
    await flushMicrotasks()
    expect(serverAdmitsRemoteWrites()).toBe(false)
    // A retry timer is scheduled (not resolved-true, not in-flight).
    const snapshotAfterFail = getServerCapabilitySnapshot()()
    expect(snapshotAfterFail.retryTimer).not.toBeNull()
    expect(snapshotAfterFail.resolved).toBe(false)
    // Second attempt succeeds (tunnel came up) — the auto-retry fires.
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', allowRemoteWrites: true }))
    vi.advanceTimersByTime(2000) // first backoff delay
    await flushMicrotasks()
    expect(serverAdmitsRemoteWrites()).toBe(true)
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2)
    vi.useRealTimers()
  })

  it('retries after a failed fetch (manual re-prime)', async () => {
    vi.useFakeTimers()
    mockFetch.mockRejectedValueOnce(new Error('tunnel not up'))
    primeServerCapability()
    await flushMicrotasks()
    expect(serverAdmitsRemoteWrites()).toBe(false)
    // Clear the auto-retry timer so it doesn't interfere with the manual
    // re-prime below.
    __resetServerCapabilityCache()
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', allowRemoteWrites: true }))
    primeServerCapability()
    await flushMicrotasks()
    expect(serverAdmitsRemoteWrites()).toBe(true)
    vi.useRealTimers()
    vi.useRealTimers()
  })

  it('is fail-closed (denies) before the fetch resolves', () => {
    // Never-resolving fetch: the cache stays in-flight, admitted stays false.
    mockFetch.mockReturnValue(new Promise(() => {}))
    primeServerCapability()
    expect(serverAdmitsRemoteWrites()).toBe(false)
  })

  it('notifies subscribers when the cache flips false→true', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeServerCapability(listener)
    expect(listener).not.toHaveBeenCalled() // no change on subscribe
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', allowRemoteWrites: true }))
    primeServerCapability()
    // notified on the in-flight flip + the resolved flip.
    await flushMicrotasks()
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('returns the live snapshot from getServerCapabilitySnapshot', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ok', allowRemoteWrites: true }))
    primeServerCapability()
    await flushMicrotasks()
    const snapshot = getServerCapabilitySnapshot()()
    expect(snapshot).toEqual({
      admitted: true,
      inFlight: false,
      resolved: true,
      retryTimer: null,
      retryCount: 0
    })
  })
})

describe('server write-admission capability cache (desktop branch)', () => {
  beforeEach(() => {
    __resetServerCapabilityCache()
    mockFetch.mockReset()
    setTauriContext(true) // desktop webview
  })

  afterEach(() => {
    __resetServerCapabilityCache()
    setTauriContext(false)
  })

  it('admits writes without fetching (desktop short-circuit)', () => {
    primeServerCapability()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(serverAdmitsRemoteWrites()).toBe(true)
  })

  it('seeds the snapshot admitted=true', () => {
    primeServerCapability()
    const snapshot = getServerCapabilitySnapshot()()
    expect(snapshot).toEqual({
      admitted: true,
      inFlight: false,
      resolved: true,
      retryTimer: null,
      retryCount: 0
    })
  })
})
