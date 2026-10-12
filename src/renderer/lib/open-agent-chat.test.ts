import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockAddAgentChatTab,
  mockMoveTabToPane,
  mockMoveTabToNewSplit,
  mockSelectProfile,
  mockToastInfo,
  mockToastError,
  mockOpenHistorySession,
  acpRef,
  wsRef
} = vi.hoisted(() => ({
  mockAddAgentChatTab: vi.fn(),
  mockMoveTabToPane: vi.fn(),
  mockMoveTabToNewSplit: vi.fn(),
  mockSelectProfile: vi.fn(),
  mockToastInfo: vi.fn(),
  mockToastError: vi.fn(),
  mockOpenHistorySession: vi.fn(async () => undefined),
  acpRef: {
    current: {
      sessions: {} as Record<string, { projectId: string }>,
      sessionIndex: [] as Array<{ id: string; projectId: string }>,
      openHistorySession: undefined as unknown as typeof mockOpenHistorySession
    }
  },
  wsRef: {
    root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null } as FakePane
  }
}))

interface FakePane {
  type: 'leaf' | 'split'
  id: string
  tabs?: Array<{ id: string }>
  children?: FakePane[]
  activeTabId?: string | null
}

function leavesOf(node: FakePane): FakePane[] {
  return node.type === 'leaf' ? [node] : (node.children ?? []).flatMap(leavesOf)
}

vi.mock('sonner', () => ({ toast: { info: mockToastInfo, error: mockToastError } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/stores/acp-store', () => ({ useAcpStore: { getState: () => acpRef.current } }))
vi.mock('@/stores/workspace-store', () => ({
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  findPaneById: (root: FakePane, id: string): FakePane | null =>
    leavesOf(root).find((leaf) => leaf.id === id) ?? null,
  findPaneContainingTab: (root: FakePane, tabId: string): FakePane | null =>
    leavesOf(root).find((leaf) => (leaf.tabs ?? []).some((tab) => tab.id === tabId)) ?? null,
  useWorkspaceStore: {
    getState: () => ({
      root: wsRef.root,
      addAgentChatTab: mockAddAgentChatTab,
      moveTabToPane: mockMoveTabToPane,
      moveTabToNewSplit: mockMoveTabToNewSplit
    })
  }
}))
vi.mock('@/stores/ssh-store', () => ({
  useSSHStore: { getState: () => ({ selectProfile: mockSelectProfile }) }
}))

import { logFrontendError } from '@/lib/log-api'
import { getTabFocusedSessionId, setTabFocusedSessionId } from '@/lib/web-tab-session'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useProjectStore } from '@/stores/project-store'
import { openAgentChatInOwnProject, openAgentChatPlaced } from './open-agent-chat'

describe('openAgentChatInOwnProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    acpRef.current.sessions = { 's-a': { projectId: 'pa' }, 's-b': { projectId: 'pb' } }
    acpRef.current.sessionIndex = []
    wsRef.root = { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
    useProjectStore.setState({ activeProjectId: 'pa' })
    useAgentChatLifetimeStore.setState({ retainedByProject: {}, focusSessionByProject: {} })
  })

  it('opens a chat of the active project in place', () => {
    expect(openAgentChatInOwnProject('s-a', 'test')).toBe('opened')
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-a')
    expect(useProjectStore.getState().activeProjectId).toBe('pa')
  })

  it('opens a chat with unknown ownership in place (fail-open)', () => {
    openAgentChatInOwnProject('s-unknown', 'test')
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-unknown')
  })

  it('opens a chat stamped unassigned in place (it names no project to switch to)', () => {
    acpRef.current.sessionIndex = [{ id: 's-stray', projectId: '__unassigned__' }]
    expect(openAgentChatInOwnProject('s-stray', 'test')).toBe('opened')
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-stray')
    expect(useProjectStore.getState().activeProjectId).toBe('pa')
  })

  it('switches to the owning project instead of adding the tab here', () => {
    expect(openAgentChatInOwnProject('s-b', 'test')).toBe('switched-project')
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    expect(useProjectStore.getState().activeProjectId).toBe('pb')
    expect(mockSelectProfile).toHaveBeenCalledWith(null)
    const lifetime = useAgentChatLifetimeStore.getState()
    expect(lifetime.retainedByProject.pb).toEqual(['s-b'])
    expect(lifetime.focusSessionByProject.pb).toBe('s-b')
  })

  it("drops the previous project's tab-focus pointer when it switches to the owner", () => {
    setTabFocusedSessionId('s-a')
    openAgentChatInOwnProject('s-b', 'test')
    expect(getTabFocusedSessionId()).toBeNull()
  })

  it('resolves the owner from the history index for closed chats', () => {
    acpRef.current.sessionIndex = [{ id: 's-closed', projectId: 'pb' }]
    openAgentChatInOwnProject('s-closed', 'test')
    expect(useProjectStore.getState().activeProjectId).toBe('pb')
  })

  describe('with a placement', () => {
    it('creates the tab in the target pane for a center drop', () => {
      expect(openAgentChatInOwnProject('s-a', 'test', { paneId: 'pane-1', zone: 'center' })).toBe(
        'opened'
      )
      expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-a', 'pane-1')
      expect(mockMoveTabToPane).not.toHaveBeenCalled()
      expect(mockMoveTabToNewSplit).not.toHaveBeenCalled()
    })

    it('splits the pane for an edge drop when other tabs share it', () => {
      wsRef.root = {
        type: 'leaf',
        id: 'pane-1',
        tabs: [{ id: 'chat-s-a' }, { id: 'editor-x' }],
        activeTabId: 'chat-s-a'
      }
      openAgentChatInOwnProject('s-a', 'test', { paneId: 'pane-1', zone: 'right' })
      expect(mockMoveTabToNewSplit).toHaveBeenCalledWith('chat-s-a', 'pane-1', 'pane-1', 'right')
    })

    it('does not split a pane off its own only tab', () => {
      wsRef.root = {
        type: 'leaf',
        id: 'pane-1',
        tabs: [{ id: 'chat-s-a' }],
        activeTabId: 'chat-s-a'
      }
      openAgentChatInOwnProject('s-a', 'test', { paneId: 'pane-1', zone: 'bottom' })
      expect(mockMoveTabToNewSplit).not.toHaveBeenCalled()
      expect(mockMoveTabToPane).not.toHaveBeenCalled()
    })

    it('moves an existing tab from another pane to a center drop', () => {
      wsRef.root = {
        type: 'split',
        id: 'split-1',
        children: [
          { type: 'leaf', id: 'pane-1', tabs: [{ id: 'chat-s-a' }], activeTabId: 'chat-s-a' },
          { type: 'leaf', id: 'pane-2', tabs: [{ id: 'editor-x' }], activeTabId: 'editor-x' }
        ]
      }
      openAgentChatInOwnProject('s-a', 'test', { paneId: 'pane-2', zone: 'center' })
      expect(mockMoveTabToPane).toHaveBeenCalledWith('chat-s-a', 'pane-1', 'pane-2')
      expect(mockMoveTabToNewSplit).not.toHaveBeenCalled()
    })

    it('falls back to open-in-place when the pane is missing', () => {
      expect(openAgentChatInOwnProject('s-a', 'test', { paneId: 'gone', zone: 'left' })).toBe(
        'opened'
      )
      expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-a')
      expect(mockMoveTabToNewSplit).not.toHaveBeenCalled()
    })

    it('rejects a foreign chat without placing it, switching or retaining', () => {
      expect(openAgentChatInOwnProject('s-b', 'test', { paneId: 'pane-1', zone: 'center' })).toBe(
        'rejected'
      )
      expect(mockAddAgentChatTab).not.toHaveBeenCalled()
      expect(useProjectStore.getState().activeProjectId).toBe('pa')
      expect(useAgentChatLifetimeStore.getState().retainedByProject).toEqual({})
      expect(useAgentChatLifetimeStore.getState().focusSessionByProject).toEqual({})
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'info', source: 'test' })
      )
    })
  })
})

