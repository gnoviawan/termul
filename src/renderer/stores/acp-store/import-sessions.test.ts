import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError, toastWarning } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastError, warning: toastWarning }
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('./slices/agent', async (orig) => {
  const actual = await orig<typeof import('./slices/agent')>()
  return { ...actual, withAuthRetry: vi.fn(actual.withAuthRetry) }
})
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))
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
    // Read-through the module-level cache so tests can seed payloads via
    // setCachedSessionPayload (preferred over per-test mockResolvedValue).
    loadSessionPayload: vi.fn(async (id: string) => actual.getCachedSessionPayload(id) ?? null),
    // Tail-first: the store calls `loadSessionPayloadTail` first, then falls
    // back to `loadSessionPayload`. Mock both to the same cache-backed fn so
    // per-test `mockResolvedValueOnce` on `loadSessionPayload` still fires
    // (the tail mock returns null when no cache is seeded → fallback runs).
    // The CAP-7 chain walk uses the (cache-backed) full loader for hop
    // resolution — the tail mock's null never blocks it.
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

// Spies for the switch-back reopen branch (addAgentChatTab +
// setTabFocusedSessionId). `getTabFocusedSessionId` returns null so
// switchProject falls back to `activeSessionId` (matching the real behavior
// when no tab focus is set). `workspaceStateRef` is the fake surface for the
// corpse-tab prune (loadSessionIndex) + failed-launch tab remap
// (retryFailedLaunch): seed `.root` with pane trees and observe the spies.
const { addAgentChatTabSpy, setTabFocusedSessionIdSpy, workspaceStateRef } = vi.hoisted(() => ({
  addAgentChatTabSpy: vi.fn(),
  setTabFocusedSessionIdSpy: vi.fn(),
  workspaceStateRef: {
    current: {
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    }
  }
}))

vi.mock('@/stores/workspace-store', () => {
  // Local mirrors of the real pane helpers (importing the real module would
  // drag terminal-store/router side effects into this suite).
  type PaneNodeLike = {
    type: string
    tabs?: Array<{ type: string; id: string; sessionId?: string }>
    children?: PaneNodeLike[]
  }
  const getAllLeafPanes = (root: PaneNodeLike): PaneNodeLike[] =>
    root.type === 'leaf' ? [root] : (root.children ?? []).flatMap(getAllLeafPanes)
  const findPaneContainingTab = (root: PaneNodeLike, tabId: string): PaneNodeLike | null => {
    for (const leaf of getAllLeafPanes(root)) {
      if ((leaf.tabs ?? []).some((t) => t.id === tabId)) return leaf
    }
    return null
  }
  return {
    getAllLeafPanes,
    getAllTreeRoots: (state: { root: PaneNodeLike }) => [state.root],
    findPaneContainingTab,
    agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
    getAgentChatSessionIdsInAllTrees: () => new Set<string>(),
    useWorkspaceStore: {
      getState: () => ({
        addAgentChatTab: addAgentChatTabSpy,
        removeTab: workspaceStateRef.current.removeTab,
        remapAgentChatSession: workspaceStateRef.current.remapAgentChatSession,
        root: workspaceStateRef.current.root
      })
    }
  }
})

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: setTabFocusedSessionIdSpy,
  getTabFocusedSessionId: vi.fn(() => null)
}))

// Mock persistenceApi so composer-selection persistence calls are observable
// in tests without hitting the Tauri plugin-store transport. Preserve other
// `@/lib/api` exports via importActual so transitive imports still resolve.
const { mockPersistenceApi, mockListCatalog } = vi.hoisted(() => ({
  mockPersistenceApi: {
    // Defaults reproduce the implementation leak the single-file suite relied
    // on; tests override per-test via mockResolvedValue(Once) as before.
    read: vi.fn(async () => ({ success: false })),
    write: vi.fn(),
    writeDebounced: vi.fn(async () => ({ success: true })),
    // Story 3 (spec-in-chat-agent-switch): the switch clears the old
    // session's composer draft via persistenceApi.delete.
    delete: vi.fn(async () => ({ success: true }))
  },
  mockListCatalog: vi.fn()
}))
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: mockPersistenceApi,
    acpCatalogApi: { ...actual.acpCatalogApi, listCatalog: mockListCatalog }
  }
})

import { acpApi } from '@/lib/acp-api'
import { AcpTransportError } from '@/lib/acp-transport'
import { agentReuseKey } from '@/stores/acp-reuse-keys'
import { useAcpStore } from '@/stores/acp-store'
import { withAuthRetry } from './slices/agent'
import { FRESH } from './testkit'

const CAPABLE = {
  id: 'agent-1',
  capabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } }
}

function seedAgent(capabilities: Record<string, unknown> = CAPABLE.capabilities): void {
  useAcpStore.setState({
    ...FRESH,
    agentConfigs: [
      { id: 'cfg-1', name: 'Claude', command: 'claude-agent-acp', args: [], env: {} }
    ] as never,
    agents: { 'agent-1': { id: 'agent-1', capabilities } as never },
    agentStatus: { 'agent-1': 'connected' },
    configToLiveAgent: { [agentReuseKey('cfg-1', '/work', 'p1')]: 'agent-1' }
  })
}

