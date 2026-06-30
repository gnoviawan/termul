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
  projectRef
} = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockDelete: vi.fn(),
  mockAddTab: vi.fn(),
  mockDiscover: vi.fn().mockResolvedValue(undefined),
  mockOpenDiscovered: vi.fn().mockResolvedValue(undefined),
  sessionIndexRef: { current: [] as SessionIndexEntry[] },
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
      discoveredSessions: {},
      agents: {},
      agentStatus: {},
      agentConfigs: [],
      configToLiveAgent: {},
      discoverSessions: mockDiscover,
      openDiscoveredSession: mockOpenDiscovered
    })
  // selectAgentIdentity stub: returns nulls (no live agent config in tests).
  const selectAgentIdentity = () => ({ name: null, templateId: null })
  const configIdFromReuseKey = () => ''
  return { useAcpStore, selectAgentIdentity, configIdFromReuseKey }
})

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: () => mockAddTab
}))

vi.mock('./agent-templates', () => ({
  templateIcon: () => undefined
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
})
