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
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport,
  AcpTransportError
} from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import {
  _resetAcpAuthForTesting,
  type AcpSession,
  agentReuseKey,
  initAcpEventListeners,
  prepareChatKey,
  useAcpStore
} from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { FRESH } from './testkit'

describe('acp provider authentication & recovery', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    // Auth-method memory (spec-acp-persistent-auth-reuse): default to an empty
    // persisted map + successful writes; tests override `read` to seed a
    // remembered method, then call `loadAgentConfigs` (the init boundary).
    mockPersistenceApi.read.mockReset()
    mockPersistenceApi.write.mockReset()
    mockPersistenceApi.read.mockResolvedValue({
      success: false,
      code: 'KEY_NOT_FOUND',
      error: 'key not found'
    })
    mockPersistenceApi.write.mockResolvedValue({ success: true })
    _resetAcpAuthForTesting()
    useAcpStore.setState(FRESH)
  })

  /** The wire signal both transports surface for auth-required session calls. */
  function authRequiredError(): AcpTransportError {
    return new AcpTransportError('agent_auth_required', 'session call rejected: not authenticated')
  }

  /** Seed `acp/auth-methods` persistence and run the init load so memory is live. */
  async function seedAuthMethodMemory(map: Record<string, string>): Promise<void> {
    mockPersistenceApi.read.mockImplementation(async (key: string) =>
      key === 'acp/auth-methods'
        ? { success: true, data: map }
        : { success: false, error: 'key not found', code: 'KEY_NOT_FOUND' }
    )
    await useAcpStore.getState().loadAgentConfigs()
  }

  /** Register a live agent as if it were spawned + `acp:agent_spawned` reduced. */
  function seedLiveAgent(
    agentId: string,
    authMethods: Array<{
      id: string
      name: string
      description?: string | null
      type?: 'agent' | 'terminal' | 'env_var'
      args?: string[]
      env?: Record<string, string>
    }>,
    capabilities: Record<string, unknown> | null = {}
  ): void {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, [agentId]: { id: agentId, capabilities, authMethods } },
      agentStatus: { ...s.agentStatus, [agentId]: 'connected' }
    }))
  }
  it('skips generic ACP auth only when host-managed auth is confirmed', async () => {
    const authMethods = [
      { id: 'claude-code', name: 'Claude Code' },
      { id: 'api-key', name: 'API key' }
    ]
    seedLiveAgent('claude-host-unready', authMethods)
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: { agentId?: string }) => {
      if (cmd === 'acp_spawn_agent')
        return {
          agentId: 'claude-host-ready',
          capabilities: {},
          authMethods,
          hostAuthReady: true
        }
      // The unready host falls back to generic ACP auth only when the session
      // call actually reports auth-required — a managed agent that answers
      // session/new directly needs no extra sign-in.
      if (cmd === 'acp_new_session') {
        if (args?.agentId === 'claude-host-unready') throw authRequiredError()
        return { sessionId: 'claude-session' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })

    await useAcpStore.getState().spawnAgent({
      configId: 'acp-registry:claude-acp',
      name: 'Claude Agent',
      command: 'node',
      args: ['/managed/claude-agent-acp.js'],
      env: {}
    })
    await expect(
      useAcpStore.getState().createSession('claude-host-ready', '/work', undefined, 'p1')
    ).resolves.toBe('claude-session')
    await expect(
      useAcpStore.getState().createSession('claude-host-unready', '/work', undefined, 'p1')
    ).rejects.toBeDefined()
    expect(vi.mocked(invoke).mock.calls.map(([cmd]) => cmd)).toEqual([
      'acp_spawn_agent',
      'acp_new_session',
      'acp_new_session'
    ])
  })

  it('creates the session with no authenticate when the agent is already logged in', async () => {
    // spec-acp-persistent-auth-reuse core acceptance: session/new runs FIRST.
    // A globally logged-in agent (e.g. devin on a new worktree cwd) goes
    // straight through — zero authenticate calls, zero sign-in UI.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Sign in with Cursor' }])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).resolves.toBe('s1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(1)
  })

  it('creates the session with no picker or authenticate for a logged-in MULTI-method agent', async () => {
    // The reported bug: a multi-method agent (devin advertises 2) used to
    // hard-fail into AmbiguousAuthError on every spawn even when the CLI was
    // globally logged in. With authenticate-on-demand, a successful
    // session/new means no auth UI at all.
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Devin', command: 'devin', args: ['acp'], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'devin-browser', name: 'Browser sign-in', type: 'agent' },
      { id: 'devin-terminal-login', name: 'Terminal login', type: 'terminal', args: ['--login'] }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-9', '/work', undefined, 'p1')
    ).resolves.toBe('s1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(1)
  })

  it('authenticates the single advertised method on demand when session/new reports auth-required (P1)', async () => {
    // CAP-4: the spawn response populates authMethods synchronously, so
    // `authenticateBeforeSession` reads them directly — no timed wait. Seed
    // the agent with the methods already present (as `spawnAgent` would do
    // from the response) and verify session/new → authenticate → retry order.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Sign in with Cursor' }])
    const order: string[] = []
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(order).toEqual(['acp_new_session', 'acp_authenticate', 'acp_new_session'])
    const authCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'acp_authenticate')
    expect(authCall?.[1]).toEqual({ agentId: 'agent-1', methodId: 'cursor_login' })
  })

  it('authenticates on demand even when the agent_spawned event never arrives (CAP-4 no no-auth fallback)', async () => {
    // CAP-4 acceptance: a Cursor-style agent (one auth method) whose
    // `acp:agent_spawned` event is delayed beyond the former 250ms window
    // must STILL authenticate when session/new reports auth-required. The
    // spawn response is the authoritative source; the event is observer-only.
    // The former `SPAWN_DETAILS_WAIT_MS` timeout that inferred no-auth after
    // 250ms is gone.
    //
    // Seed the agent with authMethods from the (synchronous) spawn response.
    // Do NOT emit `_onAgentSpawned` — the event never arrives.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Sign in with Cursor' }])
    const order: string[] = []
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    // authenticate ran between the auth-required reply and the retry — no
    // no-auth fallback.
    expect(order).toEqual(['acp_new_session', 'acp_authenticate', 'acp_new_session'])
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
  })

  it('treats an agent that advertises no methods as no-auth (session/new only)', async () => {
    seedLiveAgent('agent-1', [])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(1)
  })

  it('ignores a method with an empty/whitespace id and does not authenticate (P5)', async () => {
    seedLiveAgent('agent-1', [{ id: '   ', name: 'Broken' }])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
  })

  it('rejects a multi-method agent without choosing one, surfacing a multi-auth error (P6)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Cursor', command: 'cursor', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'cursor_login', name: 'Cursor' },
      { id: 'api_key', name: 'API key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      // Authenticate-on-demand: the picker only appears after session/new
      // reports auth-required — never preemptively.
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('multi-auth')
    })
    const err = useAcpStore.getState().prepareChatErrors[key]
    expect(err?.label).toBe('Multiple sign-in methods')
    expect(err?.detail).toContain('Cursor')
    expect(err?.detail).toContain('API key')
    // Never authenticated nor created a session (the auth-required session/new
    // attempt is the only one — no retry without an authenticate).
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(1)
  })
  it('uses a stored Factory key without silently choosing another agent method', async () => {
    await useAcpStore.getState().saveAgentConfig({
      id: 'acp-registry:factory-droid',
      name: 'Factory Droid',
      command: 'npx',
      args: ['-y', 'droid@0.218.1', 'exec', '--output-format', 'acp-daemon'],
      env: {}
    })
    seedLiveAgent('agent-factory', [
      { id: 'device-pairing', name: 'Login' },
      { id: 'factory-api-key', name: 'Factory API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('acp-registry:factory-droid', '/work')]: 'agent-factory'
      }
    }))
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_factory_key_status') return true
      if (cmd === 'acp_authenticate') return undefined
      // Authenticate-on-demand: the stored key is tried only after session/new
      // reports auth-required.
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 'factory-session' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-factory', '/work', undefined, 'p1')
    expect(vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'acp_authenticate')?.[1]).toEqual({
      agentId: 'agent-factory',
      methodId: 'factory-api-key'
    })
  })
  it('lets a fresh Factory process use an existing browser login without choosing a method', async () => {
    seedLiveAgent('agent-factory', [
      { id: 'device-pairing', name: 'Login' },
      { id: 'factory-api-key', name: 'Factory API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('acp-registry:factory-droid', '/work')]: 'agent-factory'
      }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_factory_key_status') return false
      if (cmd === 'acp_new_session') return { sessionId: 'factory-session' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-factory', '/work', undefined, 'p1')
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_authenticate')).toHaveLength(
      0
    )
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_new_session')).toHaveLength(
      1
    )
  })
  it('offers Factory Login when no browser credentials are available', async () => {
    const configId = 'acp-registry:factory-droid'
    await useAcpStore.getState().saveAgentConfig({
      id: configId,
      name: 'Factory Droid',
      command: 'droid',
      args: ['exec', '--output-format', 'acp'],
      env: {}
    })
    seedLiveAgent('agent-factory', [
      { id: 'device-pairing', name: 'Login' },
      { id: 'factory-api-key', name: 'Factory API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey(configId, '/work')]: 'agent-factory'
      }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_factory_key_status') return false
      if (cmd === 'acp_new_session') throw new Error('ACP_AUTH_REQUIRED: Authentication required')
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat(configId, '/work', undefined, 'p1')
    const key = prepareChatKey(configId, '/work', undefined)
    await vi.waitFor(() =>
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('auth')
    )
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_authenticate')).toHaveLength(
      0
    )
  })
  it('does not expose a stored Factory key in a failed authentication error', async () => {
    seedLiveAgent('agent-factory', [
      { id: 'device-pairing', name: 'Login' },
      { id: 'factory-api-key', name: 'Factory API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('acp-registry:factory-droid', '/work')]: 'agent-factory'
      }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_factory_key_status') return true
      if (cmd === 'acp_authenticate') throw new Error('fk-sample-must-not-appear')
      // Authenticate-on-demand: the failed key path is only reached after the
      // first session/new reports auth-required; the error propagates with no
      // retry.
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-factory', '/work', undefined, 'p1')
    ).rejects.toThrow('Enter a new key or choose Login')
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_new_session')).toHaveLength(
      1
    )
  })
  it('detaches a credential-changed agent without closing its live sessions', async () => {
    const configId = 'acp-registry:factory-droid'
    const reuseKey = agentReuseKey(configId, '/work')
    const prepareKey = prepareChatKey(configId, '/work', undefined)
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [reuseKey]: 'old-agent' },
      prepareChatErrors: {
        ...s.prepareChatErrors,
        [prepareKey]: {
          category: 'multi-auth',
          label: 'Multiple sign-in methods',
          detail: 'Choose a method'
        }
      },
      sessions: {
        ...s.sessions,
        'existing-chat': {
          id: 'existing-chat',
          agentId: 'old-agent',
          cwd: '/work',
          projectId: 'p1',
          status: 'active',
          activeTurn: false,
          openTurnId: null,
          replaying: null,
          title: null,
          mcpServerCount: 0,
          modes: null,
          models: null,
          configOptions: []
        } as AcpSession
      }
    }))
    useAcpStore.getState().detachAgentForNewCredentials(configId, '/work')
    expect(useAcpStore.getState().configToLiveAgent[reuseKey]).toBeUndefined()
    expect(useAcpStore.getState().prepareChatErrors[prepareKey]).toBeUndefined()
    expect(useAcpStore.getState().sessions['existing-chat']?.status).toBe('active')
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'acp_kill_agent')).toBe(false)
  })
  it('sends authenticate when a method is clicked after a multi-auth prepare failure (QA F6)', async () => {
    // QA F6: the synchronous AmbiguousAuthError rejection from
    // `authenticateBeforeSession` used to wedge `inFlightAuth` (its in-body
    // finally ran before the map `set`), so clicking an advertised method
    // re-toasted the stale error and never sent an authenticate frame.
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'api_key', name: 'API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        // The first prepare hits auth-required (→ the picker); once signed in,
        // the retry prepare's session/new goes straight through.
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('multi-auth')
    })
    // The stale rejected entry must be gone: choosing a method sends a real
    // authenticate frame with that methodId — no re-toast, no silent no-op.
    await useAcpStore.getState().authenticateAgent('agent-9', 'api_key')
    const authCalls = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')
    expect(authCalls).toHaveLength(1)
    expect(authCalls[0]?.[1]).toEqual({ agentId: 'agent-9', methodId: 'api_key' })
    // Success is remembered: the method id is persisted per-config (never a
    // credential) so future processes can auto-authenticate on demand.
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {
        'cfg-1': 'api_key'
      })
    })
    // Re-prepare proceeds to session/new without re-auth.
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    await vi.waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(2)
    })
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    // The retry prepare cleared the multi-auth error — the banner is gone.
    expect(useAcpStore.getState().prepareChatErrors[key]).toBeUndefined()
    // Every advertised method is clickable: the other method sends its own
    // frame too (no no-op clicks).
    await useAcpStore.getState().authenticateAgent('agent-9', 'chatgpt')
    const allAuthCalls = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')
    expect(allAuthCalls).toHaveLength(2)
    expect(allAuthCalls[1]?.[1]).toEqual({ agentId: 'agent-9', methodId: 'chatgpt' })
  })

  it('keeps the multi-auth agent live and reusable after the prepare failure', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'api_key', name: 'API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('multi-auth')
    })
    // The live agent must survive a multi-auth failure so method clicks stay wired.
    expect(useAcpStore.getState().agents['agent-9']).toBeDefined()
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/work')]).toBe(
      'agent-9'
    )
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_kill_agent')).toHaveLength(0)
  })

  it('a failed authenticate rejects verbatim, stays unauthenticated, and re-sends on retry', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    let authCalls = 0
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') {
        authCalls += 1
        if (authCalls === 1) throw new Error('provider denied')
        return undefined
      }
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    // The real provider error surfaces verbatim — no rewrite, no stale wedge.
    await expect(
      useAcpStore.getState().authenticateAgent('agent-1', 'cursor_login')
    ).rejects.toThrow('provider denied')
    // The failure did not mark the agent authenticated and left nothing wedged:
    // createSession re-sends authenticate after session/new reports
    // auth-required (the failure left nothing to skip over).
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(authCalls).toBe(2)
    // A fresh click after the failure also sends its own frame (dedup map clean).
    await useAcpStore.getState().authenticateAgent('agent-1', 'cursor_login')
    expect(authCalls).toBe(3)
  })

  it('logs a redacted warning on authenticate failure (both paths) and rethrows verbatim', async () => {
    // Boundary-log contract (AGENTS.md: never log secrets): an agent's auth
    // failure may echo credentials in its error text, so the durable frontend
    // log records only that the request failed — never the method id nor the
    // raw error. The rejection itself still surfaces verbatim to the caller.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    // This describe has no per-test mock reset; start from a clean slate so
    // earlier auth-failure tests' logs don't pollute the assertions.
    vi.mocked(logFrontendError).mockClear()
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') throw new Error('invalid API key sk-secret-token')
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    // Manual path (authenticateAgent).
    await expect(
      useAcpStore.getState().authenticateAgent('agent-1', 'cursor_login')
    ).rejects.toThrow('invalid API key sk-secret-token')
    // Auto path (authenticateBeforeSession via createSession's auth-required
    // retry — session/new fails first so authenticate runs on demand).
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).rejects.toThrow('invalid API key sk-secret-token')

    const authLogs = vi
      .mocked(logFrontendError)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.source.startsWith('acp-store.authenticate'))
    expect(authLogs.map((e) => e.source).sort()).toEqual([
      'acp-store.authenticateAgent',
      'acp-store.authenticateBeforeSession'
    ])
    for (const entry of authLogs) {
      expect(entry.level).toBe('warn')
      expect(entry.message).not.toContain('cursor_login')
      expect(entry.message).not.toContain('invalid API key')
      expect(entry.message).not.toContain('sk-secret-token')
    }
  })

  it('does not wedge inFlightAuth for a no-auth agent (resolved-promise half of the wedge)', async () => {
    // The no-auth early return in `authenticateBeforeSession` also settles
    // synchronously; its cleanup must still run so a later manual authenticate
    // sends its own frame instead of reusing a wedged settled entry.
    seedLiveAgent('agent-2', [])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-2', '/work', undefined, 'p1')
    await useAcpStore.getState().authenticateAgent('agent-2', 'late_method')
    const authCalls = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')
    expect(authCalls).toHaveLength(1)
    expect(authCalls[0]?.[1]).toEqual({ agentId: 'agent-2', methodId: 'late_method' })
  })

  it('rejects an empty/whitespace method id without sending an authenticate frame', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(useAcpStore.getState().authenticateAgent('agent-1', '   ')).rejects.toThrow(
      'empty authentication method id'
    )
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
  })

  it('rejects a method the agent does not advertise, without consuming an in-flight authenticate', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    const gates: Array<() => void> = []
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') {
        await new Promise<void>((resolve) => gates.push(resolve))
        return undefined
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    const inFlight = useAcpStore.getState().authenticateAgent('agent-1', 'cursor_login')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    // An invalid click mid-flight must reject on its own — it must NOT resolve
    // onto the other method's in-flight authenticate.
    await expect(
      useAcpStore.getState().authenticateAgent('agent-1', 'stale_method')
    ).rejects.toThrow('no longer advertised')
    expect(gates).toHaveLength(1)
    gates[0]!()
    await inFlight
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
  })

  it('trims a whitespace-padded method id before sending the authenticate frame', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().authenticateAgent('agent-1', '  cursor_login  ')
    const authCalls = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')
    expect(authCalls).toHaveLength(1)
    expect(authCalls[0]?.[1]).toEqual({ agentId: 'agent-1', methodId: 'cursor_login' })
  })

  it('keeps a newer in-flight authenticate when a stale cleanup settles late', async () => {
    // Identity-guard regression: a disconnect drops the dedup entry
    // unconditionally; when the OLD authenticate then settles, its cleanup must
    // not delete the NEWER in-flight entry for the same agent.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    const gates: Array<() => void> = []
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') {
        await new Promise<void>((resolve) => gates.push(resolve))
        return undefined
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    const first = useAcpStore.getState().authenticateAgent('agent-1', 'cursor_login')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    // Mid-flight disconnect clears the dedup map; the re-sign-in sends a second
    // frame (correct — the process's auth state is unknown).
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-1' })
    const second = useAcpStore.getState().authenticateAgent('agent-1', 'cursor_login')
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    // The stale first round-trip settles; its late cleanup must leave the newer
    // entry alone, so a further click dedupes onto the SECOND round-trip
    // instead of sending a third frame.
    gates[0]!()
    await first
    const third = useAcpStore.getState().authenticateAgent('agent-1', 'cursor_login')
    expect(gates).toHaveLength(2)
    gates[1]!()
    await Promise.all([second, third])
    expect(gates).toHaveLength(2)
  })

  it('classifies a create_session agent_auth_required reply code as an auth setup error', async () => {
    // Frozen contract 2: story-7 servers tag agent-side auth failures with the
    // additive `agent_auth_required` code. The literal wire string is pinned
    // here (not the exported constant) so a spelling drift fails this test.
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') {
        throw Object.assign(new Error('Authentication required'), {
          code: 'agent_auth_required'
        })
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('auth')
    })
    expect(useAcpStore.getState().prepareChatErrors[key]?.detail).toBe('Authentication required')
    // An auth-category failure keeps the agent alive (no eviction) so Sign-in +
    // retry can re-authenticate against the same process.
    expect(useAcpStore.getState().agents['agent-9']).toBeDefined()
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_kill_agent')).toHaveLength(0)
  })

  it('dedupes concurrent authenticate for the same agent (P2)', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    let sessionCounter = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        sessionCounter += 1
        // Both initial session/new calls report auth-required; the retries
        // (after the shared authenticate) succeed.
        if (sessionCounter <= 2) throw authRequiredError()
        return { sessionId: `s${sessionCounter}` }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await Promise.all([
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1'),
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ])
    // One shared authenticate, then each createSession retried session/new.
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(4)
  })

  it('clears the authenticated flag on an auth-category session/new failure so retry re-authenticates (P3)', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        // Attempt 1: auth-required → on-demand authenticate → retry fails
        // with a generic auth error (not the auth-required signal), which
        // clears the authenticated flag. Attempt 2: auth-required again → a
        // second authenticate must run → retry succeeds.
        if (newSessionCalls === 1 || newSessionCalls === 3) throw authRequiredError()
        if (newSessionCalls === 2) throw 'authentication required: run cursor login'
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).rejects.toBeDefined()
    // Retry: because the auth failure cleared the authenticated flag, authenticate runs again.
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(2)
  })

  it('surfaces an auth error and clears the flag when the post-authenticate retry still reports auth-required', async () => {
    // I/O matrix: "Second AuthRequired after auth" — authenticate succeeded,
    // the retry still reports auth-required → existing `auth` prepare error +
    // `authenticatedAgents` cleared so a manual retry re-authenticates.
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Cursor', command: 'cursor', args: [], env: {} })
    seedLiveAgent('agent-9', [{ id: 'cursor_login', name: 'Cursor' }])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        // First prepare: auth-required → authenticate → retry auth-required.
        // Second prepare: auth-required → re-authenticate → success — proves
        // the flag was cleared by the first failure.
        if (newSessionCalls === 4) return { sessionId: 's1' }
        throw authRequiredError()
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('auth')
    })
    // Exactly one retry after the authenticate — never a third session/new.
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(2)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    // Manual retry re-runs authenticate (flag cleared), then succeeds.
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    await vi.waitFor(() => {
      expect(useAcpStore.getState().preparedSessions[key]).toBe('s1')
    })
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(2)
    expect(useAcpStore.getState().prepareChatErrors[key]).toBeUndefined()
  })

  it('evicts a live agent after a transport-destroyed session/new (kills + drops reuse)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Pi', command: 'pi', args: [], env: {} })
    seedLiveAgent('agent-9', [])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') throw 'the stream was destroyed'
      if (cmd === 'acp_kill_agent') return undefined
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-9', '/work', undefined, 'p1')
    ).rejects.toBeDefined()
    // The broken process was killed and dropped from reuse so a retry spawns fresh.
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_kill_agent')).toHaveLength(1)
    expect(useAcpStore.getState().agents['agent-9']).toBeUndefined()
    expect(
      useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/work')]
    ).toBeUndefined()
  })

  it('warns but does not mask the setup error when the eviction kill fails (P8)', async () => {
    seedLiveAgent('agent-9', [])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') throw 'connection reset by peer'
      if (cmd === 'acp_kill_agent') throw 'kill failed'
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-9', '/work', undefined, 'p1')
    ).rejects.toBe('connection reset by peer')
    expect(warn).toHaveBeenCalledWith(
      '[acp] failed to kill agent during transport eviction',
      'agent-9',
      'kill failed'
    )
    warn.mockRestore()
  })

  it('does NOT evict the agent on an auth or timeout failure', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') throw 'session/new timed out after 60s'
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).rejects.toBeDefined()
    // A timeout leaves the (alive) agent in place — no kill.
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_kill_agent')).toHaveLength(0)
    expect(useAcpStore.getState().agents['agent-1']).toBeDefined()
  })

  it('authenticateAgent runs authenticate and lets the next createSession skip re-auth', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().authenticateAgent('agent-1', 'cursor_login')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    // The subsequent prepare/session must not authenticate again.
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(1)
  })

  it('never auto-authenticates a single terminal method — session/new runs directly (spec-acp-terminal-auth)', async () => {
    // Terminal methods require an explicit click that spawns a login
    // terminal tab; `authenticateBeforeSession` must not send `authenticate`
    // for them even when they are the only advertised method.
    seedLiveAgent('agent-1', [
      { id: 'devin-terminal-login', name: 'Terminal login', type: 'terminal', args: ['--login'] }
    ])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(1)
  })

  it('never auto-authenticates a single env_var method (spec-acp-terminal-auth)', async () => {
    seedLiveAgent('agent-1', [{ id: 'api_key_env', name: 'API key env', type: 'env_var' }])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(1)
  })

  it('still auto-authenticates a single agent-type method on auth-required (spec-acp-terminal-auth)', async () => {
    seedLiveAgent('agent-1', [{ id: 'devin-browser', name: 'Browser sign-in', type: 'agent' }])
    const order: string[] = []
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(order).toEqual(['acp_new_session', 'acp_authenticate', 'acp_new_session'])
  })

  it('treats a method with no type as agent (pre-extension wire compat)', async () => {
    // Older hosts only ever forwarded agent methods and carry no `type`
    // field; auto-auth must keep working for them.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
  })

  it('rejects a mixed agent+terminal method list without auto-picking (AmbiguousAuthError preserved)', async () => {
    // Devin advertises both `devin-browser` (agent) and `devin-terminal-login`
    // (terminal): no auto-pick — the user chooses in the banner. With
    // authenticate-on-demand this surfaces only after session/new reports
    // auth-required; a successful session/new means no auth UI at all.
    seedLiveAgent('agent-1', [
      { id: 'devin-browser', name: 'Browser sign-in', type: 'agent' },
      { id: 'devin-terminal-login', name: 'Terminal login', type: 'terminal', args: ['--login'] }
    ])
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).rejects.toBeDefined()
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(1)
  })

  it('sets pendingBrowserOpen on browser_open_request and clears it on auth success', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    const authenticate = vi.fn(async () => undefined)
    _setAcpTransportForTests({
      onEvent: vi.fn((name: string, callback: (payload: unknown) => void) => {
        listeners.set(name, callback)
        return () => listeners.delete(name)
      }),
      authenticate,
      dispose: vi.fn()
    } as unknown as AcpTransport)
    const teardown = initAcpEventListeners()
    try {
      seedLiveAgent('agent-1', [{ id: 'devin-browser', name: 'Browser sign-in', type: 'agent' }])
      listeners.get('acp:browser_open_request')?.({
        agentId: 'agent-1',
        url: 'https://auth.example.com/login?state=abc'
      })
      expect(useAcpStore.getState().pendingBrowserOpen['agent-1']).toBe(
        'https://auth.example.com/login?state=abc'
      )

      // Malformed events are ignored — no empty-key/empty-url entries.
      listeners.get('acp:browser_open_request')?.({ agentId: '', url: 'https://x' })
      listeners.get('acp:browser_open_request')?.({ agentId: 'agent-2', url: '' })
      expect(useAcpStore.getState().pendingBrowserOpen['']).toBeUndefined()
      expect(useAcpStore.getState().pendingBrowserOpen['agent-2']).toBeUndefined()

      await useAcpStore.getState().authenticateAgent('agent-1', 'devin-browser')
      expect(authenticate).toHaveBeenCalledWith('agent-1', 'devin-browser', undefined)
      expect(useAcpStore.getState().pendingBrowserOpen['agent-1']).toBeUndefined()
    } finally {
      teardown()
      _resetAcpTransportForTests()
    }
  })

  it('clears pendingBrowserOpen on killAgent and on agent disconnect', async () => {
    seedLiveAgent('agent-1', [])
    useAcpStore.setState((s) => ({
      pendingBrowserOpen: { ...s.pendingBrowserOpen, 'agent-1': 'https://auth.example.com/x' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_kill_agent') return undefined
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().killAgent('agent-1')
    expect(useAcpStore.getState().pendingBrowserOpen['agent-1']).toBeUndefined()

    // Disconnect path: a dead process must not leave a stale dialog URL.
    seedLiveAgent('agent-2', [])
    useAcpStore.setState((s) => ({
      pendingBrowserOpen: { ...s.pendingBrowserOpen, 'agent-2': 'https://auth.example.com/y' }
    }))
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-2' })
    expect(useAcpStore.getState().pendingBrowserOpen['agent-2']).toBeUndefined()
  })

  it('clearPendingBrowserOpen dismisses the captured URL (dialog dismiss)', () => {
    useAcpStore.setState((s) => ({
      pendingBrowserOpen: { ...s.pendingBrowserOpen, 'agent-1': 'https://auth.example.com/x' }
    }))
    useAcpStore.getState().clearPendingBrowserOpen('agent-1')
    expect(useAcpStore.getState().pendingBrowserOpen['agent-1']).toBeUndefined()
    // Idempotent: clearing an absent key is a no-op, not a crash.
    useAcpStore.getState().clearPendingBrowserOpen('agent-1')
  })
  it('authenticateBeforeSession clears pendingBrowserOpen on success', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor', type: 'agent' }])
    useAcpStore.setState((s) => ({
      pendingBrowserOpen: { ...s.pendingBrowserOpen, 'agent-1': 'https://auth.example.com/x' }
    }))
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(useAcpStore.getState().pendingBrowserOpen['agent-1']).toBeUndefined()
  })

  it('_onBrowserOpenRequest drops non-http URLs and buffers pre-registration events', () => {
    seedLiveAgent('agent-1', [])
    // Non-http(s) lines the shim can capture are not real open requests.
    useAcpStore.getState()._onBrowserOpenRequest({ agentId: 'agent-1', url: 'not a url' })
    useAcpStore.getState()._onBrowserOpenRequest({ agentId: 'agent-1', url: 'file:///etc/x' })
    useAcpStore.getState()._onBrowserOpenRequest({ agentId: 'agent-1', url: 'ftp://x' })
    // An event for an agent that is not yet registered is buffered, not
    // shown — the shim watcher can emit before agent_spawned arrives.
    useAcpStore.getState()._onBrowserOpenRequest({ agentId: 'ghost', url: 'https://x' })
    expect(useAcpStore.getState().pendingBrowserOpen).toEqual({})
    // A real http(s) URL for a live agent is recorded.
    useAcpStore.getState()._onBrowserOpenRequest({ agentId: 'agent-1', url: 'https://auth.x/y' })
    expect(useAcpStore.getState().pendingBrowserOpen['agent-1']).toBe('https://auth.x/y')
  })

  it('_onAgentSpawned promotes a buffered browser-open request; teardown clears it', () => {
    // The shim watcher can emit browser_open_request before agent_spawned
    // reaches the renderer — the URL must survive until registration.
    useAcpStore
      .getState()
      ._onBrowserOpenRequest({ agentId: 'agent-early', url: 'https://auth.x/early' })
    expect(useAcpStore.getState().pendingBrowserOpen['agent-early']).toBeUndefined()
    useAcpStore
      .getState()
      ._onAgentSpawned({ agentId: 'agent-early', capabilities: {}, authMethods: [] })
    expect(useAcpStore.getState().pendingBrowserOpen['agent-early']).toBe('https://auth.x/early')
    // Teardown clears a still-buffered request too.
    useAcpStore
      .getState()
      ._onBrowserOpenRequest({ agentId: 'agent-ghost', url: 'https://auth.x/ghost' })
    useAcpStore.getState().clearPendingBrowserOpen('agent-ghost')
    useAcpStore
      .getState()
      ._onAgentSpawned({ agentId: 'agent-ghost', capabilities: {}, authMethods: [] })
    expect(useAcpStore.getState().pendingBrowserOpen['agent-ghost']).toBeUndefined()
  })

  it('completeBrowserAuth marks the agent authenticated, clears the URL, and re-prepares auth-failed chats', async () => {
    // A delivered paste-back redirect means the agent IS authenticated — no
    // `authenticate` round-trip. The auth-failed prepare must retry on its
    // own so the banner clears.
    seedLiveAgent('agent-1', [{ id: 'devin-browser', name: 'Browser sign-in', type: 'agent' }])
    const reuseKey = 'cfg-1\0/work'
    const errKey = `${reuseKey}\0`
    useAcpStore.setState((s) => ({
      agentConfigs: [
        ...s.agentConfigs,
        { id: 'cfg-1', name: 'Devin', command: 'devin', args: ['acp'], env: {} }
      ],
      configToLiveAgent: { ...s.configToLiveAgent, [reuseKey]: 'agent-1' },
      pendingBrowserOpen: { ...s.pendingBrowserOpen, 'agent-1': 'https://auth.example.com/x' },
      prepareChatErrors: {
        ...s.prepareChatErrors,
        [errKey]: { category: 'auth', label: 'Authentication required', detail: 'sign in' }
      }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') return { sessionId: 's-new' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    // completeBrowserAuth re-prepares under the active project.
    useProjectStore.setState({ activeProjectId: 'p1' })
    try {
      useAcpStore.getState().completeBrowserAuth('agent-1')
      expect(useAcpStore.getState().pendingBrowserOpen['agent-1']).toBeUndefined()
      // The re-prepare ran createSession — which skipped its own authenticate
      // because the agent is now marked authenticated.
      await vi.waitFor(() => {
        expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(
          1
        )
      })
      expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    } finally {
      useProjectStore.setState({ activeProjectId: '' })
    }
  })

  it('completeBrowserAuth skips detached reuse keys instead of preparing with a corrupted cwd (S1)', async () => {
    // A detached key (`configId\0cwd\0agentId`) keeps a superseded process
    // resolvable but must never seed a new prepare — its third segment is an
    // agent id, and the old code passed that agent id to prepareChat as the
    // cwd. The canonical key for the same agent still re-prepares normally.
    seedLiveAgent('agent-1', [{ id: 'devin-browser', name: 'Browser sign-in', type: 'agent' }])
    const configId = 'cfg-1'
    const canonicalKey = agentReuseKey(configId, '/work')
    const detachedKey = `${canonicalKey}\0agent-1`
    useAcpStore.setState((s) => ({
      agentConfigs: [
        ...s.agentConfigs,
        { id: configId, name: 'Devin', command: 'devin', args: ['acp'], env: {} }
      ],
      configToLiveAgent: { ...s.configToLiveAgent, [detachedKey]: 'agent-1' },
      prepareChatErrors: {
        ...s.prepareChatErrors,
        // An auth error keyed to the DETACHED reuse key (historically
        // possible: prepare keys prefix-match their reuse key).
        [`${detachedKey}\0`]: {
          category: 'auth',
          label: 'Authentication required',
          detail: 'sign in'
        }
      }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') return { sessionId: 's-new' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useProjectStore.setState({ activeProjectId: 'p1' })
    try {
      useAcpStore.getState().completeBrowserAuth('agent-1')
      // Let microtasks settle, then assert no re-prepare happened at all: the
      // only live mapping is detached, and a detached key must not re-prepare
      // (certainly not with the agent id as the cwd).
      await Promise.resolve()
      await Promise.resolve()
      const prepareCalls = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')
      expect(prepareCalls).toHaveLength(0)
      // The detached mapping is untouched (still resolvable for history).
      expect(useAcpStore.getState().configToLiveAgent[detachedKey]).toBe('agent-1')
    } finally {
      useProjectStore.setState({ activeProjectId: '' })
    }
  })

  it('auto-authenticates a multi-method agent with the remembered method and retries once', async () => {
    // spec-acp-persistent-auth-reuse: a multi-method agent may auto-auth ONLY
    // with the method id the user previously succeeded with (persisted per
    // configId). Seed the memory via the `acp/auth-methods` init load.
    await seedAuthMethodMemory({ 'cfg-1': 'api_key' })
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'api_key', name: 'API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    const order: string[] = []
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-9', '/work', undefined, 'p1')
    ).resolves.toBe('s1')
    // session/new → authenticate(remembered) → session/new — and no picker.
    expect(order).toEqual(['acp_new_session', 'acp_authenticate', 'acp_new_session'])
    const authCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'acp_authenticate')
    expect(authCall?.[1]).toEqual({ agentId: 'agent-9', methodId: 'api_key' })
  })

  it('shows the picker for a multi-method agent with no remembered method', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'api_key', name: 'API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('multi-auth')
    })
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
  })

  it('clears stale memory and shows the picker when the remembered method id is gone', async () => {
    await seedAuthMethodMemory({ 'cfg-1': 'removed_method' })
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'api_key', name: 'API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('multi-auth')
    })
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    // The stale entry was evicted — persisted map written back empty.
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {})
    })
  })

  it('shows the picker when the remembered method is terminal-type (terminal auth is interactive)', async () => {
    // A terminal method CAN be recorded (the login-TUI path also runs
    // `authenticateAgent` on exit-0) but must never be auto-run — the user
    // re-runs the interactive login through the picker.
    await seedAuthMethodMemory({ 'cfg-1': 'devin-terminal-login' })
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Devin', command: 'devin', args: ['acp'], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'devin-browser', name: 'Browser sign-in', type: 'agent' },
      { id: 'devin-terminal-login', name: 'Terminal login', type: 'terminal', args: ['--login'] }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('multi-auth')
    })
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    // The dead remembered entry was evicted — persisted map written back empty.
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {})
    })
  })

  it('clears memory and falls back to the picker when the remembered method fails to authenticate', async () => {
    await seedAuthMethodMemory({ 'cfg-1': 'api_key' })
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'api_key', name: 'API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') throw new Error('authentication denied by provider')
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    // An auth-classified failure on a REMEMBERED method is a dead end —
    // memory cleared, picker shown (multi-auth) rather than surfacing a bare
    // auth error.
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('multi-auth')
    })
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {})
    })
  })

  it('keeps remembered memory and the error category when a remembered authenticate fails non-auth', async () => {
    // A transport-level authenticate failure is NOT a dead remembered pick:
    // the memory must survive (the method may still be valid) and the original
    // category must propagate so transport eviction still runs — converting it
    // to AmbiguousAuthError would mask 'transport' as 'multi-auth'.
    await seedAuthMethodMemory({ 'cfg-1': 'api_key' })
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'api_key', name: 'API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') throw new Error('connection reset')
      if (cmd === 'acp_new_session') throw authRequiredError()
      if (cmd === 'acp_kill_agent') return undefined
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('transport')
    })
    // Memory untouched: no acp/auth-methods write may fire.
    expect(
      vi.mocked(mockPersistenceApi.write).mock.calls.filter(([k]) => k === 'acp/auth-methods')
    ).toHaveLength(0)
  })

  it('persists the winning method id after a successful on-demand authenticate', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Cursor', command: 'cursor', args: [], env: {} })
    seedLiveAgent('agent-9', [{ id: 'cursor_login', name: 'Cursor' }])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-9', '/work', undefined, 'p1')
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {
        'cfg-1': 'cursor_login'
      })
    })
  })

  it('retries after authenticate for the legacy ACP_AUTH_REQUIRED message prefix', async () => {
    // The pre-code desktop signal (message prefix) drives the same
    // authenticate-once + retry path as the `agent_auth_required` wire code.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) {
          throw new Error('ACP_AUTH_REQUIRED: run `cursor login` first')
        }
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).resolves.toBe('s1')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(2)
  })

  it('authenticates once and retries when a reopened session reports auth-required (session/load)', async () => {
    // Reopen path: the same authenticate-on-demand helper wraps
    // `session/load`/`session/resume` (spec-acp-persistent-auth-reuse).
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }], { loadSession: true })
    const order: string[] = []
    let loadCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_load_session') {
        loadCalls += 1
        if (loadCalls === 1) throw authRequiredError()
        return {}
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-x', '/work', 'p1')
    expect(order).toEqual(['acp_load_session', 'acp_authenticate', 'acp_load_session'])
    expect(useAcpStore.getState().sessions['sess-x']?.status).toBe('active')
  })

  it('authenticates once and retries when a reopened session reports auth-required (session/resume)', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }], {
      sessionCapabilities: { resume: {} }
    })
    const order: string[] = []
    let resumeCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_resume_session') {
        resumeCalls += 1
        if (resumeCalls === 1) throw authRequiredError()
        return {}
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-x', '/work', 'p1')
    expect(order).toEqual(['acp_resume_session', 'acp_authenticate', 'acp_resume_session'])
    expect(useAcpStore.getState().sessions['sess-x']?.status).toBe('active')
  })

  it('surfaces the resume error when the retried reopen still reports auth-required', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }], { loadSession: true })
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_load_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-x', '/work', 'p1')
    ).rejects.toBeDefined()
    // Exactly one retry after authenticate — the existing resume-error surface
    // carries the failure.
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_load_session')).toHaveLength(2)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    expect(useAcpStore.getState().sessions['sess-x']?.lastError).toContain('not authenticated')
  })

  /** Minimal persisted-payload fixture — one user message so the reopen installs a transcript. */
  const storedPayload = (id: string) => ({
    metadata: {
      id,
      agentId: 'agent-1',
      title: 'Reopen me',
      cwd: '/w',
      projectId: 'p1',
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: 1,
      status: 'closed'
    },
    messages: [
      {
        id: 'm1',
        role: 'user',
        blocks: [{ type: 'text', text: 'prior' }],
        streaming: false,
        timestamp: 0
      }
    ]
  })

  it('openHistorySession authenticates on demand when session/load reports auth-required', async () => {
    // The PRIMARY reopen path (history index → openHistorySessionInner) uses
    // the same authenticate-on-demand helper — pin the call order and the
    // session landing active.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }], { loadSession: true })
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      storedPayload('s-auth-load')
    )
    const order: string[] = []
    let loadCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_load_session') {
        loadCalls += 1
        if (loadCalls === 1) throw authRequiredError()
        return {}
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().openHistorySession('s-auth-load')
    expect(order).toEqual(['acp_load_session', 'acp_authenticate', 'acp_load_session'])
    expect(useAcpStore.getState().sessions['s-auth-load']?.status).toBe('active')
  })

  it('openHistorySession authenticates on demand when session/resume reports auth-required', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }], {
      sessionCapabilities: { resume: {} }
    })
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      storedPayload('s-auth-resume')
    )
    const order: string[] = []
    let resumeCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_resume_session') {
        resumeCalls += 1
        if (resumeCalls === 1) throw authRequiredError()
        return {}
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().openHistorySession('s-auth-resume')
    expect(order).toEqual(['acp_resume_session', 'acp_authenticate', 'acp_resume_session'])
    expect(useAcpStore.getState().sessions['s-auth-resume']?.status).toBe('active')
  })

  it('re-authenticates on a second openHistorySession after the first retry still reports auth-required', async () => {
    // Stale-flag wedge: the first open's authenticate SUCCEEDED (the flag was
    // set) yet the retried session/load still failed auth-required. The next
    // open must re-send `authenticate` — a stale `authenticatedAgents` entry
    // must not suppress it, and a dead remembered pick must not loop.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }], { loadSession: true })
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    const payloadMock = loadSessionPayload as ReturnType<typeof vi.fn>
    payloadMock
      .mockResolvedValueOnce(storedPayload('s-wedge'))
      .mockResolvedValueOnce(storedPayload('s-wedge'))
    let loadCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_load_session') {
        loadCalls += 1
        throw authRequiredError()
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(useAcpStore.getState().openHistorySession('s-wedge')).rejects.toBeDefined()
    await expect(useAcpStore.getState().openHistorySession('s-wedge')).rejects.toBeDefined()
    // Each open: load → authenticate → load. The second authenticate proves
    // the stale flag was purged inside withAuthRetry.
    expect(loadCalls).toBe(4)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(2)
  })

  it('re-authenticates on auth-required even when the agent was already flagged authenticated', async () => {
    // The same wedge on session/new: a flag from an earlier success (e.g. a
    // token that later expired server-side) must not skip re-authentication.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    // Flag the agent via an explicit successful sign-in.
    await useAcpStore.getState().authenticateAgent('agent-1', 'cursor_login')
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).resolves.toBe('s1')
    // session/new auth-required → flag purged → authenticate re-sent → retry.
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(2)
    expect(newSessionCalls).toBe(2)
  })

  it('does not retry when there is nothing to authenticate with (skips the doomed retry)', async () => {
    // An agent with no advertised methods can never auto-authenticate —
    // propagate the original error instead of issuing a guaranteed-duplicate
    // second session/new.
    seedLiveAgent('agent-1', [])
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        throw authRequiredError()
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).rejects.toBeDefined()
    expect(newSessionCalls).toBe(1)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
  })

  it('does not retry when the only advertised method is non-agent (terminal/env_var stay interactive)', async () => {
    // A terminal method cannot be driven automatically — the original
    // auth-required error surfaces verbatim; the banner offers the explicit
    // sign-in paths instead of a pointless duplicate session/new.
    seedLiveAgent('agent-1', [
      { id: 'devin-terminal-login', name: 'Terminal login', type: 'terminal', args: ['--login'] }
    ])
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        throw authRequiredError()
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).rejects.toBeDefined()
    expect(newSessionCalls).toBe(1)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
  })

  it('authenticates on demand for a bare-string ACP_AUTH_REQUIRED rejection (real Tauri rejection shape)', async () => {
    // Tauri command rejections surface as PLAIN STRINGS, not Error objects —
    // `isAgentAuthRequiredError` handles both; pin the string path.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    const order: string[] = []
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw 'ACP_AUTH_REQUIRED: run `cursor login` first'
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).resolves.toBe('s1')
    expect(order).toEqual(['acp_new_session', 'acp_authenticate', 'acp_new_session'])
  })

  it('authenticates on demand for a natural-language auth failure (no wire code/prefix)', async () => {
    // Some agents never emit `agent_auth_required`/`ACP_AUTH_REQUIRED` — a
    // failure that classifies as category 'auth' still triggers the
    // authenticate+retry so single-method agents keep working.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    const order: string[] = []
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) {
          throw new Error('authentication required: run cursor login')
        }
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ).resolves.toBe('s1')
    expect(order).toEqual(['acp_new_session', 'acp_authenticate', 'acp_new_session'])
  })

  it('loadAgentConfigs still populates configs when the auth-method memory read fails', async () => {
    // A real persistence/backend error (not KEY_NOT_FOUND) must not fail the
    // init boundary — memory stays empty and the picker is the fallback.
    const { loadAgentConfigs } = await import('@/lib/acp-agents-persistence')
    vi.mocked(loadAgentConfigs).mockResolvedValueOnce([
      { id: 'cfg-1', name: 'Devin', command: 'devin', args: ['acp'], env: {} }
    ])
    mockPersistenceApi.read.mockResolvedValue({
      success: false,
      code: 'BACKEND_ERROR',
      error: 'store corrupted'
    })
    await expect(useAcpStore.getState().loadAgentConfigs()).resolves.toBeUndefined()
    expect(useAcpStore.getState().agentConfigs.map((c) => c.id)).toEqual(['cfg-1'])
    expect(
      vi
        .mocked(logFrontendError)
        .mock.calls.map((c) => c[0])
        .some(
          (e) =>
            e.source === 'acp.loadAgentConfigs' &&
            e.level === 'warn' &&
            e.message.includes('auth methods')
        )
    ).toBe(true)
  })

  it('forgets stale memory when the sole advertised method no longer matches the remembered id', async () => {
    // Stale cleanup beyond the multi-method branch: a remembered id that can
    // never match again is evicted, then the winning single method is
    // re-remembered after its authenticate succeeds.
    await seedAuthMethodMemory({ 'cfg-1': 'removed_method' })
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Cursor', command: 'cursor', args: [], env: {} })
    seedLiveAgent('agent-9', [{ id: 'cursor_login', name: 'Cursor' }])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-9', '/work', undefined, 'p1')
    ).resolves.toBe('s1')
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {})
    })
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {
        'cfg-1': 'cursor_login'
      })
    })
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
  })

  it('forgets the remembered method when the post-authenticate retry still fails auth', async () => {
    // A method that authenticates but cannot authorize the session is a dead
    // remembered pick — drop it so the next failure shows the picker.
    await seedAuthMethodMemory({ 'cfg-1': 'api_key' })
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'api_key', name: 'API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => {
      expect(useAcpStore.getState().prepareChatErrors[key]?.category).toBe('auth')
    })
    // authenticate ran (remembered pick), the retry still failed → forgotten.
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {})
    })
  })

  it('sends a second authenticate when an explicit click targets a different method mid-flight', async () => {
    // inFlightAuth is keyed agent+method: a Sign-in click for method B must
    // not resolve onto remembered method A's in-flight auto-authenticate.
    await seedAuthMethodMemory({ 'cfg-1': 'api_key' })
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'api_key', name: 'API Key' }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    const gates: Array<() => void> = []
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') {
        await new Promise<void>((resolve) => gates.push(resolve))
        return undefined
      }
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw authRequiredError()
        return { sessionId: 's1' }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    const pending = useAcpStore.getState().createSession('agent-9', '/work', undefined, 'p1')
    // Auto-auth on the remembered 'api_key' is in flight…
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    // …an explicit click on 'chatgpt' must send its OWN frame, not coalesce.
    const click = useAcpStore.getState().authenticateAgent('agent-9', 'chatgpt')
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    for (const g of gates) g()
    await Promise.all([pending, click])
    const authCalls = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')
    expect(authCalls).toHaveLength(2)
    expect(authCalls[0]?.[1]).toEqual({ agentId: 'agent-9', methodId: 'api_key' })
    expect(authCalls[1]?.[1]).toEqual({ agentId: 'agent-9', methodId: 'chatgpt' })
  })

  it('does not persist a successful terminal-method sign-in as the remembered method', async () => {
    // Terminal login is interactive-only — remembering it would wedge
    // auto-auth on a pick that can never run silently next process.
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Devin', command: 'devin', args: ['acp'], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'devin-browser', name: 'Browser sign-in', type: 'agent' },
      { id: 'devin-terminal-login', name: 'Terminal login', type: 'terminal', args: ['--login'] }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    // The terminal sign-in frame goes out and succeeds…
    await useAcpStore.getState().authenticateAgent('agent-9', 'devin-terminal-login')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    // …but its id is NOT persisted as the auto-auth pick.
    expect(mockPersistenceApi.write).not.toHaveBeenCalled()
    // Contrast: the agent-type method IS persisted on success.
    await useAcpStore.getState().authenticateAgent('agent-9', 'devin-browser')
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {
        'cfg-1': 'devin-browser'
      })
    })
  })

  it('completeBrowserAuth persists the attempted method id for future processes', async () => {
    // Browser auth completes out-of-band (OAuth redirect) — no authenticate
    // reply — so the attempted method id is recorded via `lastAuthAttempt`.
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Devin', command: 'devin', args: ['acp'], env: {} })
    seedLiveAgent('agent-9', [{ id: 'devin-browser', name: 'Browser sign-in', type: 'agent' }])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    const gates: Array<() => void> = []
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') {
        await new Promise<void>((resolve) => gates.push(resolve))
        return undefined
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    const pending = useAcpStore.getState().authenticateAgent('agent-9', 'devin-browser')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    // The OAuth redirect lands while `authenticate` is still in flight.
    useAcpStore.getState().completeBrowserAuth('agent-9')
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {
        'cfg-1': 'devin-browser'
      })
    })
    gates[0]!()
    await pending
  })

  it('completeBrowserAuth does not persist a terminal-type attempted method', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Devin', command: 'devin', args: ['acp'], env: {} })
    seedLiveAgent('agent-9', [
      { id: 'devin-browser', name: 'Browser sign-in', type: 'agent' },
      { id: 'devin-terminal-login', name: 'Terminal login', type: 'terminal', args: ['--login'] }
    ])
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    const gates: Array<() => void> = []
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') {
        await new Promise<void>((resolve) => gates.push(resolve))
        return undefined
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    const pending = useAcpStore.getState().authenticateAgent('agent-9', 'devin-terminal-login')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    useAcpStore.getState().completeBrowserAuth('agent-9')
    // The interactive-only method id is never persisted.
    expect(mockPersistenceApi.write).not.toHaveBeenCalled()
    gates[0]!()
    await pending
  })

  it('deleteAgentConfig drops the remembered auth method for the deleted config', async () => {
    // A deleted config must not leave memory on disk for a recreated config
    // reusing the same id to inherit.
    await seedAuthMethodMemory({ 'cfg-1': 'api_key' })
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Codex', command: 'codex', args: [], env: {} })
    await useAcpStore.getState().deleteAgentConfig('cfg-1')
    await vi.waitFor(() => {
      expect(mockPersistenceApi.write).toHaveBeenCalledWith('acp/auth-methods', {})
    })
    expect(useAcpStore.getState().agentConfigs).toEqual([])
  })

  it('translates a multi-method reopen failure into actionable text (no picker on reopen)', async () => {
    // Text surface (openDiscoveredSession → lastError + Retry): the
    // AmbiguousAuthError's "pick one of the methods below" is a dead end —
    // the picker lives on the new-chat launcher, so the message must say so.
    seedLiveAgent(
      'agent-1',
      [
        { id: 'chatgpt', name: 'ChatGPT' },
        { id: 'api_key', name: 'API Key' }
      ],
      { loadSession: true }
    )
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_load_session') throw authRequiredError()
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await expect(
      useAcpStore.getState().openDiscoveredSession('agent-1', 'sess-x', '/work', 'p1')
    ).rejects.toThrow('choose a sign-in method')
    const lastError = useAcpStore.getState().sessions['sess-x']?.lastError ?? ''
    expect(lastError).toContain('choose a sign-in method')
    expect(lastError).not.toContain('pick one of the methods below')
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
  })
})
