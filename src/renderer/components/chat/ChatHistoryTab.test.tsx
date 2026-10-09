import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'

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
  projectRef,
  mockToastError,
  mockLogFrontendError
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
  mockToastError: vi.fn(),
  mockLogFrontendError: vi.fn(),
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

vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogFrontendError }))

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
    mockToastError.mockReset()
    mockLogFrontendError.mockReset()
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

  it('the query prop reaches sessions beyond the rendered window', () => {
    sessionIndexRef.current = Array.from({ length: 60 }, (_, i) =>
      entry(`s${i}`, {
        projectId: 'p1',
        cwd: '/work',
        title: `chat-${i}`,
        lastActivityAt: 60 - i
      })
    )
    const { rerender } = render(<ChatHistoryTab />)
    // chat-55 is past the initial cap; filtering for it still finds it.
    expect(screen.queryByText('chat-55')).not.toBeInTheDocument()
    rerender(<ChatHistoryTab query="chat-55" />)
    expect(screen.getByText('chat-55')).toBeInTheDocument()
    expect(screen.queryByText('chat-0')).not.toBeInTheDocument()
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

describe('ChatHistoryTab as the drawer History body', () => {
  beforeEach(() => {
    mockOpen.mockReset().mockResolvedValue(undefined)
    mockDelete.mockReset().mockResolvedValue(undefined)
    mockAddTab.mockReset()
    mockToastError.mockReset()
    mockLogFrontendError.mockReset()
    sessionIndexRef.current = []
    discoveredSessionsRef.current = {}
    agentsRef.current = {}
    agentStatusRef.current = {}
    configToLiveAgentRef.current = {}
    projectRef.current = {
      id: 'p1',
      path: '/work',
      activeWorktreeId: null,
      worktrees: []
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function seed(titles: string[]): void {
    sessionIndexRef.current = titles.map((title, i) =>
      entry(`id-${i}`, {
        projectId: 'p1',
        cwd: '/work',
        title,
        status: 'active',
        lastActivityAt: 1000 - i
      })
    )
  }

  function withHeading(props: Parameters<typeof ChatHistoryTab>[0] = {}) {
    return (
      <div>
        <h2 id="history-heading" tabIndex={-1}>
          History
        </h2>
        <ChatHistoryTab historyHeadingId="history-heading" {...props} />
      </div>
    )
  }

  function renderWithHeading(props: Parameters<typeof ChatHistoryTab>[0] = {}) {
    return render(withHeading(props))
  }

  it('has no search field of its own (the search moved to the drawer top)', () => {
    seed(['one'])
    renderWithHeading()

    expect(screen.queryByPlaceholderText('Search chats…')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('filters by the query prop, case-insensitively, and reports no match', () => {
    seed(['Fix auth loop', 'Refactor git sheet'])
    const { rerender } = renderWithHeading({ query: 'AUTH' })

    expect(screen.getByText('Fix auth loop')).toBeInTheDocument()
    expect(screen.queryByText('Refactor git sheet')).not.toBeInTheDocument()

    rerender(withHeading({ query: 'zzz' }))
    expect(screen.getByText('No chats match this search.')).toBeInTheDocument()
  })

  it('renders recency labels as h3 headings, each labelling its row group', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0))
    const DAY = 24 * 60 * 60 * 1000
    const now = Date.now()
    sessionIndexRef.current = [
      entry('t', { projectId: 'p1', cwd: '/work', title: 'today-chat', lastActivityAt: now }),
      entry('y', {
        projectId: 'p1',
        cwd: '/work',
        title: 'yesterday-chat',
        lastActivityAt: now - DAY
      }),
      entry('e', {
        projectId: 'p1',
        cwd: '/work',
        title: 'earlier-chat',
        lastActivityAt: now - 7 * DAY
      })
    ]
    renderWithHeading()

    for (const [group, title] of [
      ['Today', 'today-chat'],
      ['Yesterday', 'yesterday-chat'],
      ['Earlier', 'earlier-chat']
    ] as const) {
      const heading = screen.getByRole('heading', { level: 3, name: group })
      expect(heading).toHaveClass('label-group')
      const list = screen.getByRole('group', { name: group })
      expect(heading.id).not.toBe('')
      expect(list).toHaveAttribute('aria-labelledby', heading.id)
      expect(within(list).getByText(title)).toBeInTheDocument()
    }
  })

  it('does not own a scroller: the drawer body scrolls (the @container query root stays)', () => {
    seed(['one'])
    const { container } = renderWithHeading()

    expect(container.querySelector('.overflow-y-auto')).toBeNull()
    expect(container.querySelector('[class~="@container"]')).not.toBeNull()
  })

  it('makes Load more a 44px target', () => {
    sessionIndexRef.current = Array.from({ length: 60 }, (_, i) =>
      entry(`s${i}`, { projectId: 'p1', cwd: '/work', title: `chat-${i}`, lastActivityAt: 60 - i })
    )
    renderWithHeading()

    expect(screen.getByRole('button', { name: /Load more/ })).toHaveClass('min-h-11')
  })

  it('observes the lazy-load sentinel against the provided scroll root, else the viewport', () => {
    const observed: Array<{ root: Element | null; rootMargin: string }> = []
    class FakeObserver {
      constructor(_cb: unknown, options: { root: Element | null; rootMargin: string }) {
        observed.push(options)
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    sessionIndexRef.current = Array.from({ length: 60 }, (_, i) =>
      entry(`s${i}`, { projectId: 'p1', cwd: '/work', title: `chat-${i}`, lastActivityAt: 60 - i })
    )
    const scroller = document.createElement('div')

    const first = renderWithHeading({ scrollRootRef: { current: scroller } })
    expect(observed.at(-1)).toEqual({ root: scroller, rootMargin: '200px' })
    first.unmount()

    renderWithHeading()
    expect(observed.at(-1)).toEqual({ root: null, rootMargin: '200px' })
  })

  describe('delete confirm', () => {
    it('opens an AlertDialog with the existing copy and deletes nothing yet', async () => {
      seed(['First chat', 'Second chat'])
      renderWithHeading()

      fireEvent.click(screen.getByRole('button', { name: 'Delete First chat' }))

      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByText('Delete chat')).toBeInTheDocument()
      expect(
        within(dialog).getByText('Delete “First chat”? This action cannot be undone.')
      ).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveClass(
        'bg-destructive-fill',
        'text-destructive-foreground'
      )
      expect(mockDelete).not.toHaveBeenCalled()
    })

    it('Cancel deletes nothing and returns focus to that row trash button', async () => {
      seed(['First chat', 'Second chat'])
      renderWithHeading()
      const trash = screen.getByRole('button', { name: 'Delete Second chat' })

      fireEvent.click(trash)
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      await waitFor(() => expect(trash).toHaveFocus())
      expect(mockDelete).not.toHaveBeenCalled()
    })

    it('Escape deletes nothing and returns focus to that row trash button', async () => {
      seed(['First chat', 'Second chat'])
      renderWithHeading()
      const trash = screen.getByRole('button', { name: 'Delete First chat' })

      fireEvent.click(trash)
      await screen.findByRole('alertdialog')
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      await waitFor(() => expect(trash).toHaveFocus())
      expect(mockDelete).not.toHaveBeenCalled()
    })

    it('Delete runs deleteHistorySession and focuses the next visible row open button', async () => {
      seed(['First chat', 'Second chat', 'Third chat'])
      renderWithHeading()

      fireEvent.click(screen.getByRole('button', { name: 'Delete First chat' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

      expect(mockDelete).toHaveBeenCalledTimes(1)
      expect(mockDelete).toHaveBeenCalledWith('id-0')
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^Second chat/ })).toHaveFocus()
      )
    })

    it('ignores a second Delete tap while the dialog is still closing', async () => {
      seed(['First chat', 'Second chat'])
      renderWithHeading()

      fireEvent.click(screen.getByRole('button', { name: 'Delete First chat' }))
      const confirm = await screen.findByRole('button', { name: 'Delete' })
      // Both taps land before the dialog unmounts (it animates closed in a browser).
      act(() => {
        fireEvent.click(confirm)
        fireEvent.click(confirm)
      })

      expect(mockDelete).toHaveBeenCalledTimes(1)
      expect(mockDelete).toHaveBeenCalledWith('id-0')
    })

    it('allows deleting again after a fresh confirm opens for the next chat', async () => {
      seed(['First chat', 'Second chat'])
      renderWithHeading()

      fireEvent.click(screen.getByRole('button', { name: 'Delete First chat' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: 'Delete Second chat' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

      expect(mockDelete).toHaveBeenCalledTimes(2)
      expect(mockDelete).toHaveBeenLastCalledWith('id-1')
    })

    it('Delete on the last visible row moves focus to the History heading', async () => {
      seed(['First chat', 'Second chat'])
      renderWithHeading()

      fireEvent.click(screen.getByRole('button', { name: 'Delete Second chat' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

      expect(mockDelete).toHaveBeenCalledWith('id-1')
      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 2, name: 'History' })).toHaveFocus()
      )
    })

    it('falls back to the tab root when the host passes no History heading id', async () => {
      seed(['First chat', 'Second chat'])
      const { container } = render(<ChatHistoryTab />)

      fireEvent.click(screen.getByRole('button', { name: 'Delete Second chat' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

      expect(mockDelete).toHaveBeenCalledWith('id-1')
      const root = container.querySelector<HTMLElement>('[class~="@container"]')
      expect(root).toHaveAttribute('tabindex', '-1')
      await waitFor(() => expect(root).toHaveFocus())
    })

    it('falls back to the tab root when the History heading id matches no element', async () => {
      seed(['Only chat'])
      const { container } = render(<ChatHistoryTab historyHeadingId="missing-heading" />)

      fireEvent.click(screen.getByRole('button', { name: 'Delete Only chat' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

      const root = container.querySelector<HTMLElement>('[class~="@container"]')
      await waitFor(() => expect(root).toHaveFocus())
    })

    it('keeps the toast and logs a warn with the session id when the delete rejects', async () => {
      seed(['Secret title'])
      mockDelete.mockRejectedValue(new Error('boom'))
      renderWithHeading()

      fireEvent.click(screen.getByRole('button', { name: 'Delete Secret title' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('Could not delete that chat. Try again.')
      )
      expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
      const payload = mockLogFrontendError.mock.calls[0][0]
      expect(payload).toMatchObject({ level: 'warn', source: 'ChatHistoryTab.delete' })
      expect(payload.message).toContain('id-0')
      // Ids only: no title, no error text.
      expect(JSON.stringify(payload)).not.toContain('Secret title')
      expect(JSON.stringify(payload)).not.toContain('boom')
    })
  })
})