describe('openAgentChatPlaced', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    acpRef.current.sessions = { 's-a': { projectId: 'pa' }, 's-b': { projectId: 'pb' } }
    acpRef.current.sessionIndex = []
    acpRef.current.openHistorySession = mockOpenHistorySession
    mockOpenHistorySession.mockReset()
    mockOpenHistorySession.mockResolvedValue(undefined)
    wsRef.root = { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
    useProjectStore.setState({ activeProjectId: 'pa' })
    useAgentChatLifetimeStore.setState({ retainedByProject: {}, focusSessionByProject: {} })
  })

  it('places the chat and starts loading its session when opened', () => {
    expect(openAgentChatPlaced('s-a', 'test', { paneId: 'pane-1', zone: 'center' })).toBe('opened')
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-a', 'pane-1')
    expect(mockOpenHistorySession).toHaveBeenCalledWith('s-a')
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('toasts and never opens, switches or retains for a foreign chat', () => {
    expect(openAgentChatPlaced('s-b', 'test', { paneId: 'pane-1', zone: 'right' })).toBe('rejected')
    expect(mockToastInfo).toHaveBeenCalledTimes(1)
    expect(mockToastInfo).toHaveBeenCalledWith('That chat belongs to another project.')
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    expect(mockOpenHistorySession).not.toHaveBeenCalled()
    expect(useProjectStore.getState().activeProjectId).toBe('pa')
    expect(useAgentChatLifetimeStore.getState().retainedByProject).toEqual({})
  })

  it('logs one warn and toasts when the session fails to open', async () => {
    mockOpenHistorySession.mockRejectedValue(new Error('boom'))
    openAgentChatPlaced('s-a', 'test', { paneId: 'pane-1', zone: 'center' })
    await vi.waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Could not open that chat. Try again.')
    )
    const warns = vi.mocked(logFrontendError).mock.calls.filter(([e]) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0][0].message).toContain('boom')
  })

  it('handles a synchronous open failure the same way', () => {
    mockOpenHistorySession.mockImplementation(() => {
      throw new Error('sync boom')
    })
    openAgentChatPlaced('s-a', 'test', { paneId: 'pane-1', zone: 'center' })
    expect(mockToastError).toHaveBeenCalledWith('Could not open that chat. Try again.')
  })
})
