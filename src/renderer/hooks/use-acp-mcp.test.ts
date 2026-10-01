import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredMcpServer } from '@/lib/acp-mcp-persistence'
import type { FrontendErrorPayload } from '@/lib/log-api'

const mocks = vi.hoisted(() => ({
  loadMcpServers: vi.fn(),
  probeMcpServer: vi.fn(),
  logFrontendError: vi.fn()
}))

// Mutable store state the mocked `useAcpStore` selector reads — tests drive
// the auto-probe pass by mutating this object, mirroring how the real store
// replaces (never mutates) `mcpServers` on each action.
const state: { mcpServers: StoredMcpServer[]; mcpServersLoaded: boolean } = {
  mcpServers: [],
  mcpServersLoaded: false
}

vi.mock('@/stores/acp-store', () => {
  const getState = () => ({
    ...state,
    loadMcpServers: mocks.loadMcpServers,
    probeMcpServer: mocks.probeMcpServer
  })
  const useAcpStore = (sel?: (s: Record<string, unknown>) => unknown) =>
    sel ? sel(getState()) : getState()
  useAcpStore.getState = getState
  return { useAcpStore }
})

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mocks.logFrontendError
}))

import { _resetAutoProbedMcpServersForTesting, useAcpMcp } from './use-acp-mcp'

const stdioServer = (id: string, enabled?: boolean): StoredMcpServer => {
  const entry: StoredMcpServer = { id, type: 'stdio', name: `Server ${id}`, command: 'node' }
  if (enabled !== undefined) entry.enabled = enabled
  return entry
}

describe('useAcpMcp — auto-probe pass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // The per-app-run probe set is module state — reset between tests so each
    // case exercises a fresh app run.
    _resetAutoProbedMcpServersForTesting()
    state.mcpServers = []
    state.mcpServersLoaded = false
    mocks.loadMcpServers.mockResolvedValue(undefined)
    mocks.probeMcpServer.mockResolvedValue(undefined)
    mocks.logFrontendError.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the registry on mount and never probes before it resolves', () => {
    renderHook(() => useAcpMcp())
    expect(mocks.loadMcpServers).toHaveBeenCalledTimes(1)
    expect(mocks.probeMcpServer).not.toHaveBeenCalled()
  })

  it('probes every enabled server once after the registry loads (deferred to idle)', async () => {
    state.mcpServers = [stdioServer('a'), stdioServer('b')]
    state.mcpServersLoaded = true

    renderHook(() => useAcpMcp())

    // The pass is deferred (idle/timeout) — not yet fired synchronously.
    expect(mocks.probeMcpServer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledWith('a')
    expect(mocks.probeMcpServer).toHaveBeenCalledWith('b')
    expect(mocks.probeMcpServer).toHaveBeenCalledTimes(2)
  })

  it('picks up the registry when it resolves after mount (real load sequence)', async () => {
    // Mount with the registry NOT yet loaded (production boot order).
    state.mcpServers = [stdioServer('a')]
    const { rerender } = renderHook(() => useAcpMcp())
    expect(mocks.probeMcpServer).not.toHaveBeenCalled()

    // loadMcpServers resolves: the store replaces state, the hook re-renders.
    state.mcpServersLoaded = true
    rerender()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledWith('a')
  })

  it('treats a missing enabled field as enabled (legacy registry entries)', async () => {
    state.mcpServers = [stdioServer('legacy'), stdioServer('off', false)]
    state.mcpServersLoaded = true

    renderHook(() => useAcpMcp())

    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledWith('legacy')
    expect(mocks.probeMcpServer).not.toHaveBeenCalledWith('off')
  })

  it('does not re-probe the same id on registry updates (toggle churn)', async () => {
    state.mcpServers = [stdioServer('a'), stdioServer('b')]
    state.mcpServersLoaded = true
    const { rerender } = renderHook(() => useAcpMcp())

    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledTimes(2)

    // Toggle churn: another server flips enabled; `a` must not re-probe.
    state.mcpServers = [stdioServer('a'), stdioServer('b', false)]
    rerender()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledTimes(2)

    // Re-enable `b` — already probed once this run, so still no new probe.
    state.mcpServers = [stdioServer('a'), stdioServer('b')]
    rerender()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledTimes(2)
  })

  it('a root remount within the same run does not re-fan-out (per-app-run set)', async () => {
    state.mcpServers = [stdioServer('a')]
    state.mcpServersLoaded = true
    const first = renderHook(() => useAcpMcp())
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledTimes(1)
    first.unmount()

    // Same JS module (same app run) — remounting must not re-probe.
    renderHook(() => useAcpMcp())
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledTimes(1)
  })

  it('picks up a newly added server automatically', async () => {
    state.mcpServers = [stdioServer('a')]
    state.mcpServersLoaded = true
    const { rerender } = renderHook(() => useAcpMcp())

    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledWith('a')

    state.mcpServers = [stdioServer('a'), stdioServer('new')]
    rerender()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.probeMcpServer).toHaveBeenCalledWith('new')
    expect(mocks.probeMcpServer).toHaveBeenCalledTimes(2)
  })

  it('logs the boundary line when the pass runs and stays silent when idle', async () => {
    state.mcpServers = [stdioServer('a')]
    state.mcpServersLoaded = true
    renderHook(() => useAcpMcp())

    // Before the deferred pass fires: no boundary log for the pass.
    const loggedLevels = mocks.logFrontendError.mock.calls.map(
      ([payload]) => (payload as FrontendErrorPayload).level
    )
    expect(loggedLevels).not.toContain('info')

    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'acp.useAcpMcp',
        message: 'Auto-probe pass covering 1 enabled MCP server'
      })
    )
  })

  it('a rejected probe is caught and logged, never an unhandled rejection', async () => {
    mocks.probeMcpServer.mockRejectedValue(new Error('probe failed'))
    state.mcpServers = [stdioServer('a')]
    state.mcpServersLoaded = true

    renderHook(() => useAcpMcp())
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'acp.useAcpMcp',
        message: expect.stringContaining("rejected for server id 'a'")
      })
    )
  })

  it('a rejected registry load is caught and logged (never unhandled)', async () => {
    mocks.loadMcpServers.mockRejectedValue(new Error('registry offline'))

    renderHook(() => useAcpMcp())
    await vi.waitFor(() =>
      expect(mocks.logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'acp.useAcpMcp',
          message: expect.stringContaining('registry load rejected')
        })
      )
    )
    expect(mocks.probeMcpServer).not.toHaveBeenCalled()
  })
})
