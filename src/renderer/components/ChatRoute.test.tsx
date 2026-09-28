import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two store modules are mocked; the component reaches into
// `getState()` directly, so the mock exposes mutable state seams.
const { acpStateRef, mockAddAgentChatTab, mockOpenHistorySession, mockNavigate } = vi.hoisted(
  () => ({
    acpStateRef: { current: {} as Record<string, { status: string }> },
    mockAddAgentChatTab: vi.fn(),
    mockOpenHistorySession: vi.fn(),
    mockNavigate: vi.fn()
  })
)

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: Object.assign(
    vi.fn((selector: (s: { openHistorySession: unknown }) => unknown) =>
      selector({ openHistorySession: mockOpenHistorySession })
    ),
    { getState: () => ({ sessions: acpStateRef.current }) }
  )
}))

// The store-level idempotency guard is the single source of truth; ChatRoute
// always delegates to addAgentChatTab and does not duplicate the predicate.
vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(vi.fn(), {
    getState: () => ({ addAgentChatTab: mockAddAgentChatTab })
  })
}))

vi.mock('@/lib/router-navigate', () => ({
  navigateToChatSession: mockNavigate,
  clearChatRoute: vi.fn()
}))

import { ChatRoute } from '@/components/ChatRoute'

function renderChatRoute(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatRoute />
    </MemoryRouter>
  )
}

function seedLiveSession(id: string): void {
  acpStateRef.current = { ...acpStateRef.current, [id]: { status: 'active' } }
}

describe('ChatRoute tab activation (multi-project perf)', () => {
  beforeEach(() => {
    mockAddAgentChatTab.mockReset()
    mockOpenHistorySession.mockReset()
    mockNavigate.mockReset()
    acpStateRef.current = {}
  })

  it('delegates to addAgentChatTab for a live session (idempotency lives in the store guard)', () => {
    seedLiveSession('s-live')
    renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(1)
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-live')
  })

  it('delegates once per route entry (two mounts of the same session → two calls)', () => {
    seedLiveSession('s-live')
    renderChatRoute('/c/s-live')
    // A second mount (e.g. strict-mode double effect) delegates again — the
    // component holds no predicate of its own; the store guard no-ops.
    renderChatRoute('/c/s-live')
    expect(mockAddAgentChatTab).toHaveBeenCalledTimes(2)
  })

  it('restores a not-yet-loaded session via openHistorySession before adding the tab', async () => {
    mockOpenHistorySession.mockResolvedValue(undefined)
    renderChatRoute('/c/s-restored')
    await vi.waitFor(() => {
      expect(mockOpenHistorySession).toHaveBeenCalledWith('s-restored')
      expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-restored')
    })
  })

  it('retries openHistorySession up to 5 times on failure before giving up', async () => {
    vi.useFakeTimers()
    mockOpenHistorySession.mockRejectedValue(new Error('not persisted yet'))
    renderChatRoute('/c/s-slow')
    // First attempt is immediate.
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500 * 4)
    expect(mockOpenHistorySession).toHaveBeenCalledTimes(5)
    // After 5 failed attempts no tab activation happens.
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('ignores routes without a session id', () => {
    renderChatRoute('/')
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    expect(mockOpenHistorySession).not.toHaveBeenCalled()
  })
})
