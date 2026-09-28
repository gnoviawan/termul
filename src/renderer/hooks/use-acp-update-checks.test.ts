import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCheckForUpdates } = vi.hoisted(() => ({ mockCheckForUpdates: vi.fn() }))
vi.mock('@/hooks/use-acp-registry-catalog', () => ({
  useAcpRegistryCatalog: () => ({ checkForUpdates: mockCheckForUpdates })
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { _resetAcpUpdateChecksForTesting, useAcpUpdateChecks } from './use-acp-update-checks'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('useAcpUpdateChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetAcpUpdateChecksForTesting()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('checks once on mount and again only after 24 hours', async () => {
    mockCheckForUpdates.mockResolvedValue(null)
    const { unmount } = renderHook(() => useAcpUpdateChecks())
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1)

    // Background checks never auto-apply — force refresh, advisory only.
    expect(mockCheckForUpdates).toHaveBeenCalledWith(true)

    await act(() => vi.advanceTimersByTimeAsync(6 * HOUR))
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1)

    await act(() => vi.advanceTimersByTimeAsync(18 * HOUR))
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('throttles a remount that happens within 30 minutes of the last check', async () => {
    mockCheckForUpdates.mockResolvedValue(null)
    const first = renderHook(() => useAcpUpdateChecks())
    // Flush the in-flight check so its throttle timestamp is recorded before
    // unmount (a mount→unmount race discards the result by design).
    await act(async () => {})
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1)
    first.unmount()

    await act(() => vi.advanceTimersByTimeAsync(10 * MINUTE))
    const second = renderHook(() => useAcpUpdateChecks())
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1)
    second.unmount()

    await act(() => vi.advanceTimersByTimeAsync(20 * MINUTE))
    const third = renderHook(() => useAcpUpdateChecks())
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(2)
    third.unmount()
  })

  it('swallows check failures silently instead of crashing the app shell', async () => {
    mockCheckForUpdates.mockRejectedValue(new Error('CDN unreachable'))
    renderHook(() => useAcpUpdateChecks())
    await act(() => vi.advanceTimersByTimeAsync(0))
    // No throw; the throttle timestamp is not advanced by a failed check.
    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1)
  })
})
