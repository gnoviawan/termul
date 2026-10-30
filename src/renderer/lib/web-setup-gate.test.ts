/**
 * `useWebSetupGate` tests (gh-1105): the web client's boot probe for
 * `setupRequired` on the public `/health` route.
 *
 * Covers:
 * - `setupRequired: true` → 'setup' (the wizard surface), `false` or absent
 *   (pre-1105 server) → 'ok';
 * - transport/non-2xx failures stay 'checking' through the bounded backoff,
 *   then give up 'ok' — a dead host is an outage the app already handles,
 *   never a setup signal;
 * - the desktop context resolves 'ok' without probing;
 * - probes never stack and resolved states are terminal;
 * - the hook self-primes on first consumer mount.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { tauriRef } = vi.hoisted(() => ({
  tauriRef: { current: false as boolean }
}))

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => tauriRef.current }
})

const { mockLogFrontendError } = vi.hoisted(() => ({
  mockLogFrontendError: vi.fn(() => Promise.resolve())
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

import {
  _resetWebSetupGateForTesting,
  checkWebSetupGate,
  getWebSetupGateStatus,
  useWebSetupGate
} from './web-setup-gate'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function healthResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Gateway',
    json: async () => body
  } as unknown as Response
}

const SETUP_HEALTH = { status: 'ok', allowRemoteWrites: false, setupRequired: true }
const NORMAL_HEALTH = { status: 'ok', allowRemoteWrites: true, setupRequired: false }

describe('web setup gate (gh-1105)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockReset()
    tauriRef.current = false
    _resetWebSetupGateForTesting()
  })

  afterEach(() => {
    _resetWebSetupGateForTesting()
    vi.useRealTimers()
  })

  it('starts checking and resolves setup when /health reports setupRequired', async () => {
    expect(getWebSetupGateStatus()).toBe('checking')
    fetchMock.mockResolvedValueOnce(healthResponse(SETUP_HEALTH))

    checkWebSetupGate()

    await waitFor(() => expect(getWebSetupGateStatus()).toBe('setup'))
    expect(fetchMock).toHaveBeenCalledWith(`${window.location.origin}/health`, { method: 'GET' })
    expect(
      mockLogFrontendError.mock.calls.some(([p]) => String(p.message).includes('setupRequired'))
    ).toBe(true)
  })

  it('resolves ok when the server reports setupRequired:false', async () => {
    fetchMock.mockResolvedValueOnce(healthResponse(NORMAL_HEALTH))
    checkWebSetupGate()
    await waitFor(() => expect(getWebSetupGateStatus()).toBe('ok'))
  })

  it('resolves ok when the flag is absent entirely (pre-1105 server)', async () => {
    fetchMock.mockResolvedValueOnce(healthResponse({ status: 'ok', allowRemoteWrites: true }))
    checkWebSetupGate()
    await waitFor(() => expect(getWebSetupGateStatus()).toBe('ok'))
  })

  it('never stacks probes while one is in flight', async () => {
    fetchMock.mockResolvedValueOnce(healthResponse(NORMAL_HEALTH))
    checkWebSetupGate()
    checkWebSetupGate()
    checkWebSetupGate()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(getWebSetupGateStatus()).toBe('ok'))
  })

  it('resolved states are terminal — later checks never re-probe', async () => {
    fetchMock.mockResolvedValueOnce(healthResponse(SETUP_HEALTH))
    checkWebSetupGate()
    await waitFor(() => expect(getWebSetupGateStatus()).toBe('setup'))
    checkWebSetupGate()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a failed probe on backoff, then gives up ok (fail-open, never setup on a guess)', async () => {
    vi.useFakeTimers()
    fetchMock.mockRejectedValue(new Error('connection refused'))

    checkWebSetupGate()
    // First attempt fails → still checking, retry scheduled.
    await vi.advanceTimersByTimeAsync(0)
    expect(getWebSetupGateStatus()).toBe('checking')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Backoff ladder: 2s, 4s, 8s, 16s — the 5th failed attempt gives up.
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    await vi.advanceTimersByTimeAsync(8000)
    await vi.advanceTimersByTimeAsync(16000)

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(getWebSetupGateStatus()).toBe('ok')
  })

  it('a retry that lands during a restart-recoverable outage still detects setup', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockRejectedValueOnce(new Error('server mid-restart'))
      .mockResolvedValueOnce(healthResponse(SETUP_HEALTH))

    checkWebSetupGate()
    await vi.advanceTimersByTimeAsync(0)
    expect(getWebSetupGateStatus()).toBe('checking')

    await vi.advanceTimersByTimeAsync(2000)
    expect(getWebSetupGateStatus()).toBe('setup')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a non-2xx /health as a probe failure (retries, not setup)', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(healthResponse({}, false, 502))

    checkWebSetupGate()
    await vi.advanceTimersByTimeAsync(0)
    expect(getWebSetupGateStatus()).toBe('checking')

    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 16000)
    expect(getWebSetupGateStatus()).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('resolves ok under isTauriContext() without fetching', async () => {
    tauriRef.current = true
    checkWebSetupGate()
    await waitFor(() => expect(getWebSetupGateStatus()).toBe('ok'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a stale in-flight probe cannot overwrite a reset', async () => {
    let resolveFirst: ((res: Response) => void) | undefined
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveFirst = resolve))
    )
    checkWebSetupGate()

    _resetWebSetupGateForTesting()
    fetchMock.mockResolvedValueOnce(healthResponse(NORMAL_HEALTH))
    checkWebSetupGate()
    await waitFor(() => expect(getWebSetupGateStatus()).toBe('ok'))

    // The first (stale-generation) probe now answers 'setup' — it must not
    // downgrade the resolved 'ok' verdict.
    resolveFirst?.(healthResponse(SETUP_HEALTH))
    await Promise.resolve()
    expect(getWebSetupGateStatus()).toBe('ok')
  })

  it('useWebSetupGate self-primes on mount and publishes the verdict', async () => {
    fetchMock.mockResolvedValueOnce(healthResponse(SETUP_HEALTH))
    const { result } = renderHook(() => useWebSetupGate())
    await waitFor(() => expect(result.current).toBe('setup'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
