import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import {
  _resetShellAnnouncerForTests,
  ANNOUNCE_DELAY_MS,
  useShellAnnouncerStore
} from '@/stores/shell-announcer-store'

const {
  mockOpen,
  mockDelete,
  mockAddTab,
  mockDiscover,
  mockOpenDiscovered,
  templateIdCallsRef,
  sessionIndexRef,
  discoveredSessionsRef,
  agentsRef,
  agentStatusRef,
  configToLiveAgentRef,
  activeSessionIdRef,
  projectRef
} = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockDelete: vi.fn(),
  mockAddTab: vi.fn(),
  mockDiscover: vi.fn().mockResolvedValue(undefined),
  mockOpenDiscovered: vi.fn().mockResolvedValue(undefined),
  // Story 5: per-config lookups the row's icon slot performs (configId
  // arguments), so the tab test can assert the agents pass-through wiring.
  templateIdCallsRef: { current: [] as Array<[string | null, string | undefined]> },
  sessionIndexRef: { current: [] as SessionIndexEntry[] },
  discoveredSessionsRef: { current: {} as Record<string, unknown[]> },
  agentsRef: { current: {} as Record<string, unknown> },
  agentStatusRef: { current: {} as Record<string, string> },
  configToLiveAgentRef: { current: {} as Record<string, string> },
  activeSessionIdRef: { current: null as string | null },
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
      configToLiveAgent: configToLiveAgentRef.current,
      discoverSessions: mockDiscover,
      openDiscoveredSession: mockOpenDiscovered,
      activeSessionId: activeSessionIdRef.current
    })
  // Stubs for the store helpers the component imports.
  const agentReuseKey = (configId: string, cwd: string) => `${configId}\0${cwd.trim()}`
  const configIdFromReuseKey = () => ''
  const discoveryKey = (agentId: string, cwd: string) => `${agentId}\0${cwd}`
  const useAgentTemplateId = (agentId: string | null, agentConfigId?: string) => {
    templateIdCallsRef.current.push([agentId, agentConfigId])
    return null
  }
  const useAgentIcon = () => null
  return {
    useAcpStore,
    agentReuseKey,
    configIdFromReuseKey,
    discoveryKey,
    useAgentTemplateId,
    useAgentIcon
  }
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
  return mockSessionIndexEntry({
    id,
    agentId: 'a',
    title: id,
    cwd: '/work',
    messageCount: 1,
    ...overrides
  })
}

