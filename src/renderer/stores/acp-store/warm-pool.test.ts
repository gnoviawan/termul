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
import { logFrontendError } from '@/lib/log-api'
import {
  _resetEphemeralSessionIdsForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPromotionsForTesting,
  agentReuseKey,
  prepareChatKey,
  useAcpStore
} from '@/stores/acp-store'

describe('warm session pool', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockReset()
    useAcpStore.setState({
      agents: {},
      agentStatus: {},
      agentConfigs: [],
      configToLiveAgent: {},
      warmingConfigs: {},
      preparedSessions: {},
      preparingChatKeys: {},
      prepareChatErrors: {},
      selectedAgentConfigId: null,
      sessionIndex: [],
      sessions: {},
      activeSessionId: null,
      messages: {},
      pendingPermissions: {},
      pendingQuestions: {},
      pendingElicitations: {}
    })
    _resetInFlightHistoryOpensForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetInFlightPromotionsForTesting()
  })

  async function seedConnectedAgent(
    configId: string,
    agentId: string,
    cwd = '/work'
  ): Promise<void> {
    await useAcpStore.getState().saveAgentConfig({
      id: configId,
      name: configId,
      command: 'x',
      args: [],
      env: {}
    })
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, [agentId]: { id: agentId, capabilities: null } },
      agentStatus: { ...s.agentStatus, [agentId]: 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey(configId, cwd)]: agentId }
    }))
  }

  it('prepareChat creates an ephemeral session not mirrored to the history index', async () => {
    await seedConnectedAgent('cfg-1', 'agent-9')
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'sess-prep' })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-prep')
    })
    expect(useAcpStore.getState().sessions['sess-prep']).toBeDefined()
    expect(useAcpStore.getState().sessions['sess-prep'].agentId).toBe('agent-9')
    // Ephemeral: registered in-memory but NOT in the persisted history index (no orphan).
    expect(useAcpStore.getState().sessionIndex.find((e) => e.id === 'sess-prep')).toBeUndefined()
    // Story 8: the warm seed goes on the wire as backend-ephemeral +
    // promotable, so the host persists nothing and keeps the plan tool.
    expect(invoke).toHaveBeenCalledWith('acp_new_session', {
      agentId: 'agent-9',
      cwd: '/work',
      mcpServers: [],
      ephemeral: true,
      promotable: true,
      projectId: 'p1'
    })
  })

  it('startChat promotes an ephemeral prepared session into the history index', async () => {
    await seedConnectedAgent('cfg-1', 'agent-9')
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'sess-prep' })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-prep'))
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    expect(sessionId).toBe('sess-prep')
    // Promoted: now mirrored to the history index; warm-slot lookup cleared.
    await vi.waitFor(() => {
      expect(useAcpStore.getState().sessionIndex.find((e) => e.id === 'sess-prep')).toBeDefined()
    })
    expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined()
    // Story 8: claiming the warm session fires the backend promote (register
    // persistence metadata + clear the ephemeral mark) for the claimed id.
    await vi.waitFor(() => {
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(
            ([command, args]) =>
              command === 'acp_promote_session' &&
              (args as { sessionId?: string })?.sessionId === 'sess-prep'
          )
      ).toBe(true)
    })
  })

  it('the first prompt awaits the pending warm-pool promotion before dispatch', async () => {
    await seedConnectedAgent('cfg-1', 'agent-9')
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'sess-prep' })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-prep'))

    // Hold the backend promote until released.
    let releasePromote!: () => void
    const promoteGate = new Promise<void>((resolve) => {
      releasePromote = resolve
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_promote_session') await promoteGate
      if (command === 'acp_send_prompt') return 'end_turn'
      return undefined
    })

    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    expect(sessionId).toBe('sess-prep')

    const promptDone = useAcpStore.getState().sendPrompt('sess-prep', 'hello')
    // The optimistic user message paints immediately...
    await vi.waitFor(() => {
      expect(useAcpStore.getState().messages['sess-prep']?.some((m) => m.role === 'user')).toBe(
        true
      )
    })
    // ...but the dispatch must NOT fire while the promotion is in flight (the
    // user_prompt would otherwise not persist — the session is still
    // backend-ephemeral until the promote lands).
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_send_prompt')).toBe(
      false
    )

    releasePromote()
    await vi.waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_send_prompt')).toBe(
        true
      )
    })
    await promptDone
  })

  it('a slow warm-pool promotion never releases the first prompt early', async () => {
    // Regression guard for the durability race: the old wait raced a 30s local
    // timeout and dispatched the turn degraded while the session was still
    // backend-ephemeral; a late successful promote then minted durable history
    // missing the first prompt (the prompt path skips persist_accepted_prompt)
    // and possibly its response (the completion path skips flush_session). The
    // turn must hold until the promotion SETTLES — no local timer may release
    // it. Degraded dispatch is reserved for an actually FAILED promotion.
    await seedConnectedAgent('cfg-1', 'agent-9')
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'sess-prep' })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-prep'))

    // Hold the backend promote until released.
    let releasePromote!: () => void
    const promoteGate = new Promise<void>((resolve) => {
      releasePromote = resolve
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_promote_session') await promoteGate
      if (command === 'acp_send_prompt') return 'end_turn'
      return undefined
    })

    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    expect(sessionId).toBe('sess-prep')

    const sentPrompt = (): boolean =>
      vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_send_prompt')

    vi.useFakeTimers()
    try {
      const promptDone = useAcpStore.getState().sendPrompt('sess-prep', 'hello')
      // The optimistic paint + promotion wait are synchronous within sendPrompt.
      expect(useAcpStore.getState().messages['sess-prep']?.some((m) => m.role === 'user')).toBe(
        true
      )
      expect(sentPrompt()).toBe(false)

      // Advancing far past the slow-handoff warning threshold must NOT
      // dispatch: the wait is released only by the promotion settling.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(sentPrompt()).toBe(false)
      // The slow handoff is still observable (durable warn) — it just does
      // not release the wait.
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', source: 'acp-store.warmPoolPromotion' })
      )

      // Late settle: the promotion lands and only then does the prompt
      // dispatch (durably — the backend ephemeral mark is already cleared).
      releasePromote()
      for (let i = 0; i < 50 && !sentPrompt(); i++) {
        await Promise.resolve()
      }
      expect(sentPrompt()).toBe(true)
      await promptDone
    } finally {
      vi.useRealTimers()
    }
  })

  it('startChat refills a warm session for the pool target after consuming one', async () => {
    await seedConnectedAgent('cfg-1', 'agent-9')
    useAcpStore.getState().setSelectedAgentConfigId('cfg-1')
    // Command-keyed mock: session/new mints sequential ids; everything else
    // (incl. the story-8 `acp_promote_session` on claim) resolves undefined.
    let nextSession = 0
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent') {
        return { agentId: 'agent-10', capabilities: {}, authMethods: [] }
      }
      if (command !== 'acp_new_session') return undefined
      nextSession += 1
      return { sessionId: `sess-${nextSession}` }
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-1'))
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    expect(sessionId).toBe('sess-1')
    // Refill fired: a fresh session/new produced a new warm slot for the next chat.
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-2'))
  })

  it('does not let a new Factory session reset the selected model of an active chat', async () => {
    const configId = 'acp-registry:factory-droid'
    await seedConnectedAgent(configId, 'factory-first')
    useAcpStore.getState().setSelectedAgentConfigId(configId)
    let nextSession = 0
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_new_session') return { sessionId: `factory-${++nextSession}` }
      if (command === 'acp_spawn_agent') {
        return { agentId: 'factory-second', capabilities: {}, authMethods: [] }
      }
      if (command === 'acp_set_config_option') return null
      return undefined
    })
    const key = prepareChatKey(configId, '/work', undefined)
    useAcpStore.getState().prepareChat(configId, '/work', undefined, 'p1')
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('factory-1'))
    const first = await useAcpStore.getState().startChat(configId, '/work', undefined, 'p1')
    expect(first).toBe('factory-1')
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [first]: {
          ...s.sessions[first],
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              currentValue: 'gpt-5.6-sol',
              options: [
                { value: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
                { value: 'glm-5.3-flash', name: 'GLM-5.3-Flash' }
              ]
            }
          ]
        }
      }
    }))
    await useAcpStore.getState().setConfigOption(first, 'model', 'glm-5.3-flash')
    // Factory's session/new resets the model across all sessions in one process.
    // A consumed warm session must not be refilled on the first chat's agent.
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined())
    expect(nextSession).toBe(1)

    useAcpStore.getState().prepareChat(configId, '/work', undefined, 'p1')
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('factory-2'))
    const state = useAcpStore.getState()
    expect(state.sessions[first]?.agentId).toBe('factory-first')
    expect(state.sessions[first]?.configOptions[0]?.currentValue).toBe('glm-5.3-flash')
    expect(state.sessions['factory-2']?.agentId).toBe('factory-second')
    expect(state.configToLiveAgent[agentReuseKey(configId, '/work')]).toBe('factory-second')
    expect(Object.entries(state.configToLiveAgent)).toContainEqual([
      expect.stringContaining('factory-first'),
      'factory-first'
    ])
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('acp_kill_agent', expect.anything())
  })

  it('preserves a live Factory chat identity when saving a new key', async () => {
    const configId = 'acp-registry:factory-droid'
    await seedConnectedAgent(configId, 'factory-live')
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'factory-chat' })
    useAcpStore.getState().prepareChat(configId, '/work', undefined, 'p1')
    const key = prepareChatKey(configId, '/work', undefined)
    await vi.waitFor(() =>
      expect(useAcpStore.getState().preparedSessions[key]).toBe('factory-chat')
    )
    await useAcpStore.getState().startChat(configId, '/work', undefined, 'p1')

    useAcpStore.getState().detachAgentForNewCredentials(configId, '/work')
    const mapping = useAcpStore.getState().configToLiveAgent
    expect(mapping[agentReuseKey(configId, '/work')]).toBeUndefined()
    expect(mapping[`${agentReuseKey(configId, '/work')}\0factory-live`]).toBe('factory-live')
    expect(useAcpStore.getState().sessions['factory-chat']?.status).not.toBe('closed')
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('acp_kill_agent', expect.anything())
  })

  it('retargetWarmPool drains another agent stale pooled session (same cwd) and seeds the new one', async () => {
    await seedConnectedAgent('cfg-a', 'agent-a')
    await seedConnectedAgent('cfg-b', 'agent-b')
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'sess-a' })
    useAcpStore.getState().prepareChat('cfg-a', '/work', undefined, 'p1')
    const keyA = prepareChatKey('cfg-a', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[keyA]).toBe('sess-a'))
    // Retarget to cfg-b (same cwd): close sess-a (fire-and-forget) + seed cfg-b.
    vi.mocked(invoke).mockResolvedValue({ sessionId: 'sess-b' })
    useAcpStore.getState().retargetWarmPool('cfg-b', '/work', 'p1')
    const keyB = prepareChatKey('cfg-b', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[keyB]).toBe('sess-b'))
    // cfg-a's stale warm slot drained (single-target).
    expect(useAcpStore.getState().preparedSessions[keyA]).toBeUndefined()
  })

  it('retargetWarmPool keeps pooled sessions for other cwds (project switch-back)', async () => {
    await seedConnectedAgent('cfg-a', 'agent-a', '/work/proj-1')
    await seedConnectedAgent('cfg-a', 'agent-a', '/work/proj-2')
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'sess-1' })
    useAcpStore.getState().prepareChat('cfg-a', '/work/proj-1', undefined, 'p1')
    const key1 = prepareChatKey('cfg-a', '/work/proj-1', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key1]).toBe('sess-1'))
    // Retarget to a different cwd: must NOT drain the other cwd's warm slot.
    vi.mocked(invoke).mockResolvedValue({ sessionId: 'sess-2' })
    useAcpStore.getState().retargetWarmPool('cfg-a', '/work/proj-2', 'p2')
    const key2 = prepareChatKey('cfg-a', '/work/proj-2', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key2]).toBe('sess-2'))
    expect(useAcpStore.getState().preparedSessions[key1]).toBe('sess-1')
  })

  it('_onAgentDisconnected drops pooled sessions for the disconnected agent', async () => {
    await seedConnectedAgent('cfg-1', 'agent-9')
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'sess-prep' })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-prep'))
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-9' })
    // Pooled warm slot dropped so a later startChat does not promote a dead session.
    expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined()
    // No orphan "Untitled Chat" is persisted to the history index on disconnect.
    expect(useAcpStore.getState().sessionIndex.find((e) => e.id === 'sess-prep')).toBeUndefined()
  })

  it('killAgent drops the warm-pool slot for the killed agent and lets prepareChat reseed', async () => {
    await seedConnectedAgent('cfg-1', 'agent-9')
    await seedConnectedAgent('cfg-b', 'agent-8')
    // Sequential ids: the first prepare claims sess-1, the reseed sess-2 on a
    // freshly spawned agent.
    let nextSession = 0
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent') {
        return { agentId: 'agent-10', capabilities: {}, authMethods: [] }
      }
      if (command === 'acp_new_session') return { sessionId: `sess-${++nextSession}` }
      return undefined
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-1'))
    // Another agent's warm slot must survive the teardown.
    const keyB = prepareChatKey('cfg-b', '/work', undefined)
    useAcpStore.setState((s) => ({
      preparedSessions: { ...s.preparedSessions, [keyB]: 'sess-b' },
      sessions: {
        ...s.sessions,
        'sess-b': {
          id: 'sess-b',
          agentId: 'agent-8',
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
          createdAt: Date.now()
        }
      }
    }))
    // Renderer-initiated kill (idle shutdown / last tab closed): the backend
    // emits no lifecycle events for an intentional kill, so the action itself
    // must retire the slot — a stale one routes launcher option calls to the
    // dead agent (`unknown agent`).
    await useAcpStore.getState().killAgent('agent-9')
    expect(invoke).toHaveBeenCalledWith('acp_kill_agent', { agentId: 'agent-9' })
    expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined()
    expect(useAcpStore.getState().preparedSessions[keyB]).toBe('sess-b')
    expect(useAcpStore.getState().sessions['sess-1']?.status).toBe('closed')
    // The freed key no longer short-circuits prepareChat: a fresh warm session
    // is seeded on a new live agent instead of the launcher calling a dead id.
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-2'))
    expect(useAcpStore.getState().sessions['sess-2']?.agentId).toBe('agent-10')
  })

  it('closeSession drops the warm-pool slot pointing at the closed session', async () => {
    await seedConnectedAgent('cfg-1', 'agent-9')
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === 'acp_new_session' ? { sessionId: 'sess-prep' } : undefined
    )
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    const keyOther = prepareChatKey('cfg-other', '/elsewhere', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-prep'))
    useAcpStore.setState((s) => ({
      preparedSessions: { ...s.preparedSessions, [keyOther]: 'sess-other' }
    }))
    await useAcpStore.getState().closeSession('sess-prep')
    expect(useAcpStore.getState().sessions['sess-prep']?.status).toBe('closed')
    expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined()
    // Unrelated slots survive — only the closed session's slot is dropped.
    expect(useAcpStore.getState().preparedSessions[keyOther]).toBe('sess-other')
  })

  it('_onSessionClosed drops the warm-pool slot even when the pooled session has content', async () => {
    await seedConnectedAgent('cfg-1', 'agent-9')
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === 'acp_new_session' ? { sessionId: 'sess-prep' } : undefined
    )
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-prep'))
    // A pooled session that accumulated a transcript (e.g. an agent-emitted
    // session_update before promotion) takes the normal close path — the slot
    // must still be dropped or it stays stale forever.
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-prep': [
          {
            id: 'm1',
            role: 'agent',
            blocks: [{ type: 'text', text: 'hi' }],
            streaming: false,
            timestamp: Date.now(),
            seq: 1
          }
        ]
      }
    }))
    useAcpStore.getState()._onSessionClosed({ agentId: 'agent-9', sessionId: 'sess-prep' })
    expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined()
    // Content-bearing session is persisted/closed, not deleted outright.
    expect(useAcpStore.getState().sessions['sess-prep']?.status).toBe('closed')
  })
})
