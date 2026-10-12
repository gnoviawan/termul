import type { PersistedSessionSummary } from '@shared/types/web-protocol.types'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpHistory } from '../use-acp-history'

const { mockSubscribe, loadSessionIndex, applySessionIndexSnapshot, state } = vi.hoisted(() => {
  const loadSessionIndex = vi.fn()
  const applySessionIndexSnapshot = vi.fn()
  return {
    mockSubscribe: vi.fn(),
    loadSessionIndex,
    applySessionIndexSnapshot,
    state: { loadSessionIndex, applySessionIndexSnapshot }
  }
})

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => false }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/acp-transport', () => ({
  getAcpTransport: () => ({ watches: { subscribe: mockSubscribe } })
}))
vi.mock('@/lib/acp-history-persistence', () => ({
  runHistoryWipeMigration: vi.fn(() => Promise.resolve()),
  // Stand-in for the real wire → index mapping (covered with the persistence module).
  fromPersistedSessionSummary: (entry: { sessionId: string }) => ({ id: entry.sessionId })
}))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (select: (s: typeof state) => unknown) => select(state)
}))

interface HistoryHandlers {
  onState: (summaries: PersistedSessionSummary[]) => void
  onDelta: () => void
}

const summary = {
  sessionId: 's-1',
  runtimeAgentId: 'agent-1',
  stableAgentNamespace: 'config:claude',
  projectId: 'p1',
  cwd: '/w',
  title: 'Chat',
  createdAt: 1,
  lastActivityAt: 2,
  messageCount: 3,
  status: 'closed'
} as unknown as PersistedSessionSummary

describe('useAcpHistory (web chat-history watch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadSessionIndex.mockResolvedValue(undefined)
    applySessionIndexSnapshot.mockResolvedValue(undefined)
    mockSubscribe.mockReturnValue(vi.fn())
  })

  function handlers(): HistoryHandlers {
    expect(mockSubscribe).toHaveBeenCalledWith('chat_history', expect.any(Object))
    return mockSubscribe.mock.calls[0]?.[1] as HistoryHandlers
  }

  it('installs the host index from the watch state', async () => {
    renderHook(() => useAcpHistory())
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled())

    handlers().onState([summary])

    expect(applySessionIndexSnapshot).toHaveBeenCalledTimes(1)
    expect(applySessionIndexSnapshot.mock.calls[0]?.[0]).toEqual([{ id: 's-1' }])
  })

  it('ignores a state that is not an index array', async () => {
    renderHook(() => useAcpHistory())
    handlers().onState({ sessions: [] } as unknown as PersistedSessionSummary[])
    expect(applySessionIndexSnapshot).not.toHaveBeenCalled()
  })

  it('refetches the index on a delta and stops watching on unmount', async () => {
    const unsubscribe = vi.fn()
    mockSubscribe.mockReturnValue(unsubscribe)
    const { unmount } = renderHook(() => useAcpHistory())
    // The mount-time load is the first call; the delta is the second.
    await waitFor(() => expect(loadSessionIndex).toHaveBeenCalledTimes(1))

    handlers().onDelta()
    expect(loadSessionIndex).toHaveBeenCalledTimes(2)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