describe('ChatHistoryTab scoping', () => {
  beforeEach(() => {
    mockOpen.mockReset()
    mockDelete.mockReset()
    mockAddTab.mockReset()
    mockDiscover.mockReset().mockResolvedValue(undefined)
    mockOpenDiscovered.mockReset().mockResolvedValue(undefined)
    sessionIndexRef.current = []
    templateIdCallsRef.current = []
    discoveredSessionsRef.current = {}
    agentsRef.current = {}
    agentStatusRef.current = {}
    configToLiveAgentRef.current = {}
    activeSessionIdRef.current = null
    projectRef.current = {
      id: 'p1',
      path: '/work',
      activeWorktreeId: null,
      worktrees: [{ id: 'wt1', name: 'wt', branch: 'b', path: '/work-wt', createdAt: '' }]
    }
  })

  it('shows root-cwd and active-project worktree-cwd sessions from the root view', () => {
    sessionIndexRef.current = [
      entry('mine-main', { projectId: 'p1', cwd: '/work', title: 'mine-main' }),
      entry('mine-wt', { projectId: 'p1', cwd: '/work-wt', title: 'mine-wt' }),
      entry('other-main', { projectId: 'p2', cwd: '/work', title: 'other-main' })
    ]
    render(<ChatHistoryTab />)
    // mine-main: exact-cwd match against the active project root.
    expect(screen.getByText('mine-main')).toBeInTheDocument()
    // mine-wt: cwd is a registered worktree path of the active project, so the
    // worktree-inclusive scoping keeps it reachable from the root view.
    expect(screen.getByText('mine-wt')).toBeInTheDocument()
    // other-main: a different project — never listed.
    expect(screen.queryByText('other-main')).not.toBeInTheDocument()
  })

  it('re-scopes to the active worktree session when the active worktree changes', () => {
    sessionIndexRef.current = [
      entry('mine-main', { projectId: 'p1', cwd: '/work', title: 'mine-main' }),
      entry('mine-wt', { projectId: 'p1', cwd: '/work-wt', title: 'mine-wt' })
    ]
    const { rerender } = render(<ChatHistoryTab />)
    // Root view (activeWorktreeId=null): worktree-inclusive scoping lists both
    // the root chat and the project's registered worktree chat.
    expect(screen.getByText('mine-main')).toBeInTheDocument()
    expect(screen.getByText('mine-wt')).toBeInTheDocument()
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
    // Active worktree view: scoped to the worktree cwd, the root chat is
    // hidden while the active worktree's chat stays visible.
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

  it('does not auto-trigger session/list discovery on mount', () => {
    // The sidebar must not call session/list; external sessions are never listed
    // and discovery is intentionally stopped to avoid surfacing CLI/other chats.
    agentsRef.current = {
      'agent-1': {
        id: 'agent-1',
        capabilities: { loadSession: true, sessionCapabilities: { list: {} } }
      }
    }
    agentStatusRef.current = { 'agent-1': 'connected' }
    sessionIndexRef.current = [entry('s1', { projectId: 'p1', cwd: '/work' })]

    render(<ChatHistoryTab />)
    expect(mockDiscover).not.toHaveBeenCalled()
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

  it('does not list discovered sessions for opening', () => {
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

    render(<ChatHistoryTab />)

    // Discovered (external/CLI) sessions are never listed, so they can't be
    // opened from the sidebar — only Termul-created sessions render.
    expect(screen.queryByText('CLI chat')).not.toBeInTheDocument()
    expect(mockOpenDiscovered).not.toHaveBeenCalled()
  })

  it('hides discovered sessions even when no session is active', () => {
    agentsRef.current = {
      'agent-1': {
        id: 'agent-1',
        capabilities: { loadSession: true, sessionCapabilities: { list: {} } }
      }
    }
    agentStatusRef.current = { 'agent-1': 'connected' }
    discoveredSessionsRef.current = {
      ['agent-1\0/work']: [
        { sessionId: 'cli-1', cwd: '/work', title: 'CLI chat', updatedAt: '2026-01-01' },
        { sessionId: 'cli-2', cwd: '/work', title: 'Another CLI chat', updatedAt: '2026-01-01' }
      ]
    }
    activeSessionIdRef.current = null

    render(<ChatHistoryTab />)
    expect(screen.queryByText('CLI chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Another CLI chat')).not.toBeInTheDocument()
  })

  it('hides discovered sessions regardless of which session is active', () => {
    agentsRef.current = {
      'agent-1': {
        id: 'agent-1',
        capabilities: { loadSession: true, sessionCapabilities: { list: {} } }
      }
    }
    agentStatusRef.current = { 'agent-1': 'connected' }
    discoveredSessionsRef.current = {
      ['agent-1\0/work']: [
        { sessionId: 'cli-1', cwd: '/work', title: 'Active CLI chat', updatedAt: '2026-01-01' },
        { sessionId: 'cli-2', cwd: '/work', title: 'Other CLI chat', updatedAt: '2026-01-01' }
      ]
    }
    activeSessionIdRef.current = 'cli-1'

    render(<ChatHistoryTab />)
    expect(screen.queryByText('Active CLI chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Other CLI chat')).not.toBeInTheDocument()
  })

  it('shows local mirror sessions and hides discovered sessions', () => {
    sessionIndexRef.current = [
      entry('local-1', { projectId: 'p1', cwd: '/work', title: 'Local chat' })
    ]
    agentsRef.current = {
      'agent-1': {
        id: 'agent-1',
        capabilities: { loadSession: true, sessionCapabilities: { list: {} } }
      }
    }
    agentStatusRef.current = { 'agent-1': 'connected' }
    discoveredSessionsRef.current = {
      ['agent-1\0/work']: [
        { sessionId: 'cli-1', cwd: '/work', title: 'Active discovered', updatedAt: '2026-01-01' }
      ]
    }
    activeSessionIdRef.current = 'cli-1'

    render(<ChatHistoryTab />)
    expect(screen.getByText('Local chat')).toBeInTheDocument()
    expect(screen.queryByText('Active discovered')).not.toBeInTheDocument()
  })

  it('hides promoted metadata-only discovered sessions', () => {
    sessionIndexRef.current = [
      entry('cli-1', {
        agentId: 'agent-1',
        title: 'Promoted CLI chat',
        messageCount: 0,
        status: 'active',
        discovered: true,
        agentConfigId: 'config-1'
      })
    ]
    agentsRef.current = {
      'agent-1': {
        id: 'agent-1',
        capabilities: { loadSession: true, sessionCapabilities: { list: {} } }
      }
    }
    agentStatusRef.current = { 'agent-1': 'connected' }
    configToLiveAgentRef.current = { ['config-1\0/work']: 'agent-1' }

    render(<ChatHistoryTab />)

    // Promoted external sessions (discovered: true) are hidden; neither open
    // path fires for them.
    expect(screen.queryByText('Promoted CLI chat')).not.toBeInTheDocument()
    expect(mockOpenDiscovered).not.toHaveBeenCalled()
    expect(mockOpen).not.toHaveBeenCalled()
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

  it('shows a Failed badge for error-status chats (failed launches)', () => {
    sessionIndexRef.current = [
      entry('s-err', { projectId: 'p1', cwd: '/work', title: 'Broken chat', status: 'error' }),
      entry('s-ok', { projectId: 'p1', cwd: '/work', title: 'Healthy chat', status: 'active' })
    ]
    render(<ChatHistoryTab />)
    expect(screen.getByText('Broken chat')).toBeInTheDocument()
    expect(screen.getByText('Healthy chat')).toBeInTheDocument()
    // Exactly one Failed badge — on the error row only.
    expect(screen.getAllByText('Failed')).toHaveLength(1)
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

  it('passes the ordered agents cache through to the row icon slot', () => {
    // Story 5 (CAP-8): a switched session's scoped index entry carries the
    // story-3 `agents` cache; the tab mapping must pass it through so the row
    // renders the sequence (per-config lookups, one per ordered id) instead of
    // the single `agentConfigId` icon.
    sessionIndexRef.current = [
      entry('s-switched', {
        projectId: 'p1',
        cwd: '/work',
        agentConfigId: 'cfg-current',
        agents: ['cfg-original', 'cfg-current']
      }),
      entry('s-plain', { projectId: 'p1', cwd: '/work', agentConfigId: 'cfg-solo' })
    ]
    render(<ChatHistoryTab />)
    expect(screen.getByText('s-switched')).toBeInTheDocument()
    expect(screen.getByText('s-plain')).toBeInTheDocument()
    // The switched row resolves one per-config lookup per ordered agent id
    // (agentId null, configId from the cache — original then current). The
    // unswitched row resolves its single `agentConfigId` as before.
    expect(templateIdCallsRef.current).toEqual([
      [null, 'cfg-original'],
      [null, 'cfg-current'],
      ['a', 'cfg-solo']
    ])
  })
})

describe('ChatHistoryTab search count announcement', () => {
  // Matches SEARCH_COUNT_ANNOUNCE_DEBOUNCE_MS in ChatHistoryTab.
  const DEBOUNCE_MS = 500

  beforeEach(() => {
    vi.useFakeTimers()
    _resetShellAnnouncerForTests()
    sessionIndexRef.current = [
      entry('alpha-one', { projectId: 'p1', cwd: '/work', title: 'alpha one' }),
      entry('alpha-two', { projectId: 'p1', cwd: '/work', title: 'alpha two' }),
      entry('beta', { projectId: 'p1', cwd: '/work', title: 'beta' })
    ]
    discoveredSessionsRef.current = {}
    activeSessionIdRef.current = null
    projectRef.current = { id: 'p1', path: '/work', activeWorktreeId: null, worktrees: [] }
  })

  afterEach(() => {
    _resetShellAnnouncerForTests()
    vi.useRealTimers()
  })

  function search(text: string): void {
    fireEvent.change(screen.getByPlaceholderText('Search chats…'), { target: { value: text } })
  }

  function message(): string {
    return useShellAnnouncerStore.getState().message
  }

  function settleSearch(): void {
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS)
    })
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    })
  }

  it('announces the plural count once the results settle', () => {
    useShellAnnouncerStore.getState().registerRegion()
    render(<ChatHistoryTab />)

    search('alpha')
    // Nothing yet: the count has not held still for the debounce.
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    })
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    })
    expect(message()).toBe('')

    settleSearch()
    expect(message()).toBe('2 chats match')
  })

  it('uses the singular for exactly one match', () => {
    useShellAnnouncerStore.getState().registerRegion()
    render(<ChatHistoryTab />)

    search('beta')
    settleSearch()

    expect(message()).toBe('1 chat matches')
  })

  it('announces zero matches', () => {
    useShellAnnouncerStore.getState().registerRegion()
    render(<ChatHistoryTab />)

    search('zzz')
    settleSearch()

    expect(message()).toBe('0 chats match')
  })

  it('announces only the final count while the user keeps typing', () => {
    useShellAnnouncerStore.getState().registerRegion()
    const seen: string[] = []
    const unsubscribe = useShellAnnouncerStore.subscribe((state) => seen.push(state.message))
    render(<ChatHistoryTab />)

    search('a')
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS - 100)
    })
    search('alpha')
    settleSearch()
    unsubscribe()

    expect(seen.filter((text) => text !== '')).toEqual(['2 chats match'])
  })

  it('stays silent for an empty query and for whitespace', () => {
    useShellAnnouncerStore.getState().registerRegion()
    render(<ChatHistoryTab />)

    settleSearch()
    expect(message()).toBe('')

    search('   ')
    settleSearch()
    expect(message()).toBe('')
  })

  it('goes quiet again after the query is cleared', () => {
    useShellAnnouncerStore.getState().registerRegion()
    render(<ChatHistoryTab />)

    search('alpha')
    settleSearch()
    expect(message()).toBe('2 chats match')

    search('')
    // Clearing must not announce "3 chats match", and cancels any pending count.
    const seen: string[] = []
    const unsubscribe = useShellAnnouncerStore.subscribe((state) => seen.push(state.message))
    settleSearch()
    unsubscribe()
    expect(seen.filter((text) => text !== '')).toEqual([])
  })

  it('is inert when no live region is mounted (the desktop sidebar)', () => {
    render(<ChatHistoryTab />)

    search('alpha')
    settleSearch()

    expect(message()).toBe('')
  })
})
