import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'

const {
  mockOpen,
  mockDelete,
  mockAddTab,
  mockDiscover,
  mockOpenDiscovered,
  sessionIndexRef,
  discoveredSessionsRef,
  agentsRef,
  agentStatusRef,
  projectRef
} = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockDelete: vi.fn(),
  mockAddTab: vi.fn(),
  mockDiscover: vi.fn().mockResolvedValue(undefined),
  mockOpenDiscovered: vi.fn().mockResolvedValue(undefined),
  sessionIndexRef: { current: [] as SessionIndexEntry[] },
  discoveredSessionsRef: { current: {} as Record<string, unknown[]> },
  agentsRef: { current: {} as Record<string, unknown> },
  agentStatusRef: { current: {} as Record<string, string> },
  projectRef: {
    current: null as {
      id: string
      path: string
      activeWorktreeId: string | null
      worktrees: Array<{
        id: string
        name: string
        branch: string
        path: string
        createdAt: string
      }>
    } | null
  }
}))

vi.mock('@/stores/acp-store', () => {
  const useAcpStore = (sel: (s: unknown) => unknown) =>
    sel({
      sessionIndex: sessionIndexRef.current,
      openHistorySession: mockOpen,
      deleteHistorySession: mockDelete,
      discoveredSessions: discoveredSessionsRef.current,
      agents: agentsRef.current,
      agentStatus: agentStatusRef.current,
      agentConfigs: [],
      configToLiveAgent: {},
      discoverSessions: mockDiscover,
      openDiscoveredSession: mockOpenDiscovered
    })
  // Stubs for the store helpers the component imports.
  const configIdFromReuseKey = () => ''
  const discoveryKey = (agentId: string, cwd: string) => `${agentId}\0${cwd}`
  const useAgentTemplateId = () => null
  return { useAcpStore, configIdFromReuseKey, discoveryKey, useAgentTemplateId }
})

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: () => mockAddTab
}))

vi.mock('./AgentGlyph', () => ({
  AgentGlyph: () => null
}))

vi.mock('@/stores/project-store', () => ({
  // Subscribe-style hook: returns the current project record so a re-render
  // reflects worktree changes.
  useActiveProject: () => projectRef.current,
  getActiveWorktreeFromStore: (projectId: string) => {
    const p = projectRef.current
    if (!p || p.id !== projectId || !p.activeWorktreeId) return undefined
    return p.worktrees.find((w) => w.id === p.activeWorktreeId)
  }
}))

import { ChatHistoryTab } from './ChatHistoryTab'

function entry(id: string, overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id,
    agentId: 'a',
    title: id,
    cwd: '/work',
    projectId: 'p1',
    createdAt: 0,
    lastActivityAt: 0,
    messageCount: 1,
    status: 'closed',
    ...overrides
  }
}

