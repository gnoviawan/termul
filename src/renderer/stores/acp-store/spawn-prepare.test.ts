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
    findPaneContainingTab,
    agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
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

import { invoke } from '@tauri-apps/api/core'
import { _resetAcpTransportForTests } from '@/lib/acp-transport'
import {
  _addEphemeralSessionIdForTesting,
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  agentReuseKey,
  isEphemeralAcpSession,
  prepareChatKey,
  reapOrphanPreparedSession,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, flushTurnEnd, seedSession } from './testkit'

describe('acp-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(invoke as ReturnType<typeof vi.fn>).mockReset()
    mockPersistenceApi.read.mockReset()
    mockPersistenceApi.write.mockReset()
    mockPersistenceApi.writeDebounced.mockReset()
    mockPersistenceApi.delete.mockReset()
    mockPersistenceApi.read.mockResolvedValue({ success: false })
    mockPersistenceApi.writeDebounced.mockResolvedValue({ success: true })
    mockPersistenceApi.delete.mockResolvedValue({ success: true })
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetAcpAuthForTesting()
    _resetInFlightPreparedForTesting()
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetLiveSwitchSourcesForTesting()
    useAcpStore.setState(FRESH)
  })

  it('createSession merges with a record created by an event during the await', async () => {
    // an event created a partial session with an error before createSession resolves
    useAcpStore.setState({
      sessions: {
        s1: {
          id: 's1',
          agentId: 'agent-1',
          cwd: '/work',
          projectId: 'p1',
          status: 'active',
          title: null,
          activeTurn: true,
          openTurnId: 'turn',
          modes: null,
          configOptions: [],
          lastError: 'early error',
          createdAt: 1
        }
      }
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1' })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    const session = useAcpStore.getState().sessions['s1']
    expect(session.lastError).toBe('early error')
    expect(session.activeTurn).toBe(true)
  })

  it('keeps an existing pending permission for a duplicate requestId', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'allow', name: 'Allow' }]
    })
    store._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-2' },
      options: [{ optionId: 'deny', name: 'Deny' }]
    })
    const pending = useAcpStore.getState().pendingPermissions['req-1']
    expect((pending.toolCall as { toolCallId: string }).toolCallId).toBe('tc-1')
  })

  it('saveAgentConfig adds then updates a config (P4)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'a1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    expect(useAcpStore.getState().agentConfigs).toHaveLength(1)
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'a1', name: 'Renamed', command: 'gemini', args: [], env: {} })
    expect(useAcpStore.getState().agentConfigs).toHaveLength(1)
    expect(useAcpStore.getState().agentConfigs[0].name).toBe('Renamed')
  })

  it('deleteAgentConfig removes a config (P4)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'a1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    await useAcpStore.getState().deleteAgentConfig('a1')
    expect(useAcpStore.getState().agentConfigs).toHaveLength(0)
  })

  it('prewarmAgent spawns and registers a live agent for the config+cwd (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      agentId: 'agent-warm',
      capabilities: {},
      authMethods: []
    })
    await useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]).toBe(
      'agent-warm'
    )
    expect(useAcpStore.getState().agentStatus['agent-warm']).toBe('connected')
  })

  it('prewarmAgent is a no-op when an empty cwd is given (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    await useAcpStore.getState().prewarmAgent('cfg-w', '   ')
    expect(invoke).not.toHaveBeenCalled()
    expect(useAcpStore.getState().configToLiveAgent).toEqual({})
  })

  it('prewarmAgent is a no-op when the config+cwd is already connected (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agentStatus: { ...s.agentStatus, 'agent-warm': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-w', '/work')]: 'agent-warm' }
    }))
    await useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    expect(invoke).not.toHaveBeenCalled()
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]).toBe(
      'agent-warm'
    )
  })

  it('prewarmAgent spawns a separate process per cwd (multi-project)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ agentId: 'agent-a', capabilities: {}, authMethods: [] })
      .mockResolvedValueOnce({ agentId: 'agent-b', capabilities: {}, authMethods: [] })
    await useAcpStore.getState().prewarmAgent('cfg-w', '/a')
    await useAcpStore.getState().prewarmAgent('cfg-w', '/b')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/a')]).toBe('agent-a')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/b')]).toBe('agent-b')
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(2)
  })

  it('prewarmAgent stays silent and leaves no mapping when spawn fails (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce('spawn boom')
    await expect(useAcpStore.getState().prewarmAgent('cfg-w', '/work')).resolves.toBeUndefined()
    expect(
      useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]
    ).toBeUndefined()
  })

  it('deleteAgentConfig clears preparedSessions for the config (GH-288)', async () => {
    const key = prepareChatKey('cfg-w', '/work', undefined)
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      preparedSessions: { ...s.preparedSessions, [key]: 'sess-prep' },
      preparingChatKeys: { ...s.preparingChatKeys, [key]: true }
    }))
    await useAcpStore.getState().deleteAgentConfig('cfg-w')
    expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined()
    expect(useAcpStore.getState().preparingChatKeys[key]).toBeUndefined()
  })

  it('deleteAgentConfig kills every per-cwd process and clears their mappings (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-a': { id: 'agent-a', capabilities: null },
        'agent-b': { id: 'agent-b', capabilities: null }
      },
      agentStatus: { ...s.agentStatus, 'agent-a': 'connected', 'agent-b': 'connected' },
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('cfg-w', '/a')]: 'agent-a',
        [agentReuseKey('cfg-w', '/b')]: 'agent-b'
      }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await useAcpStore.getState().deleteAgentConfig('cfg-w')
    expect(useAcpStore.getState().agentConfigs).toHaveLength(0)
    expect(useAcpStore.getState().configToLiveAgent).toEqual({})
    expect(invoke).toHaveBeenCalledWith('acp_kill_agent', { agentId: 'agent-a' })
    expect(invoke).toHaveBeenCalledWith('acp_kill_agent', { agentId: 'agent-b' })
  })

  it('killAgent drops any configToLiveAgent entry pointing at it (GH-288)', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-warm': { id: 'agent-warm', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-warm': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-w', '/work')]: 'agent-warm' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await useAcpStore.getState().killAgent('agent-warm')
    expect(
      useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]
    ).toBeUndefined()
  })

  it('disable while warming kills the spawned agent, leaving no orphan (GH-288 C1)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    // Spawn resolves later, simulating the slow `npx` warm-up window.
    let resolveSpawn!: (result: {
      agentId: string
      capabilities: Record<string, unknown>
      authMethods: unknown[]
    }) => void
    const spawnGate = new Promise<{
      agentId: string
      capabilities: Record<string, unknown>
      authMethods: unknown[]
    }>((r) => {
      resolveSpawn = r
    })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(spawnGate) // acp_spawn_agent (warm)
      .mockResolvedValueOnce(undefined) // acp_kill_agent
    const warm = useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    expect(useAcpStore.getState().warmingConfigs[agentReuseKey('cfg-w', '/work')]).toBe(true)
    // Disable before the spawn resolves; deleteAgentConfig must await the warm.
    const del = useAcpStore.getState().deleteAgentConfig('cfg-w')
    resolveSpawn({ agentId: 'agent-orphan', capabilities: {}, authMethods: [] })
    await Promise.all([warm, del])
    expect(useAcpStore.getState().agentConfigs).toHaveLength(0)
    expect(
      useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]
    ).toBeUndefined()
    expect(useAcpStore.getState().warmingConfigs[agentReuseKey('cfg-w', '/work')]).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('acp_kill_agent', { agentId: 'agent-orphan' })
  })

  it('concurrent prewarmAgent calls for the same cwd spawn only one process (GH-288 C2)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      agentId: 'agent-warm',
      capabilities: {},
      authMethods: []
    })
    await Promise.all([
      useAcpStore.getState().prewarmAgent('cfg-w', '/work'),
      useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    ])
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(1)
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]).toBe(
      'agent-warm'
    )
  })

  it('concurrent prewarmAgent + prepareChat for the same cwd spawn only one process', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    let resolveSpawn!: (result: {
      agentId: string
      capabilities: Record<string, unknown>
      authMethods: unknown[]
    }) => void
    const spawnGate = new Promise<{
      agentId: string
      capabilities: Record<string, unknown>
      authMethods: unknown[]
    }>((r) => {
      resolveSpawn = r
    })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(spawnGate)
      .mockResolvedValueOnce({ sessionId: 'sess-prep' })
    const warm = useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    useAcpStore.getState().prepareChat('cfg-w', '/work', undefined, 'p1')
    resolveSpawn({ agentId: 'agent-warm', capabilities: {}, authMethods: [] })
    await warm
    await vi.waitFor(() => {
      expect(Object.values(useAcpStore.getState().preparedSessions).includes('sess-prep')).toBe(
        true
      )
    })
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(1)
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]).toBe(
      'agent-warm'
    )
    expect(useAcpStore.getState().sessions['sess-prep'].agentId).toBe('agent-warm')
  })

  it('startChat awaits an in-flight warm instead of re-spawning (GH-288 C3)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    let resolveSpawn!: (result: {
      agentId: string
      capabilities: Record<string, unknown>
      authMethods: unknown[]
    }) => void
    const spawnGate = new Promise<{
      agentId: string
      capabilities: Record<string, unknown>
      authMethods: unknown[]
    }>((r) => {
      resolveSpawn = r
    })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(spawnGate) // acp_spawn_agent (warm)
      .mockResolvedValueOnce({ sessionId: 'sess-warm' }) // acp_new_session (reuse)
    const warm = useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    const chat = useAcpStore.getState().startChat('cfg-w', '/work', undefined, 'p1')
    resolveSpawn({ agentId: 'agent-warm', capabilities: {}, authMethods: [] })
    const [, sessionId] = await Promise.all([warm, chat])
    expect(sessionId).toBe('sess-warm')
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(1)
    expect(useAcpStore.getState().sessions['sess-warm'].agentId).toBe('agent-warm')
  })

  it('startChat gives the next Agent chat its own process', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ agentId: 'agent-9', capabilities: {}, authMethods: [] })
      .mockResolvedValueOnce({ sessionId: 'sess-9' })
      .mockResolvedValueOnce({ agentId: 'agent-10', capabilities: {}, authMethods: [] })
      .mockResolvedValueOnce({ sessionId: 'sess-10' })
    const first = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    const second = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    expect(first).toBe('sess-9')
    expect(second).toBe('sess-10')
    expect(useAcpStore.getState().sessions['sess-9'].agentId).toBe('agent-9')
    expect(useAcpStore.getState().sessions['sess-10'].agentId).toBe('agent-10')
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(2)
  })

  it('startChat spawns a configured agent then creates a session (P4)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ agentId: 'agent-9', capabilities: {}, authMethods: [] })
      .mockResolvedValueOnce({ sessionId: 'sess-9' })
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    expect(sessionId).toBe('sess-9')
    expect(useAcpStore.getState().sessions['sess-9'].agentId).toBe('agent-9')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/work')]).toBe(
      'agent-9'
    )
  })

  it('startChat reuses a prepared session from prepareChat (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      // Clear `selectedAgentConfigId` so `promotePreparedSession` does not
      // trigger warm-pool refilling — the refill's `session/new` would race
      // the call-count assertion below (it lands before the assertion now
      // that `createSession` runs session/new without a preemptive-auth
      // microtask hop).
      selectedAgentConfigId: null,
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-prep' })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    await vi.waitFor(() => {
      expect(Object.values(useAcpStore.getState().preparedSessions).includes('sess-prep')).toBe(
        true
      )
    })
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    expect(sessionId).toBe('sess-prep')
    // GH-288: reusing the prepared session means exactly ONE session/new.
    const newSessionCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'acp_new_session')
    expect(newSessionCalls).toHaveLength(1)
    // Story 8: the warm seed is backend-ephemeral + promotable on the wire.
    expect(newSessionCalls[0]?.[1]).toEqual({
      agentId: 'agent-9',
      cwd: '/work',
      mcpServers: [],
      ephemeral: true,
      promotable: true,
      projectId: 'p1'
    })
    // …and claiming it fires exactly one backend promote (durability handoff).
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === 'acp_promote_session')
    ).toHaveLength(1)
  })

  it('records and clears prepareChat failures', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce('session/new timed out after 30s')

    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]).toEqual({
        category: 'timeout',
        label: 'Session setup timed out',
        detail: 'session/new timed out after 30s'
      })
    })
    expect(useAcpStore.getState().preparingChatKeys[key]).toBeUndefined()
    expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined()

    useAcpStore.getState().cancelPreparedChat(key)
    expect(useAcpStore.getState().prepareChatErrors[key]).toBeUndefined()
  })

  it('cancelPreparedChat does not close or delete an indexed persisted session (#882)', async () => {
    seedSession('s-real', 'agent-1', true)
    const key = prepareChatKey('cfg-1', '/work', undefined)
    useAcpStore.setState({
      preparedSessions: { [key]: 's-real' },
      sessionIndex: [
        {
          id: 's-real',
          agentId: 'agent-1',
          title: 'Real chat',
          cwd: '/work',
          projectId: 'p1',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 1,
          status: 'active'
        }
      ]
    })

    useAcpStore.getState().cancelPreparedChat(key)
    await flushTurnEnd()

    expect(useAcpStore.getState().sessions['s-real']?.status).toBe('active')
    expect(useAcpStore.getState().sessionIndex.some((entry) => entry.id === 's-real')).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('acp_close_session', expect.anything())
  })

  it('reapOrphanPreparedSession does not close an indexed session, including a launch- id (#882)', () => {
    seedSession('launch-persisted', 'agent-1', true)
    useAcpStore.setState({
      activeSessionId: 'launch-persisted',
      sessionIndex: [
        {
          id: 'launch-persisted',
          agentId: 'agent-1',
          title: 'Indexed launch id',
          cwd: '/work',
          projectId: 'p1',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 1,
          status: 'active'
        }
      ]
    })
    _addEphemeralSessionIdForTesting('launch-persisted')

    reapOrphanPreparedSession(useAcpStore.getState, useAcpStore.setState, 'launch-persisted')

    expect(useAcpStore.getState().sessions['launch-persisted']?.status).toBe('active')
    expect(useAcpStore.getState().activeSessionId).toBe('launch-persisted')
    expect(
      useAcpStore.getState().sessionIndex.some((entry) => entry.id === 'launch-persisted')
    ).toBe(true)
    expect(isEphemeralAcpSession('launch-persisted')).toBe(false)
    expect(invoke).not.toHaveBeenCalledWith('acp_close_session', expect.anything())
  })

  it('prepareChat caches models/modes/configOptions for the agent config id', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sessionId: 'sess-cache',
      models: {
        currentModelId: 'm1',
        availableModels: [{ modelId: 'm1', name: 'Model One' }]
      },
      modes: {
        currentModeId: 'agent',
        availableModes: [{ id: 'agent', name: 'Agent' }]
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'm1',
          options: [{ value: 'm1', name: 'Model One' }]
        }
      ]
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    await vi.waitFor(() => {
      expect(
        useAcpStore.getState().preparedSessions[prepareChatKey('cfg-1', '/work', undefined)]
      ).toBe('sess-cache')
    })
    const cached = useAcpStore.getState().agentOptionsCache['cfg-1']
    expect(cached?.models?.currentModelId).toBe('m1')
    expect(cached?.modes?.currentModeId).toBe('agent')
    expect(cached?.configOptions[0]?.currentValue).toBe('m1')
  })

  it('cancelPreparedChat + reopen does not let a stale prepare clobber the newer one', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    const sessionResults: unknown[] = []
    let resolveFirst!: (value: unknown) => void
    const firstGate = new Promise((resolve) => {
      resolveFirst = resolve
    })
    sessionResults.push(firstGate, { sessionId: 'sess-second' })
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === 'acp_new_session') {
        const next = sessionResults.shift()
        return next instanceof Promise ? next : Promise.resolve(next)
      }
      if (cmd === 'acp_close_session' || cmd === 'acp_kill_agent') return Promise.resolve(undefined)
      return undefined
    })

    const key = prepareChatKey('cfg-1', '/work', undefined)
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    expect(useAcpStore.getState().preparingChatKeys[key]).toBe(true)
    // Wait until the first prepare has actually entered session/new (consumed the gate).
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('acp_new_session', expect.anything())
    })

    useAcpStore.getState().cancelPreparedChat(key)
    expect(useAcpStore.getState().preparingChatKeys[key]).toBeUndefined()

    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    expect(useAcpStore.getState().preparingChatKeys[key]).toBe(true)

    await vi.waitFor(() => {
      expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-second')
    })
    expect(useAcpStore.getState().preparingChatKeys[key]).toBeUndefined()

    // Stale first prepare resolves after the newer one finished — must not clobber,
    // and the orphan session from the stale create must be reaped.
    resolveFirst({ sessionId: 'sess-stale' })
    await flushTurnEnd()
    expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-second')
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('acp_close_session', {
        agentId: 'agent-9',
        sessionId: 'sess-stale'
      })
    })
    expect(useAcpStore.getState().sessions['sess-stale']?.status).toBe('closed')
  })

  it('stale prepare resolving while newer is still in flight keeps preparingChatKeys', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    const firstGate = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const secondGate = new Promise((resolve) => {
      resolveSecond = resolve
    })
    const sessionResults: unknown[] = [firstGate, secondGate]
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === 'acp_new_session') {
        const next = sessionResults.shift()
        return next instanceof Promise ? next : Promise.resolve(next)
      }
      if (cmd === 'acp_close_session') return Promise.resolve(undefined)
      return undefined
    })

    const key = prepareChatKey('cfg-1', '/work', undefined)
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('acp_new_session', expect.anything())
    })
    useAcpStore.getState().cancelPreparedChat(key)
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    expect(useAcpStore.getState().preparingChatKeys[key]).toBe(true)

    // Stale create completes while newer prepare is still awaiting session/new.
    resolveFirst({ sessionId: 'sess-stale' })
    await flushTurnEnd()
    expect(useAcpStore.getState().preparingChatKeys[key]).toBe(true)
    expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined()

    resolveSecond({ sessionId: 'sess-second' })
    await vi.waitFor(() => {
      expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-second')
    })
    expect(useAcpStore.getState().preparingChatKeys[key]).toBeUndefined()
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('acp_close_session', {
        agentId: 'agent-9',
        sessionId: 'sess-stale'
      })
    })
  })

  it('startChat after cancel+reopen reuses the newer prepare instead of duplicating', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      // Clear `selectedAgentConfigId` so `promotePreparedSession` does not
      // trigger warm-pool refilling (which would create an extra pooled
      // session unrelated to the cancel+reopen behavior under test).
      selectedAgentConfigId: null,
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    let resolveFirst!: (value: unknown) => void
    const firstGate = new Promise((resolve) => {
      resolveFirst = resolve
    })
    // Track every created/closed session id so we can assert "no orphans":
    // every session created by `acp_new_session` must be either the one
    // `startChat` returns (`sess-reopen`) or explicitly closed via
    // `acp_close_session`. This pins the duplicate-prevention guarantee
    // without depending on the exact `session/new` call count (which varies
    // with microtask timing under the synchronous authenticate path).
    const createdSessions: string[] = []
    const closedSessions: string[] = []
    let nextSessionId = 0
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'acp_new_session') {
        if (nextSessionId === 0) {
          // First call: gated, will resolve to 'sess-stale' (the cancelled prepare).
          createdSessions.push('sess-stale')
          nextSessionId++
          return firstGate
        }
        // Second call: the newer prepare's session. Any additional calls
        // (startChat fallback) get a distinguishable 'sess-extra-N' id so
        // the orphan check can detect them if they're not closed.
        const sid = nextSessionId === 1 ? 'sess-reopen' : `sess-extra-${nextSessionId}`
        createdSessions.push(sid)
        nextSessionId++
        return Promise.resolve({ sessionId: sid })
      }
      if (cmd === 'acp_close_session') {
        const closeArgs = args as { sessionId?: string }
        if (closeArgs?.sessionId) closedSessions.push(closeArgs.sessionId)
        return Promise.resolve(undefined)
      }
      return undefined
    })

    const key = prepareChatKey('cfg-1', '/work', undefined)
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('acp_new_session', expect.anything())
    })
    // startChat awaits the first (about-to-be-cancelled) prepare…
    const started = useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    useAcpStore.getState().cancelPreparedChat(key)
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    // …which returns null; startChat must pick up the newer prepare.
    resolveFirst({ sessionId: 'sess-stale' })
    const returnedId = await started
    expect(returnedId).toBe('sess-reopen')
    // Let async cleanup (orphan reaping → acp_close_session) settle.
    await flushTurnEnd()
    await vi.waitFor(() => {
      // No orphaned sessions: every created session is either the returned
      // one ('sess-reopen') or explicitly closed via `acp_close_session`.
      for (const sid of createdSessions) {
        const isReturned = sid === 'sess-reopen'
        const isClosed = closedSessions.includes(sid)
        if (!isReturned && !isClosed) {
          throw new Error(`orphaned session ${sid} was neither returned nor closed`)
        }
      }
    })
  })

  it('startChat awaits an in-flight prepare (send-while-cold)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    let resolveSession!: (value: unknown) => void
    const sessionGate = new Promise((resolve) => {
      resolveSession = resolve
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === 'acp_new_session') return sessionGate
      return undefined
    })

    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const started = useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    resolveSession({ sessionId: 'sess-cold' })
    await expect(started).resolves.toBe('sess-cold')
  })

  it('invalidates options cache when agent cmd/args/env identity changes', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState({
      agents: { 'agent-warm': { id: 'agent-warm', capabilities: null } },
      agentStatus: { 'agent-warm': 'connected' },
      configToLiveAgent: { [agentReuseKey('cfg-1', '/work')]: 'agent-warm' },
      agentOptionsCache: {
        'cfg-1': {
          models: {
            currentModelId: 'old',
            availableModels: [{ modelId: 'old', name: 'Old' }]
          },
          modes: null,
          configOptions: [],
          updatedAt: 1
        }
      }
    })
    await useAcpStore.getState().saveAgentConfig({
      id: 'cfg-1',
      name: 'Gemini',
      command: 'gemini',
      args: ['--new'],
      env: {}
    })
    expect(useAcpStore.getState().agentOptionsCache['cfg-1']).toBeUndefined()
    // Warm process is not killed solely for options-cache invalidation.
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/work')]).toBe(
      'agent-warm'
    )
    expect(invoke).not.toHaveBeenCalledWith('acp_kill_agent', expect.anything())
  })

  it('invalidates options cache on command-only identity change', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState({
      agentOptionsCache: {
        'cfg-1': {
          models: null,
          modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }] },
          configOptions: [],
          updatedAt: 1
        }
      }
    })
    await useAcpStore.getState().saveAgentConfig({
      id: 'cfg-1',
      name: 'Gemini',
      command: '/usr/local/bin/gemini',
      args: [],
      env: {}
    })
    expect(useAcpStore.getState().agentOptionsCache['cfg-1']).toBeUndefined()
  })

  it('invalidates options cache on env-only identity change', async () => {
    await useAcpStore.getState().saveAgentConfig({
      id: 'cfg-1',
      name: 'Gemini',
      command: 'gemini',
      args: [],
      env: { B: '2', A: '1' }
    })
    useAcpStore.setState({
      agentOptionsCache: {
        'cfg-1': {
          models: null,
          modes: null,
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'm1',
              options: [{ value: 'm1', name: 'M1' }]
            }
          ],
          updatedAt: 1
        }
      }
    })
    // Same keys different order must NOT invalidate (canonicalized).
    await useAcpStore.getState().saveAgentConfig({
      id: 'cfg-1',
      name: 'Gemini',
      command: 'gemini',
      args: [],
      env: { A: '1', B: '2' }
    })
    expect(useAcpStore.getState().agentOptionsCache['cfg-1']).toBeDefined()
    await useAcpStore.getState().saveAgentConfig({
      id: 'cfg-1',
      name: 'Gemini',
      command: 'gemini',
      args: [],
      env: { A: '1', B: 'changed' }
    })
    expect(useAcpStore.getState().agentOptionsCache['cfg-1']).toBeUndefined()
  })

  it('does not invalidate options cache on name-only agent config edits', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState({
      agentOptionsCache: {
        'cfg-1': {
          models: null,
          modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }] },
          configOptions: [],
          updatedAt: 1
        }
      }
    })
    await useAcpStore.getState().saveAgentConfig({
      id: 'cfg-1',
      name: 'Gemini Renamed',
      command: 'gemini',
      args: [],
      env: {}
    })
    expect(useAcpStore.getState().agentOptionsCache['cfg-1']?.modes?.currentModeId).toBe('agent')
  })

  it('deleteAgentConfig clears agentOptionsCache for that config', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState({
      agentOptionsCache: {
        'cfg-1': {
          models: null,
          modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }] },
          configOptions: [],
          updatedAt: 1
        },
        'cfg-other': {
          models: null,
          modes: null,
          configOptions: [],
          updatedAt: 1
        }
      }
    })
    await useAcpStore.getState().deleteAgentConfig('cfg-1')
    expect(useAcpStore.getState().agentOptionsCache['cfg-1']).toBeUndefined()
    expect(useAcpStore.getState().agentOptionsCache['cfg-other']).toBeDefined()
  })

  it('setModel/setMode/setConfigOption refresh agentOptionsCache when agent is mapped', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-live', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-live': {
          ...s.sessions['sess-live'],
          modes: {
            currentModeId: 'agent',
            availableModes: [
              { id: 'agent', name: 'Agent' },
              { id: 'plan', name: 'Plan' }
            ]
          },
          models: {
            currentModelId: 'm1',
            availableModels: [
              { modelId: 'm1', name: 'Model One' },
              { modelId: 'm2', name: 'Model Two' }
            ]
          },
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'm1',
              options: [
                { value: 'm1', name: 'Model One' },
                { value: 'm2', name: 'Model Two' }
              ]
            }
          ]
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // set_model
      .mockResolvedValueOnce(undefined) // set_mode
      .mockResolvedValueOnce([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'm2',
          options: [
            { value: 'm1', name: 'Model One' },
            { value: 'm2', name: 'Model Two' }
          ]
        }
      ])

    await useAcpStore.getState().setModel('sess-live', 'm2')
    expect(useAcpStore.getState().agentOptionsCache['cfg-1']?.models?.currentModelId).toBe('m2')

    await useAcpStore.getState().setMode('sess-live', 'plan')
    expect(useAcpStore.getState().agentOptionsCache['cfg-1']?.modes?.currentModeId).toBe('plan')

    await useAcpStore.getState().setConfigOption('sess-live', 'model', 'm2')
    expect(useAcpStore.getState().agentOptionsCache['cfg-1']?.configOptions[0]?.currentValue).toBe(
      'm2'
    )
  })

  it('preserves model options and updates selection when Droid omits configOptions', async () => {
    await useAcpStore.getState().saveAgentConfig({
      id: 'factory-droid',
      name: 'Factory Droid',
      command: 'droid',
      args: [],
      env: {}
    })
    const options = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'm1',
        options: [
          { value: 'm1', name: 'Model One' },
          { value: 'm2', name: 'Model Two' }
        ]
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning',
        type: 'select',
        currentValue: 'low',
        options: [{ value: 'low', name: 'Low' }]
      }
    ]
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      sessions: {
        ...s.sessions,
        'sess-live': { ...s.sessions['sess-live'], agentId: 'agent-9', configOptions: options }
      },
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('factory-droid', '/work')]: 'agent-9'
      }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    await useAcpStore.getState().setConfigOption('sess-live', 'model', 'm2')
    const updated = useAcpStore.getState().sessions['sess-live'].configOptions
    expect(updated?.map((option) => option.id)).toEqual(['model', 'reasoning_effort'])
    expect(updated?.[0]?.currentValue).toBe('m2')
    expect(updated?.[1]?.currentValue).toBe('low')
    expect(useAcpStore.getState().agentOptionsCache['factory-droid']?.configOptions).toEqual(
      updated
    )
  })

  it('startChat reuses a connected agent instead of re-spawning (P4)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-2' })
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    expect(sessionId).toBe('sess-2')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('acp_new_session', {
      agentId: 'agent-9',
      cwd: '/work',
      mcpServers: [],
      projectId: 'p1'
    })
  })

  it('testConnection spawns then always kills the test process (P4)', async () => {
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        agentId: 'agent-test',
        capabilities: { loadSession: true },
        authMethods: []
      })
      .mockResolvedValueOnce(undefined)
    // CAP-4: the spawn response carries capabilities synchronously, so
    // `testConnection` reads them directly from `result.capabilities` — no
    // store pre-seed or capability wait needed.
    const caps = await useAcpStore
      .getState()
      .testConnection({ name: 'X', command: 'x', args: [], env: {} })
    expect(caps).toEqual({ loadSession: true })
    expect(invoke).toHaveBeenNthCalledWith(1, 'acp_spawn_agent', {
      config: { name: 'X', command: 'x', args: [], env: {} }
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'acp_kill_agent', { agentId: 'agent-test' })
    expect(useAcpStore.getState().agents['agent-test']).toBeUndefined()
  })
})
