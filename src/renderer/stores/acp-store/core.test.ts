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
  type AcpTransport
} from '@/lib/acp-transport'
import {
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  agentReuseKey,
  initAcpEventListeners,
  useAcpStore
} from '@/stores/acp-store'
import { deferred, FRESH, seedSession } from './testkit'

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

  it('generates a commit message from correlated chunks and removes temporary state', async () => {
    useAcpStore.setState({
      selectedAgentConfigId: 'cfg-1',
      agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }]
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-1', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 'commit-session' }
      if (command === 'acp_send_prompt') {
        useAcpStore.getState()._onMessageChunk({
          agentId: 'agent-1',
          sessionId: 'commit-session',
          role: 'agent',
          content: { type: 'text', text: '```json\n{"summary":"Add generator",' }
        })
        useAcpStore.getState()._onMessageChunk({
          agentId: 'agent-1',
          sessionId: 'commit-session',
          role: 'agent',
          content: { type: 'text', text: '"description":"Use staged diffs"}\n```' }
        })
        useAcpStore.getState()._onPromptComplete({
          agentId: 'agent-1',
          sessionId: 'commit-session',
          stopReason: 'end_turn'
        })
        return 'end_turn'
      }
      if (command === 'acp_dispose_ephemeral_session') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })

    await expect(
      useAcpStore.getState().generateCommitMessage('/work', 'diff --git a/file b/file')
    ).resolves.toEqual({ summary: 'Add generator', description: 'Use staged diffs' })
    expect(invoke).toHaveBeenCalledWith('acp_new_session', {
      agentId: 'agent-1',
      cwd: '/work',
      mcpServers: [],
      ephemeral: true
    })
    expect(useAcpStore.getState().sessions['commit-session']).toBeUndefined()
    expect(useAcpStore.getState().messages['commit-session']).toBeUndefined()
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_dispose_ephemeral_session')
    ).toBe(true)
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_close_session')).toBe(
      false
    )
  })

  it('rejects interactive commit generation without leaving temporary state', async () => {
    useAcpStore.setState({
      selectedAgentConfigId: 'cfg-1',
      agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }]
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-1', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 'commit-session' }
      if (command === 'acp_send_prompt') {
        useAcpStore.getState()._onPermissionRequest({
          agentId: 'agent-1',
          sessionId: 'commit-session',
          requestId: 'permission-1',
          options: [],
          toolCall: {}
        })
        return new Promise<string>(() => {})
      }
      if (command === 'acp_dispose_ephemeral_session') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })

    await expect(
      useAcpStore.getState().generateCommitMessage('/work', 'diff --git a/file b/file')
    ).rejects.toThrow('requested permission')
    expect(useAcpStore.getState().sessions['commit-session']).toBeUndefined()
    expect(useAcpStore.getState().pendingPermissions).toEqual({})
  })

  it('reaps a session that resolves after the overall generation timeout', async () => {
    vi.useFakeTimers()
    try {
      const lateSession = deferred<{ sessionId: string }>()
      useAcpStore.setState({
        selectedAgentConfigId: 'cfg-1',
        agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }],
        agents: {
          'agent-1': { id: 'agent-1', capabilities: {}, authMethods: [] }
        },
        agentStatus: { 'agent-1': 'connected' },
        configToLiveAgent: { [agentReuseKey('cfg-1', '/work')]: 'agent-1' }
      })
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'acp_new_session') return lateSession.promise
        if (command === 'acp_close_session' || command === 'acp_dispose_ephemeral_session') {
          return undefined
        }
        throw new Error(`unexpected invoke command: ${command}`)
      })

      const generation = useAcpStore
        .getState()
        .generateCommitMessage('/work', 'diff --git a/file b/file')
      const generationResult = generation.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(60_000)
      await expect(generationResult).resolves.toMatchObject({
        message: expect.stringContaining('timed out')
      })

      lateSession.resolve({ sessionId: 'late-commit-session' })
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()

      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(
            ([command, args]) =>
              command === 'acp_dispose_ephemeral_session' &&
              (args as { sessionId?: string })?.sessionId === 'late-commit-session'
          )
      ).toBe(true)
      expect(useAcpStore.getState().sessions['late-commit-session']).toBeUndefined()
      expect(useAcpStore.getState().messages['late-commit-session']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects commit generation when no selected configured agent exists', async () => {
    await expect(
      useAcpStore.getState().generateCommitMessage('/work', 'diff --git a/file b/file')
    ).rejects.toThrow('Configure and select an ACP agent')
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it('validates commit diff bounds before spawning an agent', async () => {
    useAcpStore.setState({
      selectedAgentConfigId: 'cfg-1',
      agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }]
    })
    await expect(useAcpStore.getState().generateCommitMessage('/work', '   ')).rejects.toThrow(
      'staged diff is empty'
    )
    await expect(
      useAcpStore.getState().generateCommitMessage('/work', 'x'.repeat(120_001))
    ).rejects.toThrow('too large')
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it('rejects malformed, abnormal, tool, question, crash, and disconnect responses', async () => {
    const scenarios = [
      { kind: 'malformed', error: 'invalid commit message' },
      { kind: 'abnormal', error: 'did not complete normally' },
      { kind: 'tool', error: 'attempted to use a tool' },
      { kind: 'question', error: 'interactive question' },
      { kind: 'crash', error: 'crashed' },
      { kind: 'disconnect', error: 'disconnected' }
    ]
    for (const scenario of scenarios) {
      _resetEphemeralSessionIdsForTesting()
      useAcpStore.setState({
        ...FRESH,
        selectedAgentConfigId: 'cfg-1',
        agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }]
      })
      vi.mocked(invoke).mockReset()
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'acp_spawn_agent')
          return { agentId: 'agent-1', capabilities: {}, authMethods: [] }
        if (command === 'acp_new_session') return { sessionId: 'commit-session' }
        if (command === 'acp_dispose_ephemeral_session') return undefined
        if (command === 'acp_send_prompt') {
          const store = useAcpStore.getState()
          if (scenario.kind === 'malformed') {
            store._onMessageChunk({
              agentId: 'agent-1',
              sessionId: 'commit-session',
              role: 'agent',
              content: { type: 'text', text: 'not json' }
            })
            store._onPromptComplete({
              agentId: 'agent-1',
              sessionId: 'commit-session',
              stopReason: 'end_turn'
            })
            return 'end_turn'
          }
          if (scenario.kind === 'abnormal') {
            store._onPromptComplete({
              agentId: 'agent-1',
              sessionId: 'commit-session',
              stopReason: 'refusal'
            })
            return 'refusal'
          }
          if (scenario.kind === 'tool') {
            store._onToolCall({
              agentId: 'agent-1',
              sessionId: 'commit-session',
              toolCall: { toolCallId: 't1', title: 'tool', status: 'pending' }
            })
          } else if (scenario.kind === 'question') {
            store._onQuestionRequest({
              agentId: 'agent-1',
              sessionId: 'commit-session',
              questionId: 'q1',
              question: 'Continue?',
              options: []
            })
          } else if (scenario.kind === 'crash') {
            store._onAgentCrashed({
              agentId: 'agent-1',
              sessionId: 'commit-session',
              message: 'agent crashed'
            })
          } else {
            store._onAgentDisconnected({ agentId: 'agent-1' })
          }
          return new Promise<string>(() => {})
        }
        throw new Error(`unexpected invoke command: ${command}`)
      })
      await expect(
        useAcpStore.getState().generateCommitMessage('/work', 'diff --git a/file b/file')
      ).rejects.toThrow(scenario.error)
      expect(useAcpStore.getState().sessions['commit-session']).toBeUndefined()
    }
  })

  it('rejects invalid commit summaries', async () => {
    for (const summary of ['line one\nline two', 'x'.repeat(73)]) {
      _resetEphemeralSessionIdsForTesting()
      useAcpStore.setState({
        ...FRESH,
        selectedAgentConfigId: 'cfg-1',
        agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }]
      })
      vi.mocked(invoke).mockReset()
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'acp_spawn_agent')
          return { agentId: 'agent-1', capabilities: {}, authMethods: [] }
        if (command === 'acp_new_session') return { sessionId: 'commit-session' }
        if (command === 'acp_dispose_ephemeral_session') return undefined
        if (command === 'acp_send_prompt') {
          useAcpStore.getState()._onMessageChunk({
            agentId: 'agent-1',
            sessionId: 'commit-session',
            role: 'agent',
            content: { type: 'text', text: JSON.stringify({ summary, description: '' }) }
          })
          useAcpStore.getState()._onPromptComplete({
            agentId: 'agent-1',
            sessionId: 'commit-session',
            stopReason: 'end_turn'
          })
          return 'end_turn'
        }
        throw new Error(`unexpected invoke command: ${command}`)
      })
      await expect(
        useAcpStore.getState().generateCommitMessage('/work', 'diff --git a/file b/file')
      ).rejects.toThrow('72 characters or contains a newline')
    }
  })

  it('createSession records sessionId -> agentId and activates it', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1' })
    const id = await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(id).toBe('s1')
    const session = useAcpStore.getState().sessions['s1']
    expect(session.agentId).toBe('agent-1')
    expect(useAcpStore.getState().activeSessionId).toBe('s1')
  })

  it('switchProject applies completed session context transactionally', async () => {
    seedSession('s-old', 'agent-1', false)
    useAcpStore.setState({ activeSessionId: 's-old' })
    const switchProject = vi.fn(async () => ({
      status: 'completed' as const,
      projectId: 'p2',
      sessionId: 's-new',
      cwd: '/work/p2',
      mcpServerCount: 3
    }))
    _setAcpTransportForTests({ switchProject, dispose: vi.fn() } as unknown as AcpTransport)

    await useAcpStore.getState().switchProject('p2')

    expect(switchProject).toHaveBeenCalledWith('p2')
    expect(useAcpStore.getState().activeSessionId).toBe('s-new')
    expect(useAcpStore.getState().sessions['s-new']).toMatchObject({
      agentId: 'agent-1',
      cwd: '/work/p2',
      projectId: 'p2',
      mcpServerCount: 3,
      status: 'active'
    })
    expect(useAcpStore.getState().queuedProjectSwitchId).toBeNull()
  })

  it('switchProject records queued state without changing the current session', async () => {
    seedSession('s-old', 'agent-1', true)
    useAcpStore.setState({ activeSessionId: 's-old' })
    const switchProject = vi.fn(async () => ({
      status: 'queued' as const,
      projectId: 'p2',
      currentSessionId: 's-old'
    }))
    _setAcpTransportForTests({ switchProject, dispose: vi.fn() } as unknown as AcpTransport)

    await useAcpStore.getState().switchProject('p2')

    expect(useAcpStore.getState().activeSessionId).toBe('s-old')
    expect(useAcpStore.getState().sessions['s-new']).toBeUndefined()
    expect(useAcpStore.getState().queuedProjectSwitchId).toBe('p2')
  })

  it('switchProject reopens an existing session from the history index (REOPEN branch)', async () => {
    seedSession('s-old', 'agent-1', false)
    useAcpStore.setState({ activeSessionId: 's-old' })
    // Seed the session index + a cached active session for the reopened id so
    // the REOPEN branch is taken (the existing switchProject test uses 's-new'
    // NOT in the index, exercising the blank path instead).
    useAcpStore.setState({
      sessionIndex: [
        {
          id: 's-reopen',
          agentId: 'agent-1',
          agentConfigId: 'cfg-1',
          title: 'Reopened Chat',
          cwd: '/work/p2',
          projectId: 'p2',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 3,
          status: 'active'
        }
      ],
      sessions: {
        ...useAcpStore.getState().sessions,
        's-reopen': {
          id: 's-reopen',
          agentId: 'agent-1',
          cwd: '/work/p2',
          projectId: 'p2',
          status: 'active',
          title: 'Reopened Chat',
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: 1
        }
      },
      messages: { ...useAcpStore.getState().messages, 's-reopen': [] }
    })
    const switchProject = vi.fn(async () => ({
      status: 'completed' as const,
      projectId: 'p2',
      sessionId: 's-reopen',
      cwd: '/work/p2',
      mcpServerCount: 3
    }))
    _setAcpTransportForTests({ switchProject, dispose: vi.fn() } as unknown as AcpTransport)

    await useAcpStore.getState().switchProject('p2')

    // The reopen branch fires addAgentChatTab + setTabFocusedSessionId +
    // sets activeSessionId (parity with the new-session branch).
    expect(addAgentChatTabSpy).toHaveBeenCalledWith('s-reopen')
    expect(setTabFocusedSessionIdSpy).toHaveBeenCalledWith('s-reopen')
    expect(useAcpStore.getState().activeSessionId).toBe('s-reopen')
    expect(useAcpStore.getState().queuedProjectSwitchId).toBeNull()
    // The cached session is NOT overwritten by the blank-session path.
    expect(useAcpStore.getState().sessions['s-reopen']).toMatchObject({
      title: 'Reopened Chat',
      projectId: 'p2'
    })
  })

  it('queued project switch failure clears matching state and surfaces a toast', () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    _setAcpTransportForTests({
      onEvent: vi.fn((name: string, callback: (payload: unknown) => void) => {
        listeners.set(name, callback)
        return () => listeners.delete(name)
      }),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({ queuedProjectSwitchId: 'p2' })
    const teardown = initAcpEventListeners()

    listeners.get('project_switch_failed')?.({
      requestId: 'r2',
      projectId: 'p2',
      previousSessionId: 's-old',
      message: 'switch persistence failed'
    })

    expect(useAcpStore.getState().queuedProjectSwitchId).toBeNull()
    expect(toastError).toHaveBeenCalledWith('switch persistence failed')
    teardown()
  })

  it('ignores a superseded queued project switch failure', () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    _setAcpTransportForTests({
      onEvent: vi.fn((name: string, callback: (payload: unknown) => void) => {
        listeners.set(name, callback)
        return () => listeners.delete(name)
      }),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({ queuedProjectSwitchId: 'p3' })
    const teardown = initAcpEventListeners()

    listeners.get('project_switch_failed')?.({
      requestId: 'r2',
      projectId: 'p2',
      previousSessionId: 's-old',
      message: 'replaced'
    })

    expect(useAcpStore.getState().queuedProjectSwitchId).toBe('p3')
    expect(toastError).not.toHaveBeenCalled()
    teardown()
  })

  it('createSession preserves native ACP session models', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: 's1',
      models: {
        currentModelId: 'kiro/claude-opus-4-8',
        availableModels: [
          { modelId: 'kiro/claude-opus-4-8', name: 'kiro/Claude Opus 4.8' },
          { modelId: 'openrouter/gpt-5.5', name: 'OpenRouter/GPT-5.5' }
        ]
      }
    })

    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')

    expect(useAcpStore.getState().sessions['s1'].models).toEqual({
      currentModelId: 'kiro/claude-opus-4-8',
      availableModels: [
        { modelId: 'kiro/claude-opus-4-8', name: 'kiro/Claude Opus 4.8' },
        { modelId: 'openrouter/gpt-5.5', name: 'OpenRouter/GPT-5.5' }
      ]
    })
  })

  it('setModel calls session/set_model and updates the current native ACP model', async () => {
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: {
          ...s.sessions['s1'],
          models: {
            currentModelId: 'kiro/claude-opus-4-8',
            availableModels: [
              { modelId: 'kiro/claude-opus-4-8', name: 'kiro/Claude Opus 4.8' },
              { modelId: 'openrouter/gpt-5.5', name: 'OpenRouter/GPT-5.5' }
            ]
          }
        }
      }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    await useAcpStore.getState().setModel('s1', 'openrouter/gpt-5.5')

    expect(invoke).toHaveBeenCalledWith('acp_set_model', {
      agentId: 'agent-1',
      sessionId: 's1',
      modelId: 'openrouter/gpt-5.5'
    })
    expect(useAcpStore.getState().sessions['s1'].models?.currentModelId).toBe('openrouter/gpt-5.5')
  })

  it('does not reapply a launcher model through a stale config option snapshot', async () => {
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: {
          ...s.sessions['s1'],
          models: {
            currentModelId: 'gpt-6-sol-medium',
            availableModels: [
              { modelId: 'gpt-6-sol-medium', name: 'GPT 6 Sol Medium' },
              { modelId: 'gpt-6-luna', name: 'GPT 6 Luna' }
            ]
          },
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gpt-6-sol-medium',
              options: [
                { value: 'gpt-6-sol-medium', name: 'GPT 6 Sol Medium' },
                { value: 'gpt-6-luna', name: 'GPT 6 Luna' }
              ]
            }
          ]
        }
      }
    }))
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // set_model
      .mockResolvedValueOnce([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-6-sol-medium',
          options: [
            { value: 'gpt-6-sol-medium', name: 'GPT 6 Sol Medium' },
            { value: 'gpt-6-luna', name: 'GPT 6 Luna' }
          ]
        }
      ]) // redundant set_config_option returns a stale model snapshot

    await useAcpStore.getState().applyPendingLauncherOptions('s1', {
      modelId: 'gpt-6-luna',
      configValues: { model: 'gpt-6-luna' }
    })

    expect(useAcpStore.getState().sessions.s1.models?.currentModelId).toBe('gpt-6-luna')
    expect(
      useAcpStore.getState().sessions.s1.configOptions.find((option) => option.id === 'model')
        ?.currentValue
    ).toBe('gpt-6-luna')
    expect(invoke).toHaveBeenCalledTimes(1)

    useAcpStore.getState()._onConfigOptionsUpdate({
      sessionId: 's1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-6-sol-medium',
          options: [
            { value: 'gpt-6-sol-medium', name: 'GPT 6 Sol Medium' },
            { value: 'gpt-6-luna', name: 'GPT 6 Luna' }
          ]
        }
      ]
    })
    expect(
      useAcpStore.getState().sessions.s1.configOptions.find((option) => option.id === 'model')
        ?.currentValue
    ).toBe('gpt-6-luna')
  })

  // Story 5.3 (AC3): transportReconnecting flag is additive state — verify
  // it starts false and can be flipped via setState (the store init wires the
  // WS transport listener to call setState; here we just verify the state
  // shape and the setter contract, not the listener wiring which needs the
  // real WsAcpTransport — covered in acp-transport.test.ts).
  it('initializes transportReconnecting to false', () => {
    expect(useAcpStore.getState().transportReconnecting).toBe(false)
  })

  it('flips transportReconnecting true/false via setState (additive, no AgentStatus change)', () => {
    useAcpStore.setState({ transportReconnecting: true })
    expect(useAcpStore.getState().transportReconnecting).toBe(true)
    // AgentStatus enum is unchanged — transportReconnecting is a separate flag.
    expect(useAcpStore.getState().agentStatus).toEqual({})
    useAcpStore.setState({ transportReconnecting: false })
    expect(useAcpStore.getState().transportReconnecting).toBe(false)
  })
})
