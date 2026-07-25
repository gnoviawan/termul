import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpSession } from '@/stores/acp-store'

const { mockOpen, sessionRef, indexRef, openingRef, launchingRef } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  // AcpSession shape; typed loosely here because vi.hoisted runs before the
  // type-only import below is usable at runtime. `seedLiveSession` constructs
  // the value with a `satisfies AcpSession` check.
  sessionRef: { current: null as object | null },
  indexRef: { current: [] as Array<{ id: string }> },
  openingRef: { current: {} as Record<string, true> },
  launchingRef: { current: {} as Record<string, true> }
}))

vi.mock('@/stores/acp-store', () => {
  const state = () => ({
    agents: {},
    commands: {},
    toolCalls: {},
    plans: {},
    pendingPermissions: {},
    sessions: {},
    configToLiveAgent: {},
    sessionIndex: indexRef.current,
    openingHistoryIds: openingRef.current,
    launchingSessionIds: launchingRef.current,
    openHistorySession: mockOpen,
    sendPrompt: vi.fn(),
    sendPromptBlocks: vi.fn(),
    cancelPrompt: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    sendQueuedPromptNow: vi.fn(),
    setConfigOption: vi.fn(),
    setMode: vi.fn(),
    setModel: vi.fn()
  })
  return {
    useAcpStore: (sel: (s: unknown) => unknown) => sel(state()),
    useAcpSession: () => sessionRef.current,
    useAcpMessages: () => [],
    usePromptQueue: () => [],
    configIdFromReuseKey: (key: string) => key
  }
})

vi.mock('./PlanSupportHint', () => ({ PlanSupportHint: () => null }))

// Child components pull in heavy chat rendering; the states under test render
// before any of them mount.
vi.mock('./ChatErrorNotice', () => ({ ChatErrorNotice: () => null }))
vi.mock('./ChatInputBar', () => ({ ChatInputBar: () => null }))
vi.mock('./ChatMessageList', () => ({ ChatMessageList: () => null }))
vi.mock('./PermissionDialog', () => ({ PermissionDialog: () => null }))
vi.mock('./PlanPanel', () => ({ PlanPanel: () => null }))
vi.mock('./chat-timeline', () => ({
  buildTimeline: () => [],
  consolidateThoughtGroups: (items: unknown[]) => items
}))

import { AgentChatPanel } from './AgentChatPanel'

function seedLiveSession(id: string): void {
  sessionRef.current = {
    id,
    agentId: 'agent-1',
    cwd: '/w',
    projectId: 'p1',
    status: 'closed',
    title: null,
    activeTurn: false,
    openTurnId: null,
    modes: null,
    models: null,
    configOptions: [],
    lastError: null,
    createdAt: 1
  } satisfies AcpSession
}

describe('AgentChatPanel restored-tab rehydration', () => {
  beforeEach(() => {
    mockOpen.mockReset().mockResolvedValue(undefined)
    sessionRef.current = null
    indexRef.current = []
    openingRef.current = {}
    launchingRef.current = {}
  })

  it('rehydrates a visible restored tab from persisted history', () => {
    indexRef.current = [{ id: 's1' }]
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByText(/Restoring chat/)).toBeInTheDocument()
    expect(mockOpen).toHaveBeenCalledTimes(1)
    expect(mockOpen).toHaveBeenCalledWith('s1')
  })

  it('does not rehydrate a hidden tab (no background cold spawns)', () => {
    indexRef.current = [{ id: 's1' }]
    render(<AgentChatPanel sessionId="s1" isVisible={false} />)
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('rehydrates when a hidden tab becomes the active tab', () => {
    indexRef.current = [{ id: 's1' }]
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible={false} />)
    expect(mockOpen).not.toHaveBeenCalled()
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(mockOpen).toHaveBeenCalledTimes(1)
    expect(mockOpen).toHaveBeenCalledWith('s1')
  })

  it('keeps the placeholder when no history exists for the tab', () => {
    render(<AgentChatPanel sessionId="s-gone" isVisible />)
    expect(screen.getByText(/No active chat for this pane/)).toBeInTheDocument()
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('surfaces a rehydrate failure with a retry affordance', async () => {
    indexRef.current = [{ id: 's1' }]
    mockOpen.mockRejectedValueOnce(new Error('spawn boom'))
    render(<AgentChatPanel sessionId="s1" isVisible />)
    await waitFor(() => {
      expect(screen.getByText(/Failed to restore chat/)).toBeInTheDocument()
    })
    // Retry clears the error and re-attempts the open.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalledTimes(2)
    })
  })

  it('shows a reconnecting banner while a closed session is being reopened', () => {
    seedLiveSession('s1')
    openingRef.current = { s1: true }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByText(/Reconnecting to agent/)).toBeInTheDocument()
  })

  it('offers a Reconnect action for a closed session with history (no dead end)', () => {
    // A failed background reconnect leaves the session registered but closed;
    // the pane must offer a working way to re-attempt the reopen.
    seedLiveSession('s1')
    indexRef.current = [{ id: 's1' }]
    render(<AgentChatPanel sessionId="s1" isVisible />)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(mockOpen).toHaveBeenCalledWith('s1')
  })
})
