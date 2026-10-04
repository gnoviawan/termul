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
import { _resetAcpAuthForTesting, discoveryKey, useAcpStore } from '@/stores/acp-store'
import { deferred, FRESH, seedSession } from './testkit'

describe('session discovery (gh-407)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    _resetAcpAuthForTesting()
    useAcpStore.setState({
      ...FRESH,
      agents: {},
      agentStatus: {},
      discoveredSessions: {},
      discoveringKeys: {}
    })
  })

  it('discoverSessions skips agents without sessionCapabilities.list', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': { id: 'agent-1', capabilities: { loadSession: false } }
      },
      agentStatus: { 'agent-1': 'connected' }
    })
    await useAcpStore.getState().discoverSessions('agent-1', '/work')
    // invoke should not have been called for acp_list_sessions
    const listCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_list_sessions')
    expect(listCalls).toHaveLength(0)
    // No discovered sessions stored.
    expect(
      useAcpStore.getState().discoveredSessions[discoveryKey('agent-1', '/work')]
    ).toBeUndefined()
  })

  it('discoverSessions skips agents that are not connected (stale after disconnect)', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          capabilities: { loadSession: false, sessionCapabilities: { list: {} } }
        }
      },
      // _onAgentDisconnected leaves the agent present but flips status to 'error'.
      agentStatus: { 'agent-1': 'error' }
    })
    await useAcpStore.getState().discoverSessions('agent-1', '/work')
    const listCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_list_sessions')
    expect(listCalls).toHaveLength(0)
    expect(
      useAcpStore.getState().discoveredSessions[discoveryKey('agent-1', '/work')]
    ).toBeUndefined()
  })

  it('discoverSessions treats an empty-string cursor as a valid page token', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          capabilities: { loadSession: false, sessionCapabilities: { list: {} } }
        }
      },
      agentStatus: { 'agent-1': 'connected' }
    })
    let callCount = 0
    vi.mocked(invoke).mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // Opaque empty-string cursor must NOT end pagination.
        return { sessions: [{ sessionId: 'sess-1', cwd: '/work' }], nextCursor: '' }
      }
      return { sessions: [{ sessionId: 'sess-2', cwd: '/work' }], nextCursor: null }
    })
    await useAcpStore.getState().discoverSessions('agent-1', '/work')
    const listCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_list_sessions')
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1]![1]).toMatchObject({ cursor: '' })
    const discovered = useAcpStore.getState().discoveredSessions[discoveryKey('agent-1', '/work')]
    expect(discovered).toHaveLength(2)
  })

  it('discoverSessions calls acp_list_sessions when list capability is advertised', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          capabilities: { loadSession: false, sessionCapabilities: { list: {} } }
        }
      },
      agentStatus: { 'agent-1': 'connected' }
    })
    vi.mocked(invoke).mockResolvedValue({
      sessions: [{ sessionId: 'sess-1', cwd: '/work', title: 'Test Session' }],
      nextCursor: null
    })
    await useAcpStore.getState().discoverSessions('agent-1', '/work')
    const listCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_list_sessions')
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]![1]).toMatchObject({ agentId: 'agent-1', cwd: '/work' })
    const discovered = useAcpStore.getState().discoveredSessions[discoveryKey('agent-1', '/work')]
    expect(discovered).toHaveLength(1)
    expect(discovered![0]!.sessionId).toBe('sess-1')
  })

  it('discoverSessions does not promote discovered sessions into host persistence', async () => {
    // External/CLI sessions surfaced by session/list must NOT be written to the
    // Rust index nor merged into sessionIndex — the Chats tab shows only
    // Termul-created sessions (`discovered !== true`). Promotion was removed.
    useAcpStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          capabilities: { loadSession: false, sessionCapabilities: { list: {} } }
        }
      },
      agentStatus: { 'agent-1': 'connected' },
      sessionIndex: []
    })
    vi.mocked(invoke).mockResolvedValue({
      sessions: [{ sessionId: 'sess-external', cwd: '/work', title: 'CLI chat' }],
      nextCursor: null
    })
    await useAcpStore.getState().discoverSessions('agent-1', '/work')
    // No register_discovered_session IPC issued.
    const registerCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === 'acp_register_discovered_session')
    expect(registerCalls).toHaveLength(0)
    // sessionIndex stays empty — external sessions are not promoted.
    expect(useAcpStore.getState().sessionIndex).toEqual([])
  })

  it('persistSession keeps a discovered session hidden through close/disconnect projection', () => {
    // Regression: openDiscoveredSession creates a session with `discovered: true`
    // but no sessionIndex entry. _onSessionClosed/_onAgentDisconnected still call
    // persistSession, which must preserve `discovered: true` so the external
    // session does not leak into the Termul-only Chats tab as `discovered: false`.
    useAcpStore.setState({
      ...FRESH,
      sessionIndex: [],
      sessions: {
        'disc-1': {
          id: 'disc-1',
          agentId: 'agent-1',
          cwd: '/work',
          projectId: 'p1',
          status: 'active',
          title: null,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: Date.now(),
          discovered: true
        }
      },
      messages: {
        'disc-1': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'hi' }],
            streaming: false,
            timestamp: 0,
            seq: 1
          }
        ]
      }
    })

    // Closing the session triggers persistSession projection.
    useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId: 'disc-1' })

    const projected = useAcpStore.getState().sessionIndex.find((e) => e.id === 'disc-1')
    // If projected at all, it MUST keep `discovered: true` — never `false`
    // (which would surface it in the Chats tab).
    if (projected) expect(projected.discovered).toBe(true)
  })

  it('discoverSessions paginates, forwards the cursor, and de-dupes by sessionId', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          capabilities: { loadSession: false, sessionCapabilities: { list: {} } }
        }
      },
      agentStatus: { 'agent-1': 'connected' }
    })
    let callCount = 0
    vi.mocked(invoke).mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          sessions: [{ sessionId: 'sess-1', cwd: '/work' }],
          nextCursor: 'cursor-1'
        }
      }
      return {
        // sess-1 repeated across pages must be de-duped; sess-2 is new.
        sessions: [
          { sessionId: 'sess-1', cwd: '/work' },
          { sessionId: 'sess-2', cwd: '/work' }
        ],
        nextCursor: null
      }
    })
    await useAcpStore.getState().discoverSessions('agent-1', '/work')
    const listCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_list_sessions')
    expect(listCalls).toHaveLength(2)
    // First request carries no cursor; second forwards the first response's nextCursor.
    expect(listCalls[0]![1]).toMatchObject({ agentId: 'agent-1', cwd: '/work' })
    expect(listCalls[0]![1]).not.toHaveProperty('cursor', 'cursor-1')
    expect(listCalls[1]![1]).toMatchObject({ cursor: 'cursor-1' })
    const discovered = useAcpStore.getState().discoveredSessions[discoveryKey('agent-1', '/work')]
    // De-duped: sess-1 (twice) + sess-2 → 2 entries, order preserved.
    expect(discovered).toHaveLength(2)
    expect(discovered![0]!.sessionId).toBe('sess-1')
    expect(discovered![1]!.sessionId).toBe('sess-2')
  })

  it('discoverSessions clears discovered entries on failure', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          capabilities: { loadSession: false, sessionCapabilities: { list: {} } }
        }
      },
      agentStatus: { 'agent-1': 'connected' },
      discoveredSessions: {
        [discoveryKey('agent-1', '/work')]: [{ sessionId: 'old', cwd: '/work' }]
      }
    })
    vi.mocked(invoke).mockRejectedValue(new Error('agent error'))
    await useAcpStore.getState().discoverSessions('agent-1', '/work')
    expect(
      useAcpStore.getState().discoveredSessions[discoveryKey('agent-1', '/work')]
    ).toBeUndefined()
  })

  it('_onAgentDisconnected clears discovered sessions for that agent', () => {
    useAcpStore.setState({
      discoveredSessions: {
        [discoveryKey('agent-1', '/work')]: [{ sessionId: 'sess-1', cwd: '/work' }],
        [discoveryKey('agent-2', '/work')]: [{ sessionId: 'sess-2', cwd: '/work' }]
      }
    })
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-1' })
    expect(
      useAcpStore.getState().discoveredSessions[discoveryKey('agent-1', '/work')]
    ).toBeUndefined()
    expect(
      useAcpStore.getState().discoveredSessions[discoveryKey('agent-2', '/work')]
    ).toBeDefined()
  })

  it('openDiscoveredSession throws when agent has neither load nor resume', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': { id: 'agent-1', capabilities: { loadSession: false } }
      },
      agentStatus: { 'agent-1': 'connected' }
    })
    await expect(
      useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-1', '/work', 'p1')
    ).rejects.toThrow(/does not support loading or resuming/)
    expect(useAcpStore.getState().discoveredReopenContexts['sess-1']).toBeUndefined()
  })

  it('keeps ephemeral retry context after a rejected discovered reopen and clears it after retry', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': { id: 'agent-1', capabilities: { loadSession: true } }
      },
      agentStatus: { 'agent-1': 'connected' }
    })
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('native load failed'))
      .mockResolvedValueOnce({})

    await expect(
      useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-retry', '/work', 'p1')
    ).rejects.toThrow('native load failed')
    expect(useAcpStore.getState().sessions['sess-retry']?.lastError).toContain('native load failed')
    expect(useAcpStore.getState().discoveredReopenContexts['sess-retry']).toEqual({
      agentId: 'agent-1',
      cwd: '/work',
      projectId: 'p1'
    })

    await useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-retry', '/work', 'p1')
    expect(useAcpStore.getState().sessions['sess-retry']?.status).toBe('active')
    expect(useAcpStore.getState().discoveredReopenContexts['sess-retry']).toBeUndefined()
  })

  it('openDiscoveredSession preserves existing controls when reopen omits fields', async () => {
    const existingModes = {
      currentModeId: 'existing-mode',
      availableModes: [{ id: 'existing-mode', name: 'Existing Mode' }]
    }
    const existingModels = {
      currentModelId: 'existing-model',
      availableModels: [{ modelId: 'existing-model', name: 'Existing Model' }]
    }
    const existingConfig = [
      {
        id: 'thinking',
        name: 'Thinking',
        type: 'select',
        currentValue: 'medium',
        options: [{ value: 'medium', name: 'Medium' }]
      }
    ]
    useAcpStore.setState({
      agents: {
        'agent-1': { id: 'agent-1', capabilities: { loadSession: true } }
      },
      agentStatus: { 'agent-1': 'connected' },
      sessions: {
        'sess-existing': {
          id: 'sess-existing',
          agentId: 'agent-1',
          cwd: '/work',
          projectId: 'p1',
          status: 'closed',
          title: 'Existing',
          activeTurn: false,
          openTurnId: null,
          modes: existingModes,
          models: existingModels,
          configOptions: existingConfig,
          lastError: null,
          createdAt: 1
        }
      }
    })
    vi.mocked(invoke).mockResolvedValueOnce({})

    await useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-existing', '/work', 'p1')

    const session = useAcpStore.getState().sessions['sess-existing']
    expect(session.modes).toBe(existingModes)
    expect(session.models).toBe(existingModels)
    expect(session.configOptions).toBe(existingConfig)
  })

  it('openDiscoveredSession clears only the current restore marker after its minimum', async () => {
    vi.useFakeTimers()
    try {
      useAcpStore.setState({
        agents: {
          'agent-1': { id: 'agent-1', capabilities: { loadSession: true } }
        },
        agentStatus: { 'agent-1': 'connected' }
      })
      vi.mocked(invoke).mockResolvedValueOnce({})

      const opening = useAcpStore
        .getState()
        .openDiscoveredSession('agent-1', 'sess-preload', '/work', 'p1')
      expect(useAcpStore.getState().restoringChatIds['sess-preload']).toBe(true)
      await opening
      expect(useAcpStore.getState().restoringChatIds['sess-preload']).toBe(true)

      await vi.advanceTimersByTimeAsync(400)
      expect(useAcpStore.getState().restoringChatIds['sess-preload']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('openDiscoveredSession coalesces concurrent opens for the same session', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': { id: 'agent-1', capabilities: { loadSession: true } }
      },
      agentStatus: { 'agent-1': 'connected' }
    })
    const reopen = deferred<unknown>()
    vi.mocked(invoke).mockReturnValueOnce(reopen.promise)

    const firstOpen = useAcpStore
      .getState()
      .openDiscoveredSession('agent-1', 'sess-overlap', '/work', 'p1')
    const secondOpen = useAcpStore
      .getState()
      .openDiscoveredSession('agent-1', 'sess-overlap', '/work', 'p1')

    expect(secondOpen).toBe(firstOpen)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke).toHaveBeenCalledWith('acp_load_session', {
      agentId: 'agent-1',
      sessionId: 'sess-overlap',
      cwd: '/work'
    })

    reopen.resolve({
      modes: { currentModeId: 'loaded', availableModes: [{ id: 'loaded', name: 'Loaded' }] },
      configOptions: []
    })
    await expect(Promise.all([firstOpen, secondOpen])).resolves.toEqual([undefined, undefined])

    const session = useAcpStore.getState().sessions['sess-overlap']
    expect(session.status).toBe('active')
    expect(session.modes?.currentModeId).toBe('loaded')
  })

  it('openDiscoveredSession starts a new reopen after delete/recreate and isolates in-flight cleanup', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': { id: 'agent-1', capabilities: { loadSession: true } }
      },
      agentStatus: { 'agent-1': 'connected' },
      sessionIndex: [
        {
          id: 'sess-recreated',
          agentId: 'agent-1',
          title: 'Old',
          cwd: '/old',
          projectId: 'p-old',
          createdAt: 1,
          lastActivityAt: 1,
          messageCount: 0,
          status: 'closed'
        }
      ]
    })
    const oldReopen = deferred<unknown>()
    const newReopen = deferred<unknown>()
    vi.mocked(invoke).mockReturnValueOnce(oldReopen.promise).mockReturnValueOnce(newReopen.promise)

    const oldOpening = useAcpStore
      .getState()
      .openDiscoveredSession('agent-1', 'sess-recreated', '/old', 'p-old')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    await useAcpStore.getState().deleteHistorySession('sess-recreated')
    seedSession('sess-recreated', 'agent-1', false)

    const newOpening = useAcpStore
      .getState()
      .openDiscoveredSession('agent-1', 'sess-recreated', '/work', 'p1')
    expect(newOpening).not.toBe(oldOpening)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(invoke).toHaveBeenLastCalledWith('acp_load_session', {
      agentId: 'agent-1',
      sessionId: 'sess-recreated',
      cwd: '/work'
    })

    oldReopen.resolve({
      modes: { currentModeId: 'stale', availableModes: [{ id: 'stale', name: 'Stale' }] },
      configOptions: []
    })
    await oldOpening

    const coalescedNewOpening = useAcpStore
      .getState()
      .openDiscoveredSession('agent-1', 'sess-recreated', '/work', 'p1')
    expect(coalescedNewOpening).toBe(newOpening)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(useAcpStore.getState().sessions['sess-recreated'].modes).toBeNull()

    newReopen.resolve({
      modes: { currentModeId: 'fresh', availableModes: [{ id: 'fresh', name: 'Fresh' }] },
      configOptions: []
    })
    await expect(Promise.all([newOpening, coalescedNewOpening])).resolves.toEqual([
      undefined,
      undefined
    ])

    const session = useAcpStore.getState().sessions['sess-recreated']
    expect(session.status).toBe('active')
    expect(session.cwd).toBe('/work')
    expect(session.modes?.currentModeId).toBe('fresh')
  })

  it('openDiscoveredSession load keeps in-flight live mode/config updates authoritative', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': { id: 'agent-1', capabilities: { loadSession: true } }
      },
      agentStatus: { 'agent-1': 'connected' }
    })
    const reopen = deferred<unknown>()
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(reopen.promise)
    const opening = useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-1', '/work', 'p1')
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('acp_load_session', expect.anything())
    )
    useAcpStore.getState()._onModeUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      currentModeId: 'live',
      availableModes: [{ id: 'live', name: 'Live' }]
    })
    const liveConfig = [
      {
        id: 'thinking',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'live',
        options: [{ value: 'live', name: 'Live' }]
      }
    ]
    useAcpStore.getState()._onConfigOptionsUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      configOptions: liveConfig
    })
    reopen.resolve({
      modes: { currentModeId: 'stale', availableModes: [{ id: 'stale', name: 'Stale' }] },
      models: {
        currentModelId: 'model-a',
        availableModels: [{ modelId: 'model-a', name: 'Model A' }]
      },
      configOptions: []
    })
    await opening
    const loadCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_load_session')
    expect(loadCalls).toHaveLength(1)
    // Forwarded payload: agentId, sessionId, cwd (no resume call on this path).
    expect(loadCalls[0]![1]).toMatchObject({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      cwd: '/work'
    })
    expect(
      vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_resume_session')
    ).toHaveLength(0)
    const session = useAcpStore.getState().sessions['sess-1']
    expect(session.modes?.currentModeId).toBe('live')
    expect(session.models?.currentModelId).toBe('model-a')
    expect(session.configOptions).toEqual(liveConfig)
  })

  it('openDiscoveredSession uses the resume branch when only resume is advertised', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          capabilities: { loadSession: false, sessionCapabilities: { resume: {} } }
        }
      },
      agentStatus: { 'agent-1': 'connected' }
    })
    const reopen = deferred<unknown>()
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(reopen.promise)
    const opening = useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-2', '/work', 'p1')
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('acp_resume_session', expect.anything())
    )
    expect(useAcpStore.getState().sessions['sess-2'].replaying).toBe('streaming')
    useAcpStore.getState()._onModeUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-2',
      currentModeId: 'live',
      availableModes: [{ id: 'live', name: 'Live' }]
    })
    useAcpStore.getState()._onConfigOptionsUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-2',
      configOptions: []
    })
    reopen.resolve({
      modes: { currentModeId: 'stale', availableModes: [{ id: 'stale', name: 'Stale' }] },
      models: {
        currentModelId: 'model-b',
        availableModels: [{ modelId: 'model-b', name: 'Model B' }]
      },
      configOptions: [
        {
          id: 'thinking',
          name: 'Thinking',
          type: 'select',
          currentValue: 'stale',
          options: [{ value: 'stale', name: 'Stale' }]
        }
      ]
    })
    await opening
    const resumeCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_resume_session')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]![1]).toMatchObject({
      agentId: 'agent-1',
      sessionId: 'sess-2',
      cwd: '/work'
    })
    // load must NOT be called when loadSession is absent.
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_load_session')).toHaveLength(
      0
    )
    const session = useAcpStore.getState().sessions['sess-2']
    expect(session.modes?.currentModeId).toBe('live')
    expect(session.models?.currentModelId).toBe('model-b')
    expect(session.configOptions).toEqual([])
  })
})
