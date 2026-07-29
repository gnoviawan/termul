import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { syncChatHistoryMock, toSummariesMock, remoteStatus } = vi.hoisted(() => ({
  syncChatHistoryMock: vi.fn(),
  toSummariesMock: vi.fn(() => []),
  remoteStatus: { running: false }
}))

// Desktop context — the hook is a no-op in web/remote mode.
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

vi.mock('@/lib/tauri-remote-api', () => ({
  syncChatHistory: syncChatHistoryMock
}))

vi.mock('@/lib/acp-history-persistence', () => ({
  toPersistedSessionSummaries: toSummariesMock
}))

vi.mock('@/stores/remote-status-store', () => ({
  useRemoteStatusStore: {
    getState: () => ({ status: { running: remoteStatus.running } })
  }
}))

// Minimal zustand-like mock so the hook's `subscribe` fires on `setState`
// without importing the full acp-store (and its many transitive deps).
vi.mock('@/stores/acp-store', () => {
  type Listener = (
    state: { sessionIndex: unknown[] },
    prevState: { sessionIndex: unknown[] }
  ) => void
  const listeners = new Set<Listener>()
  let state = { sessionIndex: [] as unknown[] }
  return {
    useAcpStore: {
      getState: () => state,
      setState: (
        partial: { sessionIndex?: unknown[] } | ((s: typeof state) => { sessionIndex?: unknown[] })
      ) => {
        const prevState = state
        const resolved = typeof partial === 'function' ? partial(state) : partial
        state = { ...state, ...resolved }
        listeners.forEach((l) => {
          l(state, prevState)
        })
      },
      subscribe: (listener: Listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  }
})

import { useAcpStore } from '@/stores/acp-store'
import { useAcpHistorySync } from './use-acp-history-sync'

describe('useAcpHistorySync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncChatHistoryMock.mockResolvedValue({ success: true, data: undefined })
    toSummariesMock.mockReturnValue([])
    remoteStatus.running = false
    useAcpStore.setState({ sessionIndex: [] })
  })

  it('pushes the index to the server when running and sessionIndex changes', async () => {
    remoteStatus.running = true
    renderHook(() => useAcpHistorySync())

    useAcpStore.setState({ sessionIndex: [{ id: 's1' }] })

    await vi.waitFor(() => {
      expect(syncChatHistoryMock).toHaveBeenCalledTimes(1)
    })
    expect(toSummariesMock).toHaveBeenCalledOnce()
  })

  it('is a no-op when the server is stopped', async () => {
    remoteStatus.running = false
    renderHook(() => useAcpHistorySync())

    useAcpStore.setState({ sessionIndex: [{ id: 's1' }] })

    // Let any pending microtasks flush; the subscription should not fire.
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(syncChatHistoryMock).not.toHaveBeenCalled()
  })

  it('does not push when sessionIndex is unchanged', async () => {
    remoteStatus.running = true
    useAcpStore.setState({ sessionIndex: [{ id: 's1' }] })
    renderHook(() => useAcpHistorySync())

    // setState with a different key but the same sessionIndex reference.
    useAcpStore.setState({ sessionIndex: useAcpStore.getState().sessionIndex })

    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(syncChatHistoryMock).not.toHaveBeenCalled()
  })
})
