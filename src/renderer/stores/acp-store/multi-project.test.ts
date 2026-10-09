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
  _resetAcpAuthForTesting,
  agentReuseKey,
  configIdFromReuseKey,
  selectAgentIdentity,
  selectConfigWarmState,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, seedSession } from './testkit'

describe('acp-store multi-project isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetAcpAuthForTesting()
    _resetAcpTransportForTests(null)
    useAcpStore.setState(FRESH)
  })

  it('agentReuseKey/configIdFromReuseKey round-trip a config id with cwd', () => {
    const key = agentReuseKey('acp-registry:claude-acp', '/work/a')
    expect(key).toBe('acp-registry:claude-acp\0/work/a')
    expect(configIdFromReuseKey(key)).toBe('acp-registry:claude-acp')
  })

  it('startChat in a second project spawns a separate process, not reusing project A', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    // Project A already has a live, connected process.
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-a': { id: 'agent-a', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-a': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/a')]: 'agent-a' }
    }))
    // Launch the same agent in project B (different cwd) -> spawns a new process.
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ agentId: 'agent-b', capabilities: {}, authMethods: [] })
      .mockResolvedValueOnce({ sessionId: 'sess-b' })
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/b', undefined, 'p1')
    expect(sessionId).toBe('sess-b')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/a')]).toBe('agent-a')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/b')]).toBe('agent-b')
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(1)
  })

  it('a disconnect of one project process leaves the other project session active', () => {
    // Two live processes for the same config, one per project. seedSession
    // replaces the whole sessions map, so set both records in a single update.
    const mkSession = (id: string, agentId: string, cwd: string) => ({
      id,
      agentId,
      cwd,
      projectId: 'p1',
      status: 'active' as const,
      title: null,
      activeTurn: false,
      openTurnId: null,
      modes: null,
      configOptions: [],
      lastError: null,
      createdAt: Date.now()
    })
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-a': mkSession('s-a', 'agent-a', '/a'),
        's-b': mkSession('s-b', 'agent-b', '/b')
      },
      agentStatus: { ...s.agentStatus, 'agent-a': 'connected', 'agent-b': 'connected' },
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('cfg-1', '/a')]: 'agent-a',
        [agentReuseKey('cfg-1', '/b')]: 'agent-b'
      }
    }))
    // Project A's process dies.
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-a' })
    expect(useAcpStore.getState().sessions['s-a'].status).toBe('closed')
    expect(useAcpStore.getState().agentStatus['agent-a']).toBe('error')
    // Project B is untouched.
    expect(useAcpStore.getState().sessions['s-b'].status).toBe('active')
    expect(useAcpStore.getState().agentStatus['agent-b']).toBe('connected')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/b')]).toBe('agent-b')
  })

  it('selectAgentIdentity resolves the config behind a per-cwd live agent', async () => {
    await useAcpStore.getState().saveAgentConfig({
      id: 'cfg-1',
      templateId: 'claude-acp',
      name: 'Claude',
      command: 'claude',
      args: [],
      env: {}
    })
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/b')]: 'agent-b' }
    }))
    const identity = selectAgentIdentity(useAcpStore.getState(), 'agent-b')
    expect(identity).toEqual({ name: 'Claude', templateId: 'claude-acp', icon: null })
  })

  it('selectAgentIdentity falls back to sessionIndex agentConfigId when live map is cold', async () => {
    await useAcpStore.getState().saveAgentConfig({
      id: 'acp-registry:cursor',
      templateId: 'cursor',
      name: 'Cursor',
      command: 'cursor-agent',
      args: [],
      env: {}
    })
    useAcpStore.setState({
      configToLiveAgent: {},
      sessionIndex: [
        {
          id: 's-hist',
          agentId: 'agent-hist',
          agentConfigId: 'acp-registry:cursor',
          title: 'History chat',
          cwd: '/tmp',
          projectId: 'p1',
          createdAt: 1,
          lastActivityAt: 1,
          messageCount: 0,
          status: 'closed'
        }
      ]
    })
    const identity = selectAgentIdentity(useAcpStore.getState(), 'agent-hist')
    expect(identity).toEqual({ name: 'Cursor', templateId: 'cursor', icon: null })
  })

  it('agent_error with session_id sets lastError on that session', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onAgentError({
      agentId: 'agent-1',
      sessionId: 's1',
      message: 'credit limit exceeded'
    })
    expect(useAcpStore.getState().agentStatus['agent-1']).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].lastError).toBe('credit limit exceeded')
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  // gh-821: JSON-RPC code/data from the agent_error / agent_crashed payload.
  it('agent_error stores code + data; an old payload leaves them null/undefined', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onAgentError({
      agentId: 'agent-1',
      sessionId: 's1',
      message: 'auth',
      code: -32000,
      data: { reason: 'login' }
    })
    let session = useAcpStore.getState().sessions['s1']
    expect(session.lastErrorCode).toBe(-32000)
    expect(session.lastErrorData).toEqual({ reason: 'login' })

    useAcpStore.getState()._onAgentError({
      agentId: 'agent-1',
      sessionId: 's1',
      message: 'turn idle timeout'
    })
    session = useAcpStore.getState().sessions['s1']
    expect(session.lastErrorCode).toBeNull()
    expect(session.lastErrorData).toBeUndefined()
  })

  it('agent_crashed stores code + data on the session', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onAgentCrashed({
      agentId: 'agent-1',
      sessionId: 's1',
      message: 'gone',
      code: -32603,
      data: { detail: 'x' }
    })
    const session = useAcpStore.getState().sessions['s1']
    expect(session.lastErrorCode).toBe(-32603)
    expect(session.lastErrorData).toEqual({ detail: 'x' })
  })

  it('agent_crashed without session_id stores code on every session of the agent', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onAgentCrashed({ agentId: 'agent-1', message: 'gone', code: -32603 })
    expect(useAcpStore.getState().sessions['s1'].lastErrorCode).toBe(-32603)
  })

  // Story 1.9 FR26: the typed AgentCrashed event → status: 'error' + lastError.
  it('agent_crashed with session_id sets status error + lastError on that session', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onAgentCrashed({
      agentId: 'agent-1',
      sessionId: 's1',
      message: 'child exited: signal 11'
    })
    expect(useAcpStore.getState().agentStatus['agent-1']).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].status).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].lastError).toBe('child exited: signal 11')
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('agent_crashed with session_id None sets status error on all sessions for that agent', () => {
    seedSession('s1', 'agent-1')
    seedSession('s2', 'agent-1')
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
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: 1
        },
        s2: {
          id: 's2',
          agentId: 'agent-1',
          cwd: '/work',
          projectId: 'p1',
          status: 'active',
          title: null,
          activeTurn: true,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: 1
        }
      }
    })
    useAcpStore.getState()._onAgentCrashed({
      agentId: 'agent-1',
      sessionId: undefined,
      message: 'process crashed'
    })
    expect(useAcpStore.getState().agentStatus['agent-1']).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].status).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].lastError).toBe('process crashed')
    expect(useAcpStore.getState().sessions['s2'].status).toBe('error')
  })

  // Story 1.9 review (HIGH fix): the triple-event crash sequence (crashed →
  // error → disconnected) must leave status='error', NOT 'closed' — the
  // always-following agent_disconnected must NOT overwrite the crash's 'error'.
  it('agent_crashed then agent_disconnected preserves status error (the triple-event sequence)', () => {
    seedSession('s1', 'agent-1')
    // 1. Crash event → status: 'error'
    useAcpStore.getState()._onAgentCrashed({
      agentId: 'agent-1',
      sessionId: undefined,
      message: 'child exited'
    })
    expect(useAcpStore.getState().sessions['s1'].status).toBe('error')
    // 2. Error event (same message) — doesn't change status
    useAcpStore.getState()._onAgentError({
      agentId: 'agent-1',
      sessionId: undefined,
      message: 'child exited'
    })
    expect(useAcpStore.getState().sessions['s1'].status).toBe('error')
    // 3. Disconnect event — must NOT overwrite 'error' to 'closed'
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-1' })
    expect(useAcpStore.getState().sessions['s1'].status).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].lastError).toBe('child exited')
    expect(useAcpStore.getState().agentStatus['agent-1']).toBe('error')
  })

  // Story 1.9 review: a turn-scoped agent_error (e.g. the bounded turn
  // timeout) sets status='error' (NFR7 — the wedged turn → Error state).
  it('agent_error with session_id sets status error (turn-timeout path)', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onAgentError({
      agentId: 'agent-1',
      sessionId: 's1',
      message: 'turn timeout: session s1 exceeded 600s'
    })
    expect(useAcpStore.getState().sessions['s1'].status).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].lastError).toBe(
      'turn timeout: session s1 exceeded 600s'
    )
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  // Story 1.9 review (EC #8): a crash event for an already-closed session
  // must NOT resurrect it to 'error'.
  it('agent_crashed does not resurrect a closed session', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId: 's1' })
    expect(useAcpStore.getState().sessions['s1'].status).toBe('closed')
    useAcpStore.getState()._onAgentCrashed({
      agentId: 'agent-1',
      sessionId: 's1',
      message: 'late crash'
    })
    expect(useAcpStore.getState().sessions['s1'].status).toBe('closed')
  })

  it('agent_error with session_id None sets lastError on all sessions for that agent', () => {
    seedSession('s1', 'agent-1')
    seedSession('s2', 'agent-1')
    // seedSession overwrites; re-seed both
    useAcpStore.setState({
      sessions: {
        s1: {
          id: 's1',
          agentId: 'agent-1',
          cwd: '/work',
          projectId: 'p1',
          status: 'active',
          title: null,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: 0
        },
        s2: {
          id: 's2',
          agentId: 'agent-1',
          cwd: '/work',
          projectId: 'p1',
          status: 'active',
          title: null,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: 0
        }
      }
    })
    useAcpStore.getState()._onAgentError({
      agentId: 'agent-1',
      message: 'insufficient credit'
    })
    expect(useAcpStore.getState().agentStatus['agent-1']).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].lastError).toBe('insufficient credit')
    expect(useAcpStore.getState().sessions['s2'].lastError).toBe('insufficient credit')
  })

  it('agent_error followed by agent_disconnected preserves lastError on closed sessions', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onAgentError({
      agentId: 'agent-1',
      message: 'fatal: api key revoked'
    })
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-1' })
    expect(useAcpStore.getState().sessions['s1'].status).toBe('closed')
    expect(useAcpStore.getState().sessions['s1'].lastError).toBe('fatal: api key revoked')
  })

  it('stop reasons end_turn and cancelled produce no error note', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn'
    })
    expect(useAcpStore.getState().sessions['s1'].lastError).toBeNull()
    seedSession('s2', 'agent-1')
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's2',
      stopReason: 'cancelled'
    })
    expect(useAcpStore.getState().sessions['s2'].lastError).toBeNull()
  })

  it('unknown stop reasons surface a descriptive note instead of being silently dropped', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'insufficient_credit'
    })
    expect(useAcpStore.getState().sessions['s1'].lastError).toMatch(/insufficient_credit/i)
  })

  // Issue #842: the server writes a synthetic prompt_complete with
  // stopReason "interrupted" at shutdown; the renderer must surface a
  // dedicated note (not the generic "Response stopped: interrupted").
  it('interrupted stop reason surfaces the server-restart note', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'interrupted'
    })
    expect(useAcpStore.getState().sessions['s1'].lastError).toBe('Interrupted by server restart.')
  })

  it('selectConfigWarmState rolls up status across all per-cwd processes', () => {
    useAcpStore.setState((s) => ({
      agentStatus: { ...s.agentStatus, 'agent-a': 'spawning', 'agent-b': 'connected' },
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('cfg-1', '/a')]: 'agent-a',
        [agentReuseKey('cfg-1', '/b')]: 'agent-b'
      },
      warmingConfigs: { ...s.warmingConfigs, [agentReuseKey('cfg-1', '/c')]: true }
    }))
    const state = selectConfigWarmState(useAcpStore.getState(), 'cfg-1')
    expect(state).toMatchObject({ connected: true, warming: true })
    // A different config sees nothing.
    expect(selectConfigWarmState(useAcpStore.getState(), 'cfg-other')).toMatchObject({
      connected: false,
      warming: false
    })
  })
})