describe('ChatHistoryTab scoping', () => {
  beforeEach(() => {
    mockOpen.mockReset()
    mockDelete.mockReset()
    mockAddTab.mockReset()
    mockDiscover.mockReset().mockResolvedValue(undefined)
    mockOpenDiscovered.mockReset().mockResolvedValue(undefined)
    sessionIndexRef.current = []
    discoveredSessionsRef.current = {}
    agentsRef.current = {}
    agentStatusRef.current = {}
    projectRef.current = {
      id: 'p1',
      path: '/work',
      activeWorktreeId: null,
      worktrees: [{ id: 'wt1', name: 'wt', branch: 'b', path: '/work-wt', createdAt: '' }]
    }
  })

  it('shows only sessions matching active (projectId, cwd)', () => {
    sessionIndexRef.current = [
      entry('mine-main', { projectId: 'p1', cwd: '/work', title: 'mine-main' }),
      entry('mine-wt', { projectId: 'p1', cwd: '/work-wt', title: 'mine-wt' }),
      entry('other-main', { projectId: 'p2', cwd: '/work', title: 'other-main' })
    ]
    render(<ChatHistoryTab />)
    expect(screen.getByText('mine-main')).toBeInTheDocument()
    expect(screen.queryByText('mine-wt')).not.toBeInTheDocument()
    expect(screen.queryByText('other-main')).not.toBeInTheDocument()
  })

  it('re-scopes when the active worktree changes', () => {
    sessionIndexRef.current = [
      entry('mine-main', { projectId: 'p1', cwd: '/work', title: 'mine-main' }),
      entry('mine-wt', { projectId: 'p1', cwd: '/work-wt', title: 'mine-wt' })
    ]
    const { rerender } = render(<ChatHistoryTab />)
    expect(screen.getByText('mine-main')).toBeInTheDocument()
    expect(screen.queryByText('mine-wt')).not.toBeInTheDocument()
    // The project store creates a new record on update; mirror that so the
    // subscription notices the change.
    const prev = projectRef.current
    projectRef.current = {
      id: prev!.id,
      path: prev!.path,
      activeWorktreeId: 'wt1',
      worktrees: prev!.worktrees
    }
    rerender(<ChatHistoryTab />)
    expect(screen.queryByText('mine-main')).not.toBeInTheDocument()
    expect(screen.getByText('mine-wt')).toBeInTheDocument()
  })

  it('shows the empty state when no project is active', () => {
    const prev = projectRef.current
    projectRef.current = null
    sessionIndexRef.current = [entry('s1', { projectId: 'p1', cwd: '/work' })]
    const { container } = render(<ChatHistoryTab />)
    expect(screen.queryByText('s1')).not.toBeInTheDocument()
    expect(container.textContent).toMatch(/No chats yet/)
    projectRef.current = prev
  })

  it('opens a visible chat via addAgentChatTab', () => {
    sessionIndexRef.current = [entry('s1', { projectId: 'p1', cwd: '/work' })]
    mockOpen.mockResolvedValue(undefined)
    render(<ChatHistoryTab />)
    fireEvent.click(screen.getByText('s1'))
    expect(mockOpen).toHaveBeenCalledWith('s1')
  })

  it('opens the local tab immediately after synchronously starting restore', () => {
    // A cold agent spawn can take ~30s+; the click must not block on it. The
    // tab is added synchronously and openHistorySession runs in the background.
    sessionIndexRef.current = [entry('s1', { projectId: 'p1', cwd: '/work' })]
    let resolveOpen: (() => void) | undefined
    mockOpen.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve
        })
    )
    render(<ChatHistoryTab />)
    fireEvent.click(screen.getByText('s1'))
    // Tab added while the open is still pending.
    expect(mockOpen).toHaveBeenCalledWith('s1')
    expect(mockAddTab).toHaveBeenCalledWith('s1')
    expect(mockOpen.mock.invocationCallOrder[0]).toBeLessThan(
      mockAddTab.mock.invocationCallOrder[0]
    )
    resolveOpen?.()
  })

  it('opens a discovered tab immediately without waiting for its reopen', () => {
    agentsRef.current = {
      'agent-1': {
        id: 'agent-1',
        capabilities: { loadSession: true, sessionCapabilities: { list: {} } }
      }
    }
    agentStatusRef.current = { 'agent-1': 'connected' }
    discoveredSessionsRef.current = {
      ['agent-1\0/work']: [
        { sessionId: 'cli-1', cwd: '/work', title: 'CLI chat', updatedAt: '2026-01-01' }
      ]
    }
    let resolveOpen: (() => void) | undefined
    mockOpenDiscovered.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve
        })
    )

    render(<ChatHistoryTab />)
    fireEvent.click(screen.getByText('CLI chat'))

    expect(mockOpenDiscovered).toHaveBeenCalledWith('agent-1', 'cli-1', '/work', 'p1')
    expect(mockAddTab).toHaveBeenCalledWith('cli-1')
    expect(mockOpenDiscovered.mock.invocationCallOrder[0]).toBeLessThan(
      mockAddTab.mock.invocationCallOrder[0]
    )
    resolveOpen?.()
  })

  it('caps the rendered rows and lazily loads more', () => {
    // 60 sessions; page size is 50, so the first render shows 50 + a Load more.
    sessionIndexRef.current = Array.from({ length: 60 }, (_, i) =>
      entry(`s${i}`, {
        projectId: 'p1',
        cwd: '/work',
        title: `chat-${i}`,
        // Descending recency so newest (chat-0) sorts first and is visible.
        lastActivityAt: 60 - i
      })
    )
    render(<ChatHistoryTab />)
    // First page is visible.
    expect(screen.getByText('chat-0')).toBeInTheDocument()
    expect(screen.getByText('chat-49')).toBeInTheDocument()
    // Beyond the cap is not yet rendered.
    expect(screen.queryByText('chat-50')).not.toBeInTheDocument()
    // Load-more reveals the rest.
    fireEvent.click(screen.getByText(/Load more/))
    expect(screen.getByText('chat-50')).toBeInTheDocument()
    expect(screen.getByText('chat-59')).toBeInTheDocument()
  })

  it('search reaches sessions beyond the rendered window', () => {
    sessionIndexRef.current = Array.from({ length: 60 }, (_, i) =>
      entry(`s${i}`, {
        projectId: 'p1',
        cwd: '/work',
        title: `chat-${i}`,
        lastActivityAt: 60 - i
      })
    )
    render(<ChatHistoryTab />)
    // chat-55 is past the initial cap; searching for it still finds it.
    expect(screen.queryByText('chat-55')).not.toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Search chats…'), {
      target: { value: 'chat-55' }
    })
    expect(screen.getByText('chat-55')).toBeInTheDocument()
  })

  it('calls onSessionOpened after opening a visible chat', () => {
    sessionIndexRef.current = [entry('s1', { projectId: 'p1', cwd: '/work' })]
    mockOpen.mockResolvedValue(undefined)
    const onSessionOpened = vi.fn()
    render(<ChatHistoryTab onSessionOpened={onSessionOpened} />)
    fireEvent.click(screen.getByText('s1'))
    // Mirror entries open the tab immediately and fire onSessionOpened without
    // waiting on the background reconnect (the drawer closes right away).
    expect(onSessionOpened).toHaveBeenCalledTimes(1)
  })

  it('does not call onSessionOpened from the catch path when addAgentChatTab throws', () => {
    sessionIndexRef.current = [entry('s1', { projectId: 'p1', cwd: '/work' })]
    mockOpen.mockResolvedValue(undefined)
    mockAddTab.mockImplementation(() => {
      throw new Error('boom')
    })
    const onSessionOpened = vi.fn()
    render(<ChatHistoryTab onSessionOpened={onSessionOpened} />)
    fireEvent.click(screen.getByText('s1'))
    // The throw aborts the try block before onSessionOpened?.() runs.
    expect(onSessionOpened).not.toHaveBeenCalled()
  })
})