describe('listImportableSessions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(withAuthRetry).mockClear()
    seedAgent()
  })

  it('lists the agent sessions that are not yet in the chat history, across pages', async () => {
    useAcpStore.setState({
      sessionIndex: [{ id: 'known', title: 'Known' }] as never
    })
    const list = vi
      .spyOn(acpApi, 'listSessions')
      .mockResolvedValueOnce({
        sessions: [
          { sessionId: 'a', cwd: '/work', title: 'A' },
          { sessionId: 'known', cwd: '/work', title: 'Known' }
        ],
        nextCursor: ''
      })
      .mockResolvedValueOnce({
        sessions: [
          { sessionId: 'a', cwd: '/work', title: 'A again' },
          { sessionId: 'b', cwd: '/work', title: 'B' }
        ],
        nextCursor: null
      })

    const result = await useAcpStore.getState().listImportableSessions('cfg-1', '/work', 'p1')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.agentId).toBe('agent-1')
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['a', 'b'])
    expect(list).toHaveBeenNthCalledWith(1, 'agent-1', '/work', undefined)
    expect(list).toHaveBeenNthCalledWith(2, 'agent-1', '/work', '')
  })

  it('keeps listing past the tenth page', async () => {
    const list = vi.spyOn(acpApi, 'listSessions')
    for (let page = 0; page < 12; page++) {
      list.mockResolvedValueOnce({
        sessions: [{ sessionId: `s${page}`, cwd: '/work', title: `S${page}` }],
        nextCursor: page < 11 ? `c${page}` : null
      })
    }

    const result = await useAcpStore.getState().listImportableSessions('cfg-1', '/work', 'p1')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.sessions).toHaveLength(12)
    expect(list).toHaveBeenCalledTimes(12)
  })

  it('stops listing when the agent repeats a cursor', async () => {
    const list = vi.spyOn(acpApi, 'listSessions').mockResolvedValue({
      sessions: [{ sessionId: 'a', cwd: '/work', title: 'A' }],
      nextCursor: 'same'
    })

    const result = await useAcpStore.getState().listImportableSessions('cfg-1', '/work', 'p1')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['a'])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('offers nothing when the agent cannot list or load sessions', async () => {
    seedAgent({ loadSession: false, sessionCapabilities: { list: {} } })
    const list = vi.spyOn(acpApi, 'listSessions')

    const result = await useAcpStore.getState().listImportableSessions('cfg-1', '/work', 'p1')

    expect(result).toEqual({ status: 'unsupported' })
    expect(list).not.toHaveBeenCalled()
  })

  it('lists through the authenticate-on-demand retry', async () => {
    vi.spyOn(acpApi, 'listSessions').mockResolvedValue({ sessions: [], nextCursor: null })

    await useAcpStore.getState().listImportableSessions('cfg-1', '/work', 'p1')

    expect(withAuthRetry).toHaveBeenCalledWith(
      expect.any(Function),
      'agent-1',
      'session/list',
      'text',
      expect.any(Function)
    )
  })

  it('reports the agent unavailable when it disconnects while listing', async () => {
    vi.spyOn(acpApi, 'listSessions').mockImplementation(async () => {
      useAcpStore.setState({ agentStatus: { 'agent-1': 'error' } })
      return { sessions: [{ sessionId: 'a', cwd: '/work' }], nextCursor: null }
    })

    const result = await useAcpStore.getState().listImportableSessions('cfg-1', '/work', 'p1')

    expect(result).toEqual({ status: 'unavailable' })
  })

  it('lets a listing failure reach the caller', async () => {
    vi.spyOn(acpApi, 'listSessions').mockRejectedValue(new Error('list failed'))
    await expect(
      useAcpStore.getState().listImportableSessions('cfg-1', '/work', 'p1')
    ).rejects.toThrow('list failed')
  })
})

describe('importAgentSessions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(withAuthRetry).mockClear()
    seedAgent()
  })

  it('imports each session, tells duplicates and failures apart, and refreshes the index', async () => {
    const importOne = vi
      .spyOn(acpApi, 'importAgentSession')
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new AcpTransportError('duplicate', 'already known'))
      .mockRejectedValueOnce(new Error('agent exploded'))
    const loadSessionIndex = vi.fn(async () => {})
    useAcpStore.setState({ loadSessionIndex })
    const progress: number[] = []

    const outcomes = await useAcpStore.getState().importAgentSessions({
      agentId: 'agent-1',
      cwd: '/work',
      projectId: 'p1',
      sessions: [
        { sessionId: 'a', cwd: '/work/sub', title: 'A', updatedAt: '2026-11-01T10:00:00.000Z' },
        { sessionId: 'b', cwd: '/work', title: 'B' },
        { sessionId: 'c', cwd: '/work', title: 'C' }
      ],
      onProgress: (done) => progress.push(done)
    })

    expect(outcomes).toEqual([
      { sessionId: 'a', status: 'imported' },
      { sessionId: 'b', status: 'duplicate' },
      { sessionId: 'c', status: 'failed', message: 'agent exploded' }
    ])
    expect(progress).toEqual([1, 2, 3])
    expect(importOne).toHaveBeenNthCalledWith(1, {
      agentId: 'agent-1',
      sessionId: 'a',
      cwd: '/work/sub',
      title: 'A',
      updatedAt: Date.parse('2026-11-01T10:00:00.000Z'),
      projectId: 'p1'
    })
    expect(loadSessionIndex).toHaveBeenCalledTimes(1)
    expect(withAuthRetry).toHaveBeenCalledTimes(3)
    expect(withAuthRetry).toHaveBeenCalledWith(
      expect.any(Function),
      'agent-1',
      'session/load',
      'text',
      expect.any(Function)
    )
  })
})
