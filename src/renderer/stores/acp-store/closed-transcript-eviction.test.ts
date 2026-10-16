/**
 * A stopped chat keeps its transcript while a chat tab shows it, and loses it
 * (#436 memory bound) when its last tab closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/acp-agents-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-agents-persistence')>()
  return {
    ...actual,
    loadAgentConfigs: vi.fn(async () => []),
    saveAgentConfigs: vi.fn(async () => {})
  }
})
vi.mock('@/lib/acp-history-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-history-persistence')>()
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    queueSessionPayloadSave: vi.fn(async () => {}),
    queueSessionPayloadDelete: vi.fn(async () => {}),
    loadSessionPayload: vi.fn(async () => null),
    loadSessionPayloadTail: vi.fn(async () => null)
  }
})
vi.mock('@/lib/acp-mcp-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-mcp-persistence')>()
  return {
    ...actual,
    loadMcpServers: vi.fn(async () => []),
    saveMcpServers: vi.fn(async () => {}),
    syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
  }
})
vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))

type TabLike = { type: string; id: string; sessionId?: string }
type PaneNodeLike = { type: string; id?: string; tabs?: TabLike[]; children?: PaneNodeLike[] }
type WorkspaceLike = { root: PaneNodeLike; parkedTrees: Record<string, { root: PaneNodeLike }> }

// A tiny workspace store: real tree shape, real subscribe(state, prev) diffing.
const { workspace } = vi.hoisted(() => {
  const listeners = new Set<(state: unknown, prev: unknown) => void>()
  const workspace = {
    state: {
      root: { type: 'leaf', id: 'pane-1', tabs: [] },
      parkedTrees: {}
    } as unknown,
    listeners,
    setState(next: unknown): void {
      const prev = workspace.state
      workspace.state = next
      for (const listener of listeners) listener(next, prev)
    }
  }
  return { workspace }
})

vi.mock('@/stores/workspace-store', () => {
  const getAllLeafPanes = (root: PaneNodeLike): PaneNodeLike[] =>
    root.type === 'leaf' ? [root] : (root.children ?? []).flatMap(getAllLeafPanes)
  const findPaneContainingTab = (root: PaneNodeLike, tabId: string): PaneNodeLike | null => {
    for (const leaf of getAllLeafPanes(root)) {
      if ((leaf.tabs ?? []).some((t) => t.id === tabId)) return leaf
    }
    return null
  }
  const getAllTreeRoots = (state: WorkspaceLike): PaneNodeLike[] => [
    state.root,
    ...Object.values(state.parkedTrees).map((tree) => tree.root)
  ]
  return {
    getAllLeafPanes,
    getAllTreeRoots,
    findPaneContainingTab,
    agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
    getAgentChatSessionIdsInAllTrees: (state: WorkspaceLike) => {
      const ids = new Set<string>()
      for (const root of getAllTreeRoots(state)) {
        for (const leaf of getAllLeafPanes(root)) {
          for (const tab of leaf.tabs ?? []) {
            if (tab.type === 'agent-chat' && tab.sessionId) ids.add(tab.sessionId)
          }
        }
      }
      return ids
    },
    useWorkspaceStore: {
      getState: () => ({
        ...(workspace.state as WorkspaceLike),
        addAgentChatTab: vi.fn(),
        removeTab: vi.fn(),
        remapAgentChatSession: vi.fn()
      }),
      subscribe: (listener: (state: unknown, prev: unknown) => void) => {
        workspace.listeners.add(listener)
        return () => workspace.listeners.delete(listener)
      }
    }
  }
})

import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport
} from '@/lib/acp-transport'
import {
  _resetCoalesceForTesting,
  initAcpEventListeners,
  type SessionStatus,
  startClosedTranscriptEviction,
  useAcpStore
} from '@/stores/acp-store'
import { liveSwitchSources } from './shared-state'
import { FRESH, seedSession } from './testkit'

const chatTab = (sessionId: string): TabLike => ({
  type: 'agent-chat',
  id: `chat-${sessionId}`,
  sessionId
})

function setTabs(tabs: TabLike[], parked: TabLike[] = []): void {
  workspace.setState({
    root: { type: 'leaf', id: 'pane-1', tabs },
    parkedTrees:
      parked.length > 0 ? { other: { root: { type: 'leaf', id: 'pane-p', tabs: parked } } } : {}
  })
}

function seedTranscript(sessionId: string): void {
  // seedSession replaces `sessions`; keep the sessions seeded before.
  const before = useAcpStore.getState().sessions
  seedSession(sessionId, 'agent-1', false)
  useAcpStore.setState((s) => ({
    sessions: { ...before, ...s.sessions },
    messages: {
      ...s.messages,
      [sessionId]: [
        {
          id: `m-${sessionId}`,
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          streaming: false,
          timestamp: 1
        }
      ]
    },
    toolCalls: {
      ...s.toolCalls,
      [sessionId]: [{ toolCallId: `tc-${sessionId}`, title: 'read', status: 'completed', seq: 1 }]
    }
  }))
}

function close(sessionId: string): void {
  useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId, reason: 'closed' })
}

function setStatus(sessionId: string, status: SessionStatus): void {
  useAcpStore.setState((s) => ({
    sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId], status } }
  }))
}

describe('closed chat transcript kept while a tab shows it', () => {
  let stop: () => void = () => {}

  afterEach(() => stop())

  beforeEach(() => {
    liveSwitchSources.clear()
    vi.clearAllMocks()
    _resetCoalesceForTesting()
    useAcpStore.setState(FRESH)
    setTabs([])
    stop = startClosedTranscriptEviction()
  })

  it('reap with the tab open keeps messages and tool calls, and projects it into the session index', () => {
    seedTranscript('s1')
    setTabs([chatTab('s1')])
    close('s1')
    const st = useAcpStore.getState()
    expect(st.sessions.s1?.status).toBe('closed')
    expect(st.messages.s1).toHaveLength(1)
    expect(st.toolCalls.s1).toHaveLength(1)
    expect(st.sessionIndex.find((e) => e.id === 's1')?.status).toBe('closed')
  })

  it('reap with the tab in a parked project tree keeps the transcript', () => {
    seedTranscript('s1')
    setTabs([], [chatTab('s1')])
    close('s1')
    expect(useAcpStore.getState().messages.s1).toHaveLength(1)
  })

  it('reap with no tab evicts the transcript (unchanged)', () => {
    seedTranscript('s1')
    close('s1')
    const st = useAcpStore.getState()
    expect(st.sessions.s1?.status).toBe('closed')
    expect(st.messages.s1).toBeUndefined()
    expect(st.toolCalls.s1).toBeUndefined()
    expect(st.sessionIndex.find((e) => e.id === 's1')?.status).toBe('closed')
  })

  it('late chunks for a kept closed session stay gated', () => {
    seedTranscript('s1')
    setTabs([chatTab('s1')])
    close('s1')
    useAcpStore.getState()._onToolCall({
      agentId: 'agent-1',
      sessionId: 's1',
      toolCall: { toolCallId: 'late', title: 'write', status: 'pending' }
    })
    expect(useAcpStore.getState().toolCalls.s1?.map((c) => c.toolCallId)).toEqual(['tc-s1'])
  })

  it('closing the last tab of a closed session evicts its transcript', () => {
    seedTranscript('s1')
    setTabs([chatTab('s1')])
    close('s1')
    setTabs([])
    const st = useAcpStore.getState()
    expect(st.messages.s1).toBeUndefined()
    expect(st.toolCalls.s1).toBeUndefined()
    expect(st.sessions.s1?.status).toBe('closed')
  })

  it('a project switch (tab moves to a parked tree) keeps the transcript', () => {
    seedTranscript('s1')
    setTabs([chatTab('s1')])
    close('s1')
    setTabs([], [chatTab('s1')])
    expect(useAcpStore.getState().messages.s1).toHaveLength(1)
  })

  it('closing a tab of a live session does not evict', () => {
    seedTranscript('s1')
    setTabs([chatTab('s1')])
    setTabs([])
    expect(useAcpStore.getState().messages.s1).toHaveLength(1)
  })

  it('closing the tab of a session resumed since its close does not evict', () => {
    seedTranscript('s1')
    setTabs([chatTab('s1')])
    close('s1')
    setStatus('s1', 'active')
    setTabs([])
    expect(useAcpStore.getState().messages.s1).toHaveLength(1)
  })

  it('an error session closed with its tab open evicts on close (not kept)', () => {
    seedTranscript('s1')
    setStatus('s1', 'error')
    setTabs([chatTab('s1')])
    close('s1')
    const st = useAcpStore.getState()
    expect(st.sessions.s1?.status).toBe('error')
    expect(st.messages.s1).toBeUndefined()
    expect(st.toolCalls.s1).toBeUndefined()
  })

  it('a kept live-switch target keeps its source link until tab-close eviction', () => {
    seedTranscript('src')
    seedTranscript('s1')
    liveSwitchSources.set('s1', 'src')
    setTabs([chatTab('s1')])
    close('s1')
    expect(useAcpStore.getState().messages.s1).toHaveLength(1)
    expect(liveSwitchSources.get('s1')).toBe('src')
    setTabs([])
    expect(useAcpStore.getState().messages.s1).toBeUndefined()
    expect(liveSwitchSources.has('s1')).toBe(false)
  })

  it('closing one tab leaves other sessions alone', () => {
    seedTranscript('s1')
    seedTranscript('s2')
    expect(Object.keys(useAcpStore.getState().sessions).sort()).toEqual(['s1', 's2'])
    setTabs([chatTab('s1'), chatTab('s2')])
    close('s1')
    close('s2')
    setTabs([chatTab('s2')])
    const st = useAcpStore.getState()
    expect(st.messages.s1).toBeUndefined()
    expect(st.messages.s2).toHaveLength(1)
  })
})

describe('initAcpEventListeners wires the tab-close eviction', () => {
  it('evicts a closed chat transcript when its last tab is removed', () => {
    vi.clearAllMocks()
    _resetCoalesceForTesting()
    useAcpStore.setState(FRESH)
    setTabs([])
    const transport = {
      setReconnectListener: vi.fn(),
      setReconnectPriorityProvider: vi.fn(),
      setRecoveryHandler: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      dispose: vi.fn()
    }
    _setAcpTransportForTests(transport as unknown as AcpTransport)
    const teardown = initAcpEventListeners()
    try {
      seedTranscript('s1')
      setTabs([chatTab('s1')])
      close('s1')
      expect(useAcpStore.getState().messages.s1).toHaveLength(1)
      setTabs([])
      expect(useAcpStore.getState().messages.s1).toBeUndefined()
    } finally {
      teardown()
      _resetAcpTransportForTests(null)
    }
  })
})
