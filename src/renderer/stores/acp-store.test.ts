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
// setTabFocusedSessionId). `useWorkspaceStore` is only referenced by the
// reopen branch in acp-store, so this mock is transparent to every other
// test. `getTabFocusedSessionId` returns null so switchProject falls back to
// `activeSessionId` (matching the real behavior when no tab focus is set).
const { addAgentChatTabSpy, setTabFocusedSessionIdSpy } = vi.hoisted(() => ({
  addAgentChatTabSpy: vi.fn(),
  setTabFocusedSessionIdSpy: vi.fn()
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({ addAgentChatTab: addAgentChatTabSpy })
  }
}))

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: setTabFocusedSessionIdSpy,
  getTabFocusedSessionId: vi.fn(() => null)
}))

// Mock persistenceApi so composer-selection persistence calls are observable
// in tests without hitting the Tauri plugin-store transport. Preserve other
// `@/lib/api` exports via importActual so transitive imports still resolve.
const { mockPersistenceApi } = vi.hoisted(() => ({
  mockPersistenceApi: {
    read: vi.fn(),
    write: vi.fn(),
    writeDebounced: vi.fn()
  }
}))
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return { ...actual, persistenceApi: mockPersistenceApi }
})

import { invoke } from '@tauri-apps/api/core'
import type { PlanEntry } from '@/lib/acp-api'
import {
  _clearPayloadCacheForTesting,
  getCachedSessionPayload,
  loadSessionIndex,
  setCachedSessionPayload
} from '@/lib/acp-history-persistence'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport,
  AcpTransportError
} from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import {
  _addEphemeralSessionIdForTesting,
  _flushCoalescedForTesting,
  _isCoalescePendingForTesting,
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLoadingOlderForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  agentReuseKey,
  type ChatMessage,
  collectProjectsWithActiveAgentChat,
  configIdFromReuseKey,
  discoveryKey,
  initAcpEventListeners,
  MAX_LIVE_WINDOW_MESSAGES,
  prepareChatKey,
  selectAgentIdentity,
  selectConfigWarmState,
  useAcpStore
} from './acp-store'

const FRESH = {
  agents: {},
  agentStatus: {},
  agentConfigs: [],
  configToLiveAgent: {},
  warmingConfigs: {},
  preparedSessions: {},
  preparingChatKeys: {},
  prepareChatErrors: {},
  agentOptionsCache: {},
  sessionIndex: [],
  openingHistoryIds: {},
  restoringChatIds: {},
  launchingSessionIds: {},
  discoveredSessions: {},
  discoveringKeys: {},
  discoveredReopenContexts: {},
  mcpServers: [],
  sessions: {},
  activeSessionId: null,
  sessionUsage: {},
  messages: {},
  toolCalls: {},
  plans: {},
  commands: {},
  pendingPermissions: {},
  pendingQuestions: {},
  promptQueues: {},
  suppressQueueFlush: {},
  transportReconnecting: false,
  queuedProjectSwitchId: null
}

/**
 * Drain deferred turn-end callbacks (`setTimeout(0)`), which run after streamed
 * chunk handlers so macrotask-delivered chunks are not dropped.
 */
async function flushTurnEnd(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function seedSession(sessionId: string, agentId: string, activeTurn = true): void {
  useAcpStore.setState({
    sessions: {
      [sessionId]: {
        id: sessionId,
        agentId,
        cwd: '/work',
        projectId: 'p1',
        status: 'active',
        title: null,
        activeTurn,
        openTurnId: activeTurn ? 'seed-turn' : null,
        modes: null,
        models: null,
        configOptions: [],
        lastError: null,
        createdAt: Date.now()
      }
    },
    messages: { [sessionId]: [] }
  })
}

describe('collectProjectsWithActiveAgentChat', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
  })

  it('returns project ids with an open active turn', () => {
    seedSession('s1', 'agent-1', true)
    expect(collectProjectsWithActiveAgentChat(useAcpStore.getState().sessions)).toEqual(['p1'])
  })

  it('excludes closed sessions and idle turns', () => {
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
          openTurnId: 'turn-1',
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: 1
        },
        s2: {
          id: 's2',
          agentId: 'agent-2',
          cwd: '/work',
          projectId: 'p2',
          status: 'active',
          title: null,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: 1
        },
        s3: {
          id: 's3',
          agentId: 'agent-3',
          cwd: '/work',
          projectId: 'p3',
          status: 'closed',
          title: null,
          activeTurn: true,
          openTurnId: 'turn-3',
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: 1
        }
      }
    })
    expect(collectProjectsWithActiveAgentChat(useAcpStore.getState().sessions)).toEqual(['p1'])
  })
})

describe('acp-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(invoke as ReturnType<typeof vi.fn>).mockReset()
    mockPersistenceApi.read.mockReset()
    mockPersistenceApi.write.mockReset()
    mockPersistenceApi.writeDebounced.mockReset()
    mockPersistenceApi.read.mockResolvedValue({ success: false })
    mockPersistenceApi.writeDebounced.mockResolvedValue({ success: true })
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetAcpAuthForTesting()
    _resetInFlightPreparedForTesting()
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
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

  it('sendPrompt appends a user message and marks the turn active', async () => {
    seedSession('s1', 'agent-1', false)
    // never resolve, so the turn stays active for the assertion
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    void useAcpStore.getState().sendPrompt('s1', 'hi there')
    await Promise.resolve()
    const msgs = useAcpStore.getState().messages['s1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].blocks[0]).toEqual({ type: 'text', text: 'hi there' })
    // turn is marked active until the command resolves / prompt_complete fires
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(true)
  })

  it('stages the optimistic user message with a turn:<id> and dedups a same-turnId echo even when blocks differ', async () => {
    // Regression for the duplicate-bubble bug: the optimistic message and the
    // server `user_prompt` echo must share the same `turn:<turnId>` id so
    // `_onUserPrompt` dedups by id (not a fragile block-exact compare) — a
    // differing echo is collapsed into the optimistic message, not appended.
    seedSession('s1', 'agent-1', false)
    // never resolve, so the turn stays active for the assertion
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    void useAcpStore.getState().sendPrompt('s1', 'hi there')
    await Promise.resolve()
    const msgs = useAcpStore.getState().messages['s1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].id.startsWith('turn:')).toBe(true)
    const turnId = msgs[0].id.slice('turn:'.length)
    expect(turnId.length).toBeGreaterThan(0)
    // Server echoes the SAME turn id but with DIFFERENT block content — must
    // collapse into the optimistic message (dedup by id), not append a copy.
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's1',
      turnId,
      content: [{ type: 'text', text: 'echoed-different-blocks' }]
    })
    const after = useAcpStore.getState().messages['s1']
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(`turn:${turnId}`)
    expect(after[0].blocks[0]).toEqual({ type: 'text', text: 'hi there' })
  })

  it('sendPromptBlocks stores displayBlocks in the optimistic message while dispatching the wire blocks', async () => {
    // The composer splits display (token text, rendered as inline chips in the
    // timeline) from wire (path-framed text, dispatched to the agent). The
    // optimistic user message stores the DISPLAY blocks; the agent receives the
    // WIRE blocks. The display override must NOT alter what is dispatched.
    seedSession('s1', 'agent-1', false)
    const dispatched: Array<{ cmd: string; args: unknown }> = []
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string, args: unknown) => {
      dispatched.push({ cmd, args })
      return undefined
    })
    const wire = [{ type: 'text', text: '# Agent Skills\n\n---\n\n(git-worktree) hi' }]
    const display = [{ type: 'text', text: '\uE000git-worktree\uE001 hi' }]
    void useAcpStore.getState().sendPromptBlocks('s1', wire, { displayBlocks: display })
    await Promise.resolve()
    const msgs = useAcpStore.getState().messages['s1']
    expect(msgs).toHaveLength(1)
    // The optimistic user message stores the DISPLAY blocks (token text) so the
    // timeline renders inline chips.
    expect(msgs[0].blocks).toEqual(display)
    // The agent is dispatched the WIRE blocks (path-framed text), not the display.
    // The IPC transport sends `acp_send_prompt` with a `content` payload.
    const sendCall = dispatched.find((d) => d.cmd === 'acp_send_prompt')
    expect(sendCall).toBeDefined()
    expect((sendCall!.args as { content: ContentBlock[] }).content).toEqual(wire)
  })

  it('sendPromptBlocks echo does not overwrite the display blocks (dedup by turn:<id>)', async () => {
    // The server `user_prompt` echo carries the wire blocks; the optimistic
    // message keeps the display blocks because `_onUserPrompt` dedups by
    // `turn:<id>` (id-keyed, not block-exact).
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    const wire = [{ type: 'text', text: 'wire-framed' }]
    const display = [{ type: 'text', text: '\uE000git-worktree\uE001 hi' }]
    void useAcpStore.getState().sendPromptBlocks('s1', wire, { displayBlocks: display })
    await Promise.resolve()
    const msgs = useAcpStore.getState().messages['s1']
    expect(msgs[0].blocks).toEqual(display)
    const turnId = msgs[0].id.slice('turn:'.length)
    // Server echoes the wire blocks for the same turn id — must NOT overwrite the
    // display blocks (dedup by id keeps the optimistic display).
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's1',
      turnId,
      content: wire
    })
    const after = useAcpStore.getState().messages['s1']
    expect(after).toHaveLength(1)
    expect(after[0].blocks).toEqual(display)
  })

  it('skipUserAppend re-stamps the placeholder user message id so a display!=wire echo does not double-bubble', async () => {
    // Regression for the launch-with-skills duplicate-text bug. The launch
    // placeholder mints an optimistic user message with `msg-<uuid>` id and
    // DISPLAY (token) blocks; finalizeChatLaunch then runs runPromptTurn with
    // `skipUserAppend: true` and WIRE (path-framed) blocks. The reused message
    // must be re-stamped to `turn:<turnId>` so the server `user_prompt` echo
    // (same turnId, wire blocks) dedups by id — otherwise BOTH dedup checks
    // fail (id mismatch + display!=wire block mismatch) and the echo appends a
    // second user bubble. Covers the path the sendPromptBlocks tests above do
    // NOT exercise (those mint the optimistic message with `turn:<id>` here).
    seedSession('s1', 'agent-1', false)
    const display = [{ type: 'text', text: '\uE000git-worktree\uE001 hi' }]
    const wire = [
      {
        type: 'text',
        text: '# Agent Skills\n\ngit-worktree: /p/SKILL.md\n\n---\n\n(git-worktree) hi'
      }
    ]
    // Simulate createLaunchPlaceholder's optimistic user message: msg-<uuid>
    // id + display (token) blocks.
    useAcpStore.setState({
      messages: {
        s1: [
          {
            id: 'msg-placeholder-1',
            role: 'user',
            blocks: display,
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ]
      }
    })
    // Never resolve so the turn stays active for the echo assertion.
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    void useAcpStore.getState().sendPromptBlocks('s1', wire, { skipUserAppend: true })
    await Promise.resolve()

    const seeded = useAcpStore.getState().messages['s1']
    expect(seeded).toHaveLength(1)
    // The placeholder id was re-stamped to `turn:<turnId>` (no new bubble).
    expect(seeded[0].id.startsWith('turn:')).toBe(true)
    expect(seeded[0].id).not.toBe('msg-placeholder-1')
    // The display (token) blocks are preserved — the agent receives the wire.
    expect(seeded[0].blocks).toEqual(display)
    const turnId = seeded[0].id.slice('turn:'.length)

    // Server echoes the WIRE blocks for the same turn id. Must dedup by id
    // (not append a second user bubble) and must NOT overwrite the display.
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's1',
      turnId,
      content: wire
    })
    const finalMessages = useAcpStore.getState().messages['s1']
    expect(finalMessages).toHaveLength(1)
    expect(finalMessages[0].id).toBe(`turn:${turnId}`)
    expect(finalMessages[0].blocks).toEqual(display)
  })

  it('sendPrompt updates the persisted history title from the first user message', async () => {
    seedSession('s1', 'agent-09d39730', false)
    useAcpStore.setState({
      sessionIndex: [
        {
          id: 's1',
          agentId: 'agent-09d39730',
          title: 'Agent 09d39730',
          cwd: '/work',
          projectId: 'p1',
          createdAt: 1,
          lastActivityAt: 1,
          messageCount: 0,
          status: 'active'
        }
      ]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))

    void useAcpStore.getState().sendPrompt('s1', 'siapa itu faiz intifada?')
    await Promise.resolve()

    const [entry] = useAcpStore.getState().sessionIndex
    expect(entry.title).toBe('siapa itu faiz intifada?')
    expect(entry.messageCount).toBe(1)
    // CAP-2: durable writes are host-owned; the renderer only updates its
    // local index projection and must not queue a payload save.
    const { queueSessionPayloadSave } = await import('@/lib/acp-history-persistence')
    expect(queueSessionPayloadSave).not.toHaveBeenCalled()
  })

  it('enqueues a second prompt while a turn is active', async () => {
    seedSession('s1', 'agent-1') // active by default
    await useAcpStore.getState().sendPrompt('s1', 'follow up')
    const queue = useAcpStore.getState().promptQueues['s1']
    expect(queue).toHaveLength(1)
    expect(queue[0].blocks).toEqual([{ type: 'text', text: 'follow up' }])
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
  })

  it('enqueues when activeTurn is set without openTurnId', async () => {
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState((s) => ({
      sessions: {
        s1: { ...s.sessions.s1, activeTurn: true, openTurnId: null }
      }
    }))
    await useAcpStore.getState().sendPrompt('s1', 'follow up')
    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
  })

  it('queues a prompt when the backend rejects a concurrent turn', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ACP_TURN_IN_PROGRESS: session s1')
    )
    await useAcpStore.getState().sendPrompt('s1', 'queued after race')
    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(1)
    expect(useAcpStore.getState().promptQueues['s1'][0].blocks).toEqual([
      { type: 'text', text: 'queued after race' }
    ])
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
    expect(useAcpStore.getState().sessions['s1'].lastError).toBeNull()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('queues a prompt when the WS transport rejects a concurrent turn (rate_limited)', async () => {
    // Web/remote path: the relay returns `err.code: rate_limited` with
    // message "a prompt turn is already in progress" (the only RateLimited
    // emit site is the send_prompt DuplicateInFlight/Busy branch), surfaced as
    // `AcpTransportError`. The store must recover it to the queue instead of
    // finalizing the turn — mirrors the IPC `ACP_TURN_IN_PROGRESS` case above.
    seedSession('s1', 'agent-1', false)
    _setAcpTransportForTests({
      sendPrompt: vi
        .fn()
        .mockRejectedValue(
          new AcpTransportError('rate_limited', 'a prompt turn is already in progress')
        ),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    await useAcpStore.getState().sendPrompt('s1', 'queued after race')
    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(1)
    expect(useAcpStore.getState().promptQueues['s1'][0].blocks).toEqual([
      { type: 'text', text: 'queued after race' }
    ])
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
    expect(useAcpStore.getState().sessions['s1'].lastError).toBeNull()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('flushes the next queued prompt when the turn ends', async () => {
    seedSession('s1', 'agent-1', true)
    await useAcpStore.getState().sendPrompt('s1', 'queued one')
    await useAcpStore.getState().sendPrompt('s1', 'queued two')
    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(2)

    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn'
    })
    await flushTurnEnd()
    await Promise.resolve()

    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s1']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s1'][0].blocks).toEqual([
      { type: 'text', text: 'queued one' }
    ])
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(true)
  })

  it('preserves FIFO order when a flushed prompt hits ACP_TURN_IN_PROGRESS', async () => {
    seedSession('s1', 'agent-1', true)
    await useAcpStore.getState().sendPrompt('s1', 'queued A')
    await useAcpStore.getState().sendPrompt('s1', 'queued B')
    const before = useAcpStore.getState().promptQueues['s1']
    expect(before).toHaveLength(2)
    const idA = before[0].id
    const idB = before[1].id

    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ACP_TURN_IN_PROGRESS: session s1')
    )
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn'
    })
    await flushTurnEnd()
    // Allow the flush's runPromptTurn rejection path to settle.
    await Promise.resolve()
    await Promise.resolve()

    const after = useAcpStore.getState().promptQueues['s1']
    expect(after.map((q) => q.id)).toEqual([idA, idB])
    expect(after[0].blocks).toEqual([{ type: 'text', text: 'queued A' }])
    expect(after[1].blocks).toEqual([{ type: 'text', text: 'queued B' }])
  })

  it('ignores duplicate turn-end signals so a flushed queued turn keeps running', async () => {
    seedSession('s1', 'agent-1', true)
    await useAcpStore.getState().sendPrompt('s1', 'queued next')
    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(1)

    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))

    // Mirrors dispatch resolve + acp:prompt_complete scheduling end twice.
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn'
    })
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn'
    })
    await flushTurnEnd()
    await flushTurnEnd()

    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(true)
    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(0)
    expect(useAcpStore.getState().messages['s1']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s1'][0].blocks).toEqual([
      { type: 'text', text: 'queued next' }
    ])
  })

  it('sendQueuedPromptNow cancels an active turn and sends the queued message', async () => {
    seedSession('s1', 'agent-1', true)
    await useAcpStore.getState().sendPrompt('s1', 'queued now')
    const queueId = useAcpStore.getState().promptQueues['s1'][0].id

    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_cancel_prompt') {
        useAcpStore.getState()._onPromptComplete({
          agentId: 'agent-1',
          sessionId: 's1',
          stopReason: 'cancelled'
        })
        return undefined
      }
      if (cmd === 'acp_send_prompt') return 'end_turn'
      return undefined
    })

    await useAcpStore.getState().sendQueuedPromptNow('s1', queueId)
    await flushTurnEnd()

    expect(invoke).toHaveBeenCalledWith('acp_cancel_prompt', {
      agentId: 'agent-1',
      sessionId: 's1'
    })
    expect(useAcpStore.getState().promptQueues['s1'] ?? []).toHaveLength(0)
    expect(useAcpStore.getState().messages['s1']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s1'][0].blocks).toEqual([
      { type: 'text', text: 'queued now' }
    ])
  })

  it('sendQueuedPromptNow cancels when activeTurn is set without openTurnId', async () => {
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState((s) => ({
      sessions: {
        s1: { ...s.sessions.s1, activeTurn: true, openTurnId: null }
      },
      promptQueues: {
        s1: [
          {
            id: 'q-now',
            blocks: [{ type: 'text', text: 'send now activeTurn-only' }],
            createdAt: Date.now()
          }
        ]
      }
    }))

    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_cancel_prompt') {
        useAcpStore.getState()._onPromptComplete({
          agentId: 'agent-1',
          sessionId: 's1',
          stopReason: 'cancelled'
        })
        return undefined
      }
      if (cmd === 'acp_send_prompt') return 'end_turn'
      return undefined
    })

    await useAcpStore.getState().sendQueuedPromptNow('s1', 'q-now')
    await flushTurnEnd()

    expect(invoke).toHaveBeenCalledWith('acp_cancel_prompt', {
      agentId: 'agent-1',
      sessionId: 's1'
    })
    expect(useAcpStore.getState().promptQueues['s1'] ?? []).toHaveLength(0)
    expect(useAcpStore.getState().messages['s1']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s1'][0].blocks).toEqual([
      { type: 'text', text: 'send now activeTurn-only' }
    ])
  })

  it('prompt_complete clears activeTurn-only sessions and flushes the queue', async () => {
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState((s) => ({
      sessions: {
        s1: { ...s.sessions.s1, activeTurn: true, openTurnId: null }
      },
      promptQueues: {
        s1: [
          {
            id: 'q-flush',
            blocks: [{ type: 'text', text: 'after activeTurn-only' }],
            createdAt: Date.now()
          }
        ]
      }
    }))

    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn'
    })
    await flushTurnEnd()
    await Promise.resolve()

    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(true)
    expect(useAcpStore.getState().sessions['s1'].openTurnId).not.toBeNull()
    expect(useAcpStore.getState().promptQueues['s1'] ?? []).toHaveLength(0)
    expect(useAcpStore.getState().messages['s1']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s1'][0].blocks).toEqual([
      { type: 'text', text: 'after activeTurn-only' }
    ])
  })

  it('coalesces agent message_chunk events into one streaming message', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'Hello ' }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'world' }
    })
    _flushCoalescedForTesting()
    const msgs = useAcpStore.getState().messages['s1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('agent')
    expect(msgs[0].streaming).toBe(true)
    expect(msgs[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world' })
  })

  it('does not merge chunks of different roles', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'thought',
      content: { type: 'text', text: 'thinking' }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'answer' }
    })
    _flushCoalescedForTesting()
    const msgs = useAcpStore.getState().messages['s1']
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('thought')
    expect(msgs[1].role).toBe('agent')
  })

  it('prompt_complete clears the active turn and finalizes the streaming message', async () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'done' }
    })
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: { ...s.sessions['s1'], activeTurn: true, openTurnId: 'turn' }
      }
    }))
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn' })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
    expect(useAcpStore.getState().messages['s1'][0].streaming).toBe(false)
  })

  it('refusal stop reason surfaces an error note', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'refusal'
    })
    expect(useAcpStore.getState().sessions['s1'].lastError).toMatch(/refused/i)
  })

  it('prompt_complete keeps the transcript in the store projection (durable write is host-owned)', async () => {
    // CAP-2: the host event layer persists agent replies; the renderer only
    // keeps its local projection consistent and must not queue a payload save.
    seedSession('s1', 'agent-1')
    useAcpStore.setState({
      sessionIndex: [
        {
          id: 's1',
          agentId: 'agent-1',
          title: 'T',
          cwd: '/work',
          projectId: 'p1',
          createdAt: 0,
          lastActivityAt: 0,
          messageCount: 1,
          status: 'active'
        }
      ]
    })
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'the answer' }
    })
    const { queueSessionPayloadSave } = await import('@/lib/acp-history-persistence')
    ;(queueSessionPayloadSave as ReturnType<typeof vi.fn>).mockClear()
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn'
    })
    await flushTurnEnd()
    // The agent reply stays in the local transcript projection…
    const stored = useAcpStore.getState().messages['s1']
    expect(stored.some((m) => m.role === 'agent' && !m.streaming)).toBe(true)
    // …and no renderer-side durable write is queued (host authors history).
    expect(queueSessionPayloadSave).not.toHaveBeenCalled()
  })

  it('prompt_complete does not resurrect a chat deleted while the turn was in flight', async () => {
    // deleteHistorySession removed the index entry mid-turn; the turn-end
    // persist must not write it back.
    seedSession('s1', 'agent-1')
    // No sessionIndex entry for s1 (deleted).
    const { queueSessionPayloadSave, saveSessionIndex } = await import(
      '@/lib/acp-history-persistence'
    )
    ;(queueSessionPayloadSave as ReturnType<typeof vi.fn>).mockClear()
    ;(saveSessionIndex as ReturnType<typeof vi.fn>).mockClear()
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn'
    })
    await flushTurnEnd()
    expect(queueSessionPayloadSave).not.toHaveBeenCalled()
    expect(useAcpStore.getState().sessionIndex).toEqual([])
  })

  it('agent_disconnected marks the agent error and closes its sessions', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-1' })
    expect(useAcpStore.getState().agentStatus['agent-1']).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].status).toBe('closed')
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('agent_disconnected preserves a content session transcript instead of blanking', () => {
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState({
      messages: {
        s1: [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'hi' }],
            streaming: false,
            timestamp: 0,
            seq: 0
          }
        ]
      }
    })
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-1' })
    const state = useAcpStore.getState()
    // The session record survives (not deleted) and its transcript is kept in
    // memory so the pane shows history + "disconnected" — not a blank chat.
    expect(state.sessions['s1']).toBeTruthy()
    expect(state.sessions['s1'].status).toBe('closed')
    expect(state.messages['s1']).toHaveLength(1)
  })

  it('sendPrompt agent-dead rejection does not surface the cryptic IPC string', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('agent thread dropped the reply')
    )
    await expect(useAcpStore.getState().sendPrompt('s1', 'retry me')).rejects.toThrow()
    const session = useAcpStore.getState().sessions['s1']
    expect(session.activeTurn).toBe(false)
    // The low-level IPC string must NOT become the visible lastError — the
    // crash/disconnect events drive the Error state instead. (Without the
    // agent-dead guard, the catch would set lastError to this string.)
    expect(String(session.lastError)).not.toContain('agent thread dropped the reply')
  })

  it('retryCrashedSession rejects for an unknown session', async () => {
    await expect(useAcpStore.getState().retryCrashedSession('nope')).rejects.toThrow(
      'unknown session'
    )
  })

  it('session_closed marks only that session closed', () => {
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
    useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId: 's1' })
    expect(useAcpStore.getState().sessions['s1'].status).toBe('closed')
    expect(useAcpStore.getState().sessions['s2'].status).toBe('active')
  })

  it('permission_request is stored and respondPermission clears it', async () => {
    seedSession('s1', 'agent-1')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    useAcpStore.getState()._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'allow', name: 'Allow' }]
    })
    expect(useAcpStore.getState().pendingPermissions['req-1']).toBeTruthy()
    await useAcpStore.getState().respondPermission('req-1', 'allow')
    expect(useAcpStore.getState().pendingPermissions['req-1']).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('acp_respond_permission', {
      agentId: 'agent-1',
      requestId: 'req-1',
      optionId: 'allow'
    })
  })

  it('prompt_complete clears a pending permission for the session (C1)', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'allow', name: 'Allow' }]
    })
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'cancelled'
    })
    expect(useAcpStore.getState().pendingPermissions['req-1']).toBeUndefined()
  })

  it('session_closed and agent_disconnected drop pending permissions (W2)', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: []
    })
    store._onSessionClosed({ agentId: 'agent-1', sessionId: 's1' })
    expect(useAcpStore.getState().pendingPermissions['req-1']).toBeUndefined()

    store._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-2',
      toolCall: { toolCallId: 'tc-2' },
      options: []
    })
    store._onAgentDisconnected({ agentId: 'agent-1' })
    expect(useAcpStore.getState().pendingPermissions['req-2']).toBeUndefined()
  })

  it('question_request is stored and answerQuestion clears it exactly once (issue #411)', async () => {
    seedSession('s1', 'agent-1')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    useAcpStore.getState()._onQuestionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      questionId: 'q-1',
      question: 'Which approach?',
      options: [
        { value: 'plan-a', label: 'Plan A', description: 'Fast' },
        { value: 'plan-b', label: 'Plan B' }
      ]
    })
    expect(useAcpStore.getState().pendingQuestions['q-1']).toBeTruthy()
    await useAcpStore.getState().answerQuestion('q-1', ['plan-a'])
    expect(useAcpStore.getState().pendingQuestions['q-1']).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('acp_answer_question', {
      agentId: 'agent-1',
      questionId: 'q-1',
      values: ['plan-a']
    })
  })

  it('duplicate question_id keeps the first entry (issue #411)', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onQuestionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      questionId: 'q-1',
      question: 'First',
      options: []
    })
    useAcpStore.getState()._onQuestionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      questionId: 'q-1',
      question: 'Second (duplicate)',
      options: []
    })
    expect(useAcpStore.getState().pendingQuestions['q-1'].question).toBe('First')
  })

  it('prompt_complete and session/agent teardown drop pending questions (issue #411)', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    const seed = (id: string) =>
      store._onQuestionRequest({
        agentId: 'agent-1',
        sessionId: 's1',
        questionId: id,
        question: 'Q',
        options: []
      })
    seed('q-1')
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'cancelled' })
    expect(useAcpStore.getState().pendingQuestions['q-1']).toBeUndefined()

    seed('q-2')
    store._onSessionClosed({ agentId: 'agent-1', sessionId: 's1' })
    expect(useAcpStore.getState().pendingQuestions['q-2']).toBeUndefined()

    seed('q-3')
    store._onAgentDisconnected({ agentId: 'agent-1' })
    expect(useAcpStore.getState().pendingQuestions['q-3']).toBeUndefined()
  })

  it('answerQuestion is re-entrancy safe: second call is a no-op (issue #411)', async () => {
    seedSession('s1', 'agent-1')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    useAcpStore.getState()._onQuestionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      questionId: 'q-1',
      question: 'Q',
      options: [{ value: 'a', label: 'A' }]
    })
    const first = useAcpStore.getState().answerQuestion('q-1', ['a'])
    const second = useAcpStore.getState().answerQuestion('q-1', ['a'])
    await Promise.all([first, second])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('_onToolCall upserts by toolCallId so duplicates produce one entry', async () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onToolCall({
      agentId: 'agent-1',
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-1', title: 'read', status: 'pending' }
    })
    _flushCoalescedForTesting()
    // Capture the original timeline placement (arrival-stamped seq + timestamp).
    const original = useAcpStore.getState().toolCalls['s1'][0]
    const originalSeq = original.seq
    const originalTimestamp = original.timestamp
    expect(typeof originalSeq).toBe('number')
    // Let the clock advance so a non-preserving merge would stamp a different timestamp.
    await new Promise((r) => setTimeout(r, 3))
    store._onToolCall({
      agentId: 'agent-1',
      sessionId: 's1',
      toolCall: {
        toolCallId: 'tc-1',
        title: 'write',
        status: 'completed',
        content: [{ type: 'text', text: 'done' }]
      }
    })
    _flushCoalescedForTesting()
    const list = useAcpStore.getState().toolCalls['s1']
    expect(list).toHaveLength(1)
    expect(list[0].toolCallId).toBe('tc-1')
    // Latest call fields win (upsert, latest wins).
    expect(list[0].title).toBe('write')
    expect(list[0].status).toBe('completed')
    expect(list[0].content).toEqual([{ type: 'text', text: 'done' }])
    // Replayed entry keeps its original timeline placement (seq + timestamp),
    // not the replay's fresh stamps — the card must not jump to a later position.
    expect(list[0].seq).toBe(originalSeq)
    expect(list[0].timestamp).toBe(originalTimestamp)
  })

  it('_onSessionInfoUpdate sets the session title from the agent-provided title', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onSessionInfoUpdate({
      agentId: 'agent-1',
      sessionId: 's1',
      title: 'Implement auth'
    })
    expect(useAcpStore.getState().sessions['s1'].title).toBe('Implement auth')
  })

  it('_onSessionInfoUpdate reverts title to null when agent clears it', () => {
    seedSession('s1', 'agent-1')
    // Set a title first
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s1: { ...s.sessions['s1'], title: 'Old title' } }
    }))
    useAcpStore.getState()._onSessionInfoUpdate({
      agentId: 'agent-1',
      sessionId: 's1',
      title: null
    })
    expect(useAcpStore.getState().sessions['s1'].title).toBeNull()
  })

  it('_onSessionInfoUpdate is a no-op for unknown sessions', () => {
    useAcpStore.setState(FRESH)
    useAcpStore.getState()._onSessionInfoUpdate({
      agentId: 'agent-1',
      sessionId: 'unknown',
      title: 'Whatever'
    })
    expect(useAcpStore.getState().sessions['unknown']).toBeUndefined()
  })

  it('_onSessionInfoUpdate leaves the title untouched when the field is omitted', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s1: { ...s.sessions['s1'], title: 'Keep me' } }
    }))
    // title field absent => undefined => no change (must not clear to null)
    useAcpStore.getState()._onSessionInfoUpdate({
      agentId: 'agent-1',
      sessionId: 's1'
    })
    expect(useAcpStore.getState().sessions['s1'].title).toBe('Keep me')
  })

  it('_onUsageUpdate stores agent-reported context window usage', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onUsageUpdate({
      agentId: 'agent-1',
      sessionId: 's1',
      used: 53_000,
      size: 200_000,
      cost: { amount: 0.045, currency: 'USD' }
    })
    const usage = useAcpStore.getState().sessionUsage['s1']
    expect(usage?.used).toBe(53_000)
    expect(usage?.size).toBe(200_000)
    expect(usage?.baselineUsed).toBe(53_000)
    expect(usage?.cost).toEqual({ amount: 0.045, currency: 'USD' })
    expect(usage?.source).toBe('reported')
  })

  it('_onUsageUpdate ignores zero cost placeholders', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onUsageUpdate({
      agentId: 'agent-1',
      sessionId: 's1',
      used: 22_961,
      size: 200_000,
      cost: { amount: 0, currency: 'USD' }
    })
    expect(useAcpStore.getState().sessionUsage['s1']?.cost).toBeUndefined()
    expect(useAcpStore.getState().sessionUsage['s1']?.baselineUsed).toBe(22_961)
  })

  it('_onUsageUpdate ignores invalid or unknown sessions', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onUsageUpdate({
      agentId: 'agent-1',
      sessionId: 'missing',
      used: 1,
      size: 100
    })
    useAcpStore.getState()._onUsageUpdate({
      agentId: 'agent-1',
      sessionId: 's1',
      used: 0,
      size: 100
    })
    expect(useAcpStore.getState().sessionUsage['s1']).toBeUndefined()
    expect(useAcpStore.getState().sessionUsage['missing']).toBeUndefined()
  })

  it('respondPermission is re-entrancy safe (W3): second call is a no-op', async () => {
    seedSession('s1', 'agent-1')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    useAcpStore.getState()._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'allow', name: 'Allow' }]
    })
    const first = useAcpStore.getState().respondPermission('req-1', 'allow')
    const second = useAcpStore.getState().respondPermission('req-1', 'allow')
    await Promise.all([first, second])
    // only one backend call despite two invocations
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('sendPrompt failure clears the turn and records the error', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue('backend boom')
    await expect(useAcpStore.getState().sendPrompt('s1', 'x')).rejects.toBeDefined()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
    expect(useAcpStore.getState().sessions['s1'].lastError).toMatch(/boom/)
  })

  it('sendPrompt clears the turn on command resolution even with no prompt_complete event', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    await useAcpStore.getState().sendPrompt('s1', 'hello')
    // no _onPromptComplete fired; the deferred safety-net must clear the turn
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('sendPrompt surfaces a max_tokens stop reason as an error note', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('max_tokens')
    await useAcpStore.getState().sendPrompt('s1', 'hello')
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s1'].lastError).toMatch(/token limit/i)
  })

  it('does not drop streamed chunks when the command reply wins the race', async () => {
    // Reproduces the Cursor blank-reply bug: the `acp_send_prompt` reply
    // resolves and finalizes BEFORE the streamed chunk events are processed.
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    const store = useAcpStore.getState()
    // Send the prompt (marks the turn active) but do not yet await completion.
    const done = store.sendPrompt('s1', 'hi')
    await Promise.resolve()
    // Chunks stream in while the turn is active (as real events would).
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'Hi' }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: ' there' }
    })
    // Flush the coalesced chunks synchronously so scheduleTurnEnd's
    // finalizeStreaming sees them (rAF fires async in jsdom).
    _flushCoalescedForTesting()
    await done
    await flushTurnEnd()
    const msgs = useAcpStore.getState().messages['s1']
    // user message + the streamed agent message (not dropped)
    const agentMsg = msgs.find((m) => m.role === 'agent')
    expect(agentMsg).toBeDefined()
    expect(agentMsg?.blocks[0]).toEqual({ type: 'text', text: 'Hi there' })
    expect(agentMsg?.streaming).toBe(false)
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('_onPromptComplete finalizes the turn before the deferred command reply runs', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    const store = useAcpStore.getState()
    const done = store.sendPrompt('s1', 'hi')
    await Promise.resolve()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'done' }
    })
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn' })
    expect(useAcpStore.getState().sessions['s1'].openTurnId).not.toBeNull()
    await done
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
    const agentMsg = useAcpStore.getState().messages['s1'].find((m) => m.role === 'agent')
    expect(agentMsg?.blocks[0]).toEqual({ type: 'text', text: 'done' })
    expect(agentMsg?.streaming).toBe(false)
  })

  it('coalesces chunks that arrive after the turn is finalized', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    const store = useAcpStore.getState()
    const done = store.sendPrompt('s1', 'hi')
    await Promise.resolve()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'Hello' }
    })
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn' })
    await flushTurnEnd()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: ' world' }
    })
    await done
    _flushCoalescedForTesting()
    const agentMsg = useAcpStore.getState().messages['s1'].find((m) => m.role === 'agent')
    expect(agentMsg?.blocks[0]).toEqual({ type: 'text', text: 'Hello world' })
  })

  it('does not drop chunks when prompt_complete is processed before them', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    const store = useAcpStore.getState()
    const done = store.sendPrompt('s1', 'hi')
    await Promise.resolve()
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn' })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'Hi' }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: ' there' }
    })
    await done
    await flushTurnEnd()
    _flushCoalescedForTesting()
    const agentMsg = useAcpStore.getState().messages['s1'].find((m) => m.role === 'agent')
    expect(agentMsg?.blocks[0]).toEqual({ type: 'text', text: 'Hi there' })
  })

  it('rejects sendPrompt on a closed session', async () => {
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s1: { ...s.sessions['s1'], status: 'closed' } }
    }))
    await expect(useAcpStore.getState().sendPrompt('s1', 'x')).rejects.toThrow(/closed/)
  })

  it('cancelPrompt is a no-op when no turn is active', async () => {
    seedSession('s1', 'agent-1', false)
    await useAcpStore.getState().cancelPrompt('s1')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('drops message_chunk for unknown session', () => {
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 'ghost',
      role: 'agent',
      content: { type: 'text', text: 'x' }
    })
    expect(useAcpStore.getState().messages['ghost']).toBeUndefined()
  })

  it('drops message_chunk for a closed session', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s1: { ...s.sessions['s1'], status: 'closed' } }
    }))
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'late' }
    })
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
  })

  it('does not resurrect a finalized turn with a late chunk (no active turn)', () => {
    seedSession('s1', 'agent-1', false)
    // session active:false => a chunk must not start a new message
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'late' }
    })
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
  })

  it('ignores an empty leading text chunk', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: { ...s.sessions['s1'], activeTurn: true, openTurnId: 'turn' }
      }
    }))
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: '' }
    })
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
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
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('acp_new_session', {
      agentId: 'agent-9',
      cwd: '/work',
      mcpServers: [],
      projectId: 'p1'
    })
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

  it('openHistorySession loads the local transcript when no agent is connected (P5)', async () => {
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-old',
        agentId: 'agent-x',
        title: 'Old chat',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('s-old')
    // no agent connected -> 'local' strategy: transcript is shown, no IPC call
    expect(invoke).not.toHaveBeenCalled()
    expect(useAcpStore.getState().messages['s-old']).toHaveLength(1)
    expect(useAcpStore.getState().sessions['s-old'].status).toBe('closed')
    // Legacy payloads carry no toolCalls: degrade to an empty list, not a crash.
    expect(useAcpStore.getState().toolCalls['s-old']).toEqual([])
  })

  it('openHistorySession restores persisted tool calls alongside the transcript', async () => {
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-tools',
        agentId: 'agent-x',
        title: 'Tool chat',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'do it' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        }
      ],
      toolCalls: [
        {
          toolCallId: 'tc-1',
          title: 'Read file',
          kind: 'read',
          status: 'completed',
          timestamp: 10,
          seq: 2,
          rawInput: { path: '/a.ts' }
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('s-tools')
    // 'local' strategy: the mirrored tool calls are restored for the timeline.
    expect(useAcpStore.getState().toolCalls['s-tools']).toEqual([
      expect.objectContaining({ toolCallId: 'tc-1', kind: 'read', seq: 2 })
    ])
  })

  it('openHistorySession degrades a corrupt toolCalls shape instead of throwing', async () => {
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-corrupt',
        agentId: 'agent-x',
        title: 'Corrupt chat',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        }
      ],
      toolCalls: 'not-an-array'
    })
    await expect(useAcpStore.getState().openHistorySession('s-corrupt')).resolves.toBeUndefined()
    expect(useAcpStore.getState().toolCalls['s-corrupt']).toEqual([])
    expect(useAcpStore.getState().messages['s-corrupt']).toHaveLength(1)
  })

  it('resumeLiveSession restores persisted tool calls with the transcript', async () => {
    setCachedSessionPayload('s-resume', {
      metadata: {
        id: 's-resume',
        agentId: 'agent-r',
        title: 'Resume chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'active'
      },
      messages: [
        {
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hi' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        }
      ],
      toolCalls: [{ toolCallId: 'tc-9', kind: 'read', status: 'completed', timestamp: 5, seq: 2 }]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({})
    await useAcpStore.getState().resumeLiveSession('s-resume', 'agent-r', '/w')
    expect(invoke).toHaveBeenCalledWith('acp_resume_session', {
      agentId: 'agent-r',
      sessionId: 's-resume',
      cwd: '/w'
    })
    expect(useAcpStore.getState().toolCalls['s-resume']).toEqual([
      expect.objectContaining({ toolCallId: 'tc-9', seq: 2 })
    ])
    expect(useAcpStore.getState().sessions['s-resume'].status).toBe('active')
    // The seq rebase must fold in tool-call seqs (the messages carried only
    // seq 1): the next live event must sort AFTER the restored tool card, or
    // buildTimeline would render fresh content ahead of older history.
    useAcpStore.getState()._onToolCall({
      agentId: 'agent-r',
      sessionId: 's-resume',
      toolCall: { toolCallId: 'tc-live', kind: 'read', status: 'pending' }
    })
    _flushCoalescedForTesting()
    const restored = useAcpStore.getState().toolCalls['s-resume']
    const liveCall = restored.find((t) => t.toolCallId === 'tc-live')!
    expect(liveCall.seq!).toBeGreaterThan(2)
  })

  it('resumeLiveSession keeps the restored transcript and tool calls when resume fails', async () => {
    setCachedSessionPayload('s-resume-fail', {
      metadata: {
        id: 's-resume-fail',
        agentId: 'agent-r',
        title: 'Resume chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'active'
      },
      messages: [
        {
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hi' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        }
      ],
      toolCalls: [{ toolCallId: 'tc-f', kind: 'edit', status: 'completed', timestamp: 5, seq: 2 }]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('agent gone'))
    await expect(
      useAcpStore.getState().resumeLiveSession('s-resume-fail', 'agent-r', '/w')
    ).rejects.toBeDefined()
    expect(useAcpStore.getState().messages['s-resume-fail']).toHaveLength(1)
    expect(useAcpStore.getState().toolCalls['s-resume-fail']).toEqual([
      expect.objectContaining({ toolCallId: 'tc-f', seq: 2 })
    ])
  })

  it('openHistorySession keeps the restore preload visible for a perceptible minimum', async () => {
    vi.useFakeTimers()
    try {
      const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
      ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        metadata: {
          id: 's-preload',
          agentId: 'agent-x',
          title: 'Quick chat',
          cwd: '/w',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 1,
          status: 'closed'
        },
        messages: [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'ready' }],
            streaming: false,
            timestamp: 0
          }
        ]
      })

      const opening = useAcpStore.getState().openHistorySession('s-preload')
      expect(useAcpStore.getState().restoringChatIds['s-preload']).toBe(true)
      await opening
      expect(useAcpStore.getState().messages['s-preload']).toHaveLength(1)
      expect(useAcpStore.getState().restoringChatIds['s-preload']).toBe(true)

      await vi.advanceTimersByTimeAsync(399)
      expect(useAcpStore.getState().restoringChatIds['s-preload']).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(useAcpStore.getState().restoringChatIds['s-preload']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('openHistorySession leaves a live session untouched (P5)', async () => {
    // The session is already running in a pane with messages in memory; reopening
    // it from history must not reload or wipe the live transcript.
    seedSession('s-live', 'agent-1', true)
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      messages: {
        ...s.messages,
        's-live': [
          {
            id: 'live-1',
            role: 'agent',
            blocks: [{ type: 'text', text: 'streaming' }],
            streaming: false,
            timestamp: 0
          }
        ]
      }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    await useAcpStore.getState().openHistorySession('s-live')
    // Fast path: no disk read, no reload IPC; live transcript preserved.
    expect(loadSessionPayload).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(useAcpStore.getState().messages['s-live']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s-live'][0].id).toBe('live-1')
  })

  it('openHistorySession still reloads when session is cached but closed (P5)', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessions: {
        's-closed': {
          id: 's-closed',
          agentId: 'agent-1',
          cwd: '/w',
          projectId: 'p1',
          status: 'closed',
          title: 'Was open',
          activeTurn: false,
          openTurnId: null,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: 1
        }
      },
      messages: { 's-closed': [] }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-closed',
        agentId: 'agent-1',
        title: 'Was open',
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
          blocks: [{ type: 'text', text: 'from disk' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await useAcpStore.getState().openHistorySession('s-closed')
    expect(loadSessionPayload).toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('acp_load_session', {
      agentId: 'agent-1',
      sessionId: 's-closed',
      cwd: '/w'
    })
    // The local transcript stays visible while (and after) the load: an agent
    // that replays nothing must not blank the chat. A real replay replaces it
    // (covered by the replay tests below).
    expect(useAcpStore.getState().messages['s-closed']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s-closed'][0].id).toBe('m1')
    expect(useAcpStore.getState().sessions['s-closed'].status).toBe('active')
  })

  it('openHistorySession preserves cached controls when reopen omits fields and clears explicit configOptions', async () => {
    const cachedModes = {
      currentModeId: 'cached-mode',
      availableModes: [{ id: 'cached-mode', name: 'Cached Mode' }]
    }
    const cachedModels = {
      currentModelId: 'cached-model',
      availableModels: [{ modelId: 'cached-model', name: 'Cached Model' }]
    }
    const cachedConfig = [
      {
        id: 'thinking',
        name: 'Thinking',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }]
      }
    ]
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessions: {
        ...s.sessions,
        's-preserve': {
          id: 's-preserve',
          agentId: 'agent-1',
          cwd: '/w',
          projectId: 'p1',
          status: 'closed',
          title: 'Cached controls',
          activeTurn: false,
          openTurnId: null,
          modes: cachedModes,
          models: cachedModels,
          configOptions: cachedConfig,
          lastError: null,
          createdAt: 1
        }
      }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-preserve',
        agentId: 'agent-1',
        title: 'Cached controls',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 0,
        status: 'closed'
      },
      messages: []
    })
    vi.mocked(invoke).mockResolvedValueOnce({ configOptions: [] })

    await useAcpStore.getState().openHistorySession('s-preserve')

    const session = useAcpStore.getState().sessions['s-preserve']
    expect(session.modes).toBe(cachedModes)
    expect(session.models).toBe(cachedModels)
    expect(session.configOptions).toEqual([])
  })

  it('openHistorySession load keeps in-flight live mode/config updates authoritative', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-controls',
        agentId: 'agent-1',
        title: 'Controls',
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
          blocks: [{ type: 'text', text: 'from disk' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    const reopen = deferred<unknown>()
    vi.mocked(invoke).mockReturnValueOnce(reopen.promise)

    const opening = useAcpStore.getState().openHistorySession('s-controls')
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('acp_load_session', expect.anything())
    )
    useAcpStore.getState()._onModeUpdate({
      agentId: 'agent-1',
      sessionId: 's-controls',
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
      sessionId: 's-controls',
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

    const session = useAcpStore.getState().sessions['s-controls']
    expect(session.modes?.currentModeId).toBe('live')
    expect(session.models?.currentModelId).toBe('model-a')
    expect(session.configOptions).toEqual(liveConfig)
  })

  it('openHistorySession resumes when session is cached but closed (P5)', async () => {
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-1': {
          id: 'agent-1',
          capabilities: { loadSession: false, sessionCapabilities: { resume: {} } }
        }
      },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessions: {
        's-closed': {
          id: 's-closed',
          agentId: 'agent-1',
          cwd: '/w',
          projectId: 'p1',
          status: 'closed',
          title: 'Was open',
          activeTurn: false,
          openTurnId: null,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: 1
        }
      },
      messages: { 's-closed': [] }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-closed',
        agentId: 'agent-1',
        title: 'Was open',
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
          blocks: [{ type: 'text', text: 'from disk' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    const reopen = deferred<unknown>()
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValueOnce(reopen.promise)
    const opening = useAcpStore.getState().openHistorySession('s-closed')
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('acp_resume_session', expect.anything())
    )
    useAcpStore.getState()._onModeUpdate({
      agentId: 'agent-1',
      sessionId: 's-closed',
      currentModeId: 'live',
      availableModes: [{ id: 'live', name: 'Live' }]
    })
    useAcpStore.getState()._onConfigOptionsUpdate({
      agentId: 'agent-1',
      sessionId: 's-closed',
      configOptions: []
    })
    reopen.resolve({
      modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
      models: {
        currentModelId: 'model-resume',
        availableModels: [{ modelId: 'model-resume', name: 'Resume Model' }]
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
    expect(loadSessionPayload).toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('acp_resume_session', {
      agentId: 'agent-1',
      sessionId: 's-closed',
      cwd: '/w'
    })
    expect(useAcpStore.getState().messages['s-closed']).toHaveLength(1)
    expect(useAcpStore.getState().sessions['s-closed'].status).toBe('active')
    expect(useAcpStore.getState().sessions['s-closed'].modes?.currentModeId).toBe('live')
    expect(useAcpStore.getState().sessions['s-closed'].models?.currentModelId).toBe('model-resume')
    expect(useAcpStore.getState().sessions['s-closed'].configOptions).toEqual([])
  })

  it('openHistorySession sets replaying=streaming for resume strategy to accept gap-replay chunks', async () => {
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-1': {
          id: 'agent-1',
          capabilities: { loadSession: false, sessionCapabilities: { resume: {} } }
        }
      },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessions: {}
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-resume',
        agentId: 'agent-1',
        title: 'Resume',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 0,
        status: 'closed'
      },
      messages: []
    })
    const reopen = deferred<unknown>()
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValueOnce(reopen.promise)
    const opening = useAcpStore.getState().openHistorySession('s-resume')
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('acp_resume_session', expect.anything())
    )
    expect(useAcpStore.getState().sessions['s-resume'].replaying).toBe('streaming')
    reopen.resolve({})
    await opening
    expect(useAcpStore.getState().sessions['s-resume'].status).toBe('active')
    expect(useAcpStore.getState().sessions['s-resume'].lastError).toBeNull()
  })

  it('openHistorySession restores the local transcript if load fails (P5)', async () => {
    // A non-live session whose agent process is still connected with loadSession
    // -> 'load' strategy; if the reload fails the local transcript is restored.
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-load',
        agentId: 'agent-1',
        title: 'Reloadable',
        cwd: '/w',
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
    // The agent streams a PARTIAL replay (replacing the mirror), then the load
    // rejects — the restore path must bring the full local transcript back.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== 'acp_load_session') {
        throw new Error(`unexpected invoke command in load-failure test: ${cmd}`)
      }
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: 's-load',
        role: 'user',
        content: { type: 'text', text: 'partial replay' }
      })
      throw new Error('load boom')
    })
    await expect(useAcpStore.getState().openHistorySession('s-load')).rejects.toBeDefined()
    // transcript was restored (not the partial replay) and the error surfaced
    const messages = useAcpStore.getState().messages['s-load']
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe('m1')
    const session = useAcpStore.getState().sessions['s-load']
    expect(session.lastError).toMatch(/Resume failed/)
    expect(session.status).toBe('closed')
    expect(session.replaying).toBeNull()
    vi.mocked(invoke).mockReset()
  })

  it('openHistorySession does not activate a chat deleted during load', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessionIndex: [
        {
          id: 's-del-ok',
          agentId: 'agent-1',
          title: 'Doomed',
          cwd: '/w',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 1,
          status: 'closed'
        }
      ]
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-del-ok',
        agentId: 'agent-1',
        title: 'Doomed',
        cwd: '/w',
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
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== 'acp_load_session') {
        throw new Error(`unexpected invoke command: ${cmd}`)
      }
      await useAcpStore.getState().deleteHistorySession('s-del-ok')
    })
    await useAcpStore.getState().openHistorySession('s-del-ok')
    const session = useAcpStore.getState().sessions['s-del-ok']
    expect(session.status).toBe('closed')
    expect(session.replaying).toBeNull()
    expect(session.lastError).toBeNull()
    expect(useAcpStore.getState().sessionIndex.some((e) => e.id === 's-del-ok')).toBe(false)
    vi.mocked(invoke).mockReset()
  })

  it('openHistorySession does not restore or error a chat deleted during a failed load', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessionIndex: [
        {
          id: 's-del-fail',
          agentId: 'agent-1',
          title: 'Doomed',
          cwd: '/w',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 1,
          status: 'closed'
        }
      ]
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-del-fail',
        agentId: 'agent-1',
        title: 'Doomed',
        cwd: '/w',
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
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== 'acp_load_session') {
        throw new Error(`unexpected invoke command: ${cmd}`)
      }
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: 's-del-fail',
        role: 'user',
        content: { type: 'text', text: 'partial replay' }
      })
      await useAcpStore.getState().deleteHistorySession('s-del-fail')
      throw new Error('load boom')
    })
    // Must resolve (not reject) so callers do not toast after an intentional delete.
    await expect(useAcpStore.getState().openHistorySession('s-del-fail')).resolves.toBeUndefined()
    const session = useAcpStore.getState().sessions['s-del-fail']
    expect(session.status).toBe('closed')
    expect(session.lastError).toBeNull()
    expect(session.replaying).toBeNull()
    // Delete frees transcript maps; the failure path must not resurrect them
    // or leave a partial mid-load replay resident in the WebView heap.
    expect(useAcpStore.getState().messages['s-del-fail']).toBeUndefined()
    vi.mocked(invoke).mockReset()
  })

  it('openHistorySession reuses the current live agent when the persisted agentId is stale after restart', async () => {
    // After an app restart the persisted `agentId` is a dead per-process UUID,
    // but `agentConfigId`+cwd maps to a freshly spawned (prewarmed) live agent.
    useAcpStore.setState((s) => ({
      agentConfigs: [
        { id: 'cfg-1', name: 'Agent1', command: 'agent', args: [], env: {} },
        ...s.agentConfigs
      ],
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('cfg-1', '/w')]: 'fresh-agent'
      },
      agents: {
        ...s.agents,
        'fresh-agent': { id: 'fresh-agent', capabilities: { loadSession: true } }
      },
      agentStatus: { ...s.agentStatus, 'fresh-agent': 'connected' }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-reopen',
        agentId: 'stale-dead-uuid',
        agentConfigId: 'cfg-1',
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
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await useAcpStore.getState().openHistorySession('s-reopen')
    // load targets the FRESH live agent (not the stale persisted UUID) and the
    // session becomes active so the user can continue the conversation.
    expect(invoke).toHaveBeenCalledWith('acp_load_session', {
      agentId: 'fresh-agent',
      sessionId: 's-reopen',
      cwd: '/w'
    })
    expect(useAcpStore.getState().sessions['s-reopen'].agentId).toBe('fresh-agent')
    expect(useAcpStore.getState().sessions['s-reopen'].status).toBe('active')
  })

  it('reloads the configured agent before reopening a cold-start history tab', async () => {
    // The history index and agent-config hook mount independently. A restored
    // tab can open before the config hook finishes, but it should still resume
    // against the already-connected config+cwd agent instead of becoming local.
    useAcpStore.setState((s) => ({
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('cfg-restart', '/w')]: 'fresh-agent'
      },
      agents: {
        ...s.agents,
        'fresh-agent': { id: 'fresh-agent', capabilities: { loadSession: true } }
      },
      agentStatus: { ...s.agentStatus, 'fresh-agent': 'connected' }
    }))
    const { loadAgentConfigs } = await import('@/lib/acp-agents-persistence')
    vi.mocked(loadAgentConfigs).mockResolvedValueOnce([
      { id: 'cfg-restart', name: 'Restarted', command: 'agent', args: [], env: {} }
    ])
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-cold-start',
        agentId: 'stale-dead-uuid',
        agentConfigId: 'cfg-restart',
        title: 'Cold start',
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
    vi.mocked(invoke).mockResolvedValueOnce(undefined)

    await useAcpStore.getState().openHistorySession('s-cold-start')

    expect(invoke).toHaveBeenCalledWith('acp_load_session', {
      agentId: 'fresh-agent',
      sessionId: 's-cold-start',
      cwd: '/w'
    })
    expect(useAcpStore.getState().sessions['s-cold-start'].status).toBe('active')
  })

  it('spawnAgent populates capabilities + authMethods synchronously from the response', async () => {
    // CAP-4: the spawn response is the authoritative source of capabilities +
    // authMethods (not the async `acp:agent_spawned` event). `spawnAgent` must
    // set them synchronously from `result.capabilities` / `result.authMethods`
    // so `authenticateBeforeSession` and `openHistorySession` read them
    // immediately — no 250ms no-auth fallback.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_spawn_agent') {
        return {
          agentId: 'agent-caps',
          capabilities: { loadSession: true },
          authMethods: [{ id: 'cursor_login', name: 'Sign in with Cursor' }],
          stableNamespace: 'config:caps'
        }
      }
      throw new Error(`unexpected invoke command in spawn-capabilities test: ${cmd}`)
    })

    await useAcpStore.getState().spawnAgent({ name: 'Caps', command: 'caps', args: [], env: {} })

    expect(useAcpStore.getState().agents['agent-caps']?.capabilities).toEqual({
      loadSession: true
    })
    expect(useAcpStore.getState().agents['agent-caps']?.authMethods).toEqual([
      { id: 'cursor_login', name: 'Sign in with Cursor' }
    ])
    expect(useAcpStore.getState().agentStatus['agent-caps']).toBe('connected')
    vi.mocked(invoke).mockReset()
  })

  it('spawnAgent response wins over a null-capabilities seed (no event needed)', async () => {
    // Even if no `acp:agent_spawned` event fires, the spawn response alone
    // populates capabilities synchronously. This is the core CAP-4 invariant:
    // metadata delivery does not depend on the event.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_spawn_agent') {
        // `stableNamespace` is omitted — the Rust `SpawnOutcome` uses
        // `skip_serializing_if = "Option::is_none"`, so the wire never
        // carries `null`; the field is either a string or absent.
        return {
          agentId: 'agent-no-event',
          capabilities: { loadSession: true },
          authMethods: []
        }
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    await useAcpStore.getState().spawnAgent({ name: 'NE', command: 'ne', args: [], env: {} })

    expect(useAcpStore.getState().agents['agent-no-event']?.capabilities).toEqual({
      loadSession: true
    })
    expect(useAcpStore.getState().agents['agent-no-event']?.authMethods).toEqual([])
    vi.mocked(invoke).mockReset()
  })

  it('openHistorySession resumes immediately when the spawn response carries capabilities', async () => {
    // CAP-4: the spawn response is the authoritative source of capabilities.
    // `ensureLiveAgent` → `spawnAgent` sets capabilities synchronously, so
    // `openHistorySession`'s capability wait resolves instantly and the session
    // resumes without waiting for an `acp:agent_spawned` event.
    useAcpStore.setState((s) => ({
      agentConfigs: [
        { id: 'cfg-spawn', name: 'Spawn', command: 'spawn', args: [], env: {} },
        ...s.agentConfigs
      ]
    }))
    // Route by command name (not call order) so any unexpected invoke call fails
    // loudly instead of silently consuming a queued result.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_spawn_agent') {
        return {
          agentId: 'spawned-1',
          capabilities: { loadSession: true },
          authMethods: [],
          stableNamespace: 'config:spawn'
        }
      }
      if (cmd === 'acp_load_session') return undefined
      throw new Error(`unexpected invoke command in spawn-wait test: ${cmd}`)
    })
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-spawn',
        agentId: 'stale-spawn-uuid',
        agentConfigId: 'cfg-spawn',
        title: 'Spawn',
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
    const p = useAcpStore.getState().openHistorySession('s-spawn')
    await flushTurnEnd()
    // Spawn completed: the new agent is connected AND capabilities are already
    // populated from the spawn response (synchronous, no event needed).
    expect(useAcpStore.getState().agentStatus['spawned-1']).toBe('connected')
    expect(useAcpStore.getState().agents['spawned-1']?.capabilities).toEqual({
      loadSession: true
    })
    await p
    expect(invoke).toHaveBeenCalledWith('acp_load_session', {
      agentId: 'spawned-1',
      sessionId: 's-spawn',
      cwd: '/w'
    })
    expect(useAcpStore.getState().sessions['s-spawn'].agentId).toBe('spawned-1')
    expect(useAcpStore.getState().sessions['s-spawn'].status).toBe('active')
    vi.mocked(invoke).mockReset()
  })

  it('openHistorySession opens read-only when agentConfigId is missing', async () => {
    // Legacy persisted entries lack `agentConfigId`; we can't remap to a live
    // agent, so the chat opens read-only (current behavior) instead of throwing.
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-legacy',
        agentId: 'old-uuid',
        title: 'Legacy',
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
          blocks: [{ type: 'text', text: 'old' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('s-legacy')
    // No live agent resolvable -> 'local' strategy: transcript shown, no IPC.
    expect(invoke).not.toHaveBeenCalled()
    expect(useAcpStore.getState().messages['s-legacy']).toHaveLength(1)
    expect(useAcpStore.getState().sessions['s-legacy'].status).toBe('closed')
  })

  it('openHistorySession renders replayed session/load history instead of dropping it', async () => {
    // The core "empty reopened chat" bug: replayed session/update chunks arrive
    // while the load IPC is in flight (session still 'closed'). They must be
    // accepted, and the FIRST replayed chunk replaces the local mirror so the
    // conversation is not duplicated.
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-replay',
        agentId: 'agent-1',
        title: 'Replayed',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'mirror-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'stale local copy' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    // The agent streams the replay BEFORE responding to session/load.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== 'acp_load_session') {
        throw new Error(`unexpected invoke command in replay test: ${cmd}`)
      }
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: 's-replay',
        role: 'user',
        content: { type: 'text', text: 'replayed question' }
      })
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: 's-replay',
        role: 'agent',
        content: { type: 'text', text: 'replayed answer' }
      })
      return undefined
    })
    await useAcpStore.getState().openHistorySession('s-replay')
    const messages = useAcpStore.getState().messages['s-replay']
    expect(messages).toHaveLength(2)
    expect(messages[0].blocks).toEqual([{ type: 'text', text: 'replayed question' }])
    expect(messages[1].blocks).toEqual([{ type: 'text', text: 'replayed answer' }])
    expect(useAcpStore.getState().sessions['s-replay'].status).toBe('active')
    // The replay window closes on a deferred macrotask (straggler tolerance).
    expect(useAcpStore.getState().sessions['s-replay'].replaying).toBe('streaming')
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s-replay'].replaying).toBeNull()
    vi.mocked(invoke).mockReset()
  })

  it('projects a title that arrived during session/load replay once the replay window closes', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessionIndex: [
        {
          id: 's-replay-title',
          agentId: 'agent-1',
          agentConfigId: 'cfg-1',
          title: 'Untitled Chat',
          cwd: '/w',
          projectId: 'p1',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 1,
          lastSeq: 1,
          status: 'closed'
        }
      ]
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-replay-title',
        agentId: 'agent-1',
        title: 'Untitled Chat',
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
          blocks: [{ type: 'text', text: 'q' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== 'acp_load_session') {
        throw new Error(`unexpected invoke command in replay-title test: ${cmd}`)
      }
      // Replay a chunk (flips replaying to 'streaming' so the replay window
      // stays open one macrotask past the response).
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: 's-replay-title',
        role: 'user',
        content: { type: 'text', text: 'replayed q' }
      })
      // During replay, a session_info_update arrives with a real title. The
      // live session title updates immediately, but persistSession must be
      // skipped (replaying is truthy) so the index stays Untitled.
      useAcpStore.getState()._onSessionInfoUpdate({
        agentId: 'agent-1',
        sessionId: 's-replay-title',
        title: 'Agent Title'
      })
      return undefined
    })
    await useAcpStore.getState().openHistorySession('s-replay-title')
    // Title is set on the session during replay.
    expect(useAcpStore.getState().sessions['s-replay-title'].title).toBe('Agent Title')
    // Index still shows Untitled (persistSession skipped during replay).
    expect(useAcpStore.getState().sessionIndex.find((e) => e.id === 's-replay-title')?.title).toBe(
      'Untitled Chat'
    )
    // Replay window still open.
    expect(useAcpStore.getState().sessions['s-replay-title'].replaying).toBe('streaming')
    await flushTurnEnd()
    // Replay cleared -> persistSession projects the title into the index.
    expect(useAcpStore.getState().sessions['s-replay-title'].replaying).toBeNull()
    expect(useAcpStore.getState().sessionIndex.find((e) => e.id === 's-replay-title')?.title).toBe(
      'Agent Title'
    )
    vi.mocked(invoke).mockReset()
  })

  it('does not remove a locally-created session or revert a title when a stale index load resolves', async () => {
    const localActivity = Date.now()
    useAcpStore.setState({
      sessions: {
        's-local': {
          id: 's-local',
          agentId: 'agent-1',
          cwd: '/work',
          projectId: 'p1',
          status: 'active',
          title: 'Important Title',
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: localActivity
        },
        's-titled': {
          id: 's-titled',
          agentId: 'agent-1',
          cwd: '/work',
          projectId: 'p1',
          status: 'active',
          title: 'My Title',
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: localActivity
        }
      },
      messages: { 's-local': [], 's-titled': [] },
      sessionIndex: [
        {
          id: 's-local',
          agentId: 'agent-1',
          agentConfigId: 'cfg-1',
          title: 'Important Title',
          cwd: '/work',
          projectId: 'p1',
          createdAt: localActivity,
          lastActivityAt: localActivity,
          messageCount: 0,
          status: 'active'
        },
        {
          id: 's-titled',
          agentId: 'agent-1',
          agentConfigId: 'cfg-1',
          title: 'My Title',
          cwd: '/work',
          projectId: 'p1',
          createdAt: localActivity,
          lastActivityAt: localActivity,
          messageCount: 0,
          status: 'active'
        }
      ]
    })
    // Stale host response: omits s-local entirely; s-titled present but with
    // an Untitled fallback + older activity (the request predates the local
    // title mutation).
    vi.mocked(loadSessionIndex).mockResolvedValueOnce([
      {
        id: 's-titled',
        agentId: 'agent-1',
        agentConfigId: 'cfg-1',
        title: 'Untitled Chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: localActivity,
        lastActivityAt: localActivity - 1000,
        messageCount: 0,
        status: 'active'
      }
    ])
    await useAcpStore.getState().loadSessionIndex()
    const index = useAcpStore.getState().sessionIndex
    // s-local preserved (live session, absent from stale host response).
    expect(index.some((e) => e.id === 's-local')).toBe(true)
    expect(index.find((e) => e.id === 's-local')?.title).toBe('Important Title')
    // s-titled keeps the newer local title (not reverted to Untitled).
    expect(index.find((e) => e.id === 's-titled')?.title).toBe('My Title')
  })

  it('preserves then converges history across transient refresh and reconnect retry', async () => {
    vi.useFakeTimers()
    const current = {
      id: 's-existing',
      agentId: 'agent-1',
      agentConfigId: 'cfg-1',
      title: 'Existing Chat',
      cwd: '/work',
      projectId: 'p1',
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: 4,
      status: 'closed' as const
    }
    useAcpStore.setState({ sessionIndex: [current] })
    const recovered = { ...current, title: 'Recovered Chat', lastActivityAt: 3 }
    vi.mocked(loadSessionIndex)
      .mockRejectedValueOnce(new AcpTransportError('closed', 'transport recovering'))
      .mockRejectedValueOnce(new AcpTransportError('timeout', 'reconnect race'))
      .mockResolvedValueOnce([recovered])

    await expect(useAcpStore.getState().loadSessionIndex()).rejects.toMatchObject({
      code: 'closed'
    })

    expect(useAcpStore.getState().sessionIndex).toEqual([current])
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'acp-store.loadSessionIndex',
        message: expect.stringContaining('preserving current entries')
      })
    )
    let reconnectListener: ((reconnecting: boolean) => void) | undefined
    const transport = {
      setReconnectListener: vi.fn((listener: (reconnecting: boolean) => void) => {
        reconnectListener = listener
      }),
      setReconnectPriorityProvider: vi.fn(),
      setRecoveryHandler: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      dispose: vi.fn()
    }
    _setAcpTransportForTests(transport as unknown as AcpTransport)
    const teardown = initAcpEventListeners()

    reconnectListener?.(true)
    expect(useAcpStore.getState().transportReconnecting).toBe(true)
    reconnectListener?.(false)
    await Promise.resolve()
    expect(loadSessionIndex).toHaveBeenCalledTimes(2)
    expect(useAcpStore.getState().sessionIndex).toEqual([current])

    await vi.advanceTimersByTimeAsync(600)
    expect(loadSessionIndex).toHaveBeenCalledTimes(3)
    expect(useAcpStore.getState().sessionIndex).toEqual([recovered])

    expect(useAcpStore.getState().transportReconnecting).toBe(false)
    teardown()
    vi.useRealTimers()
  })

  it('resets an exhausted history retry budget on a later reconnect cycle', async () => {
    vi.useFakeTimers()
    const current = {
      id: 's-existing',
      agentId: 'agent-1',
      title: 'Existing Chat',
      cwd: '/work',
      projectId: 'p1',
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: 4,
      status: 'closed' as const
    }
    const recovered = { ...current, title: 'Recovered Later', lastActivityAt: 8 }
    useAcpStore.setState({ sessionIndex: [current] })
    vi.mocked(loadSessionIndex)
      .mockRejectedValueOnce(new AcpTransportError('closed', 'cycle one attempt one'))
      .mockRejectedValueOnce(new AcpTransportError('timeout', 'cycle one attempt two'))
      .mockRejectedValueOnce(new AcpTransportError('closed', 'cycle one attempt three'))
      .mockRejectedValueOnce(new AcpTransportError('timeout', 'cycle one exhausted'))
      .mockRejectedValueOnce(new AcpTransportError('closed', 'cycle two attempt one'))
      .mockResolvedValueOnce([recovered])

    let reconnectListener: ((reconnecting: boolean) => void) | undefined
    const transport = {
      setReconnectListener: vi.fn((listener: (reconnecting: boolean) => void) => {
        reconnectListener = listener
      }),
      setReconnectPriorityProvider: vi.fn(),
      setRecoveryHandler: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      dispose: vi.fn()
    }
    _setAcpTransportForTests(transport as unknown as AcpTransport)
    const teardown = initAcpEventListeners()

    reconnectListener?.(true)
    reconnectListener?.(false)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(loadSessionIndex).toHaveBeenCalledTimes(4)
    expect(useAcpStore.getState().sessionIndex).toEqual([current])

    reconnectListener?.(true)
    reconnectListener?.(false)
    await Promise.resolve()
    expect(loadSessionIndex).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(600)
    expect(loadSessionIndex).toHaveBeenCalledTimes(6)
    expect(useAcpStore.getState().sessionIndex).toEqual([recovered])

    teardown()
    vi.useRealTimers()
  })

  it('rejects non-transient history failures without replacing current entries', async () => {
    const current = {
      id: 's-existing',
      agentId: 'agent-1',
      title: 'Existing Chat',
      cwd: '/work',
      projectId: 'p1',
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: 4,
      status: 'closed' as const
    }
    useAcpStore.setState({ sessionIndex: [current] })
    const error = new Error('desktop schema mismatch')
    vi.mocked(loadSessionIndex).mockRejectedValueOnce(error)

    await expect(useAcpStore.getState().loadSessionIndex()).rejects.toBe(error)
    expect(useAcpStore.getState().sessionIndex).toEqual([current])
  })

  it('allows an older valid history response to apply after a newer refresh fails', async () => {
    const olderEntries = [
      {
        id: 's-valid',
        agentId: 'agent-1',
        title: 'Valid Host Entry',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed' as const
      }
    ]
    let resolveOlder: ((entries: typeof olderEntries) => void) | undefined
    vi.mocked(loadSessionIndex)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve
          })
      )
      .mockRejectedValueOnce(new AcpTransportError('closed', 'newer request failed'))

    const older = useAcpStore.getState().loadSessionIndex()
    await expect(useAcpStore.getState().loadSessionIndex()).rejects.toMatchObject({
      code: 'closed'
    })
    resolveOlder?.(olderEntries)
    await older

    expect(useAcpStore.getState().sessionIndex).toEqual(olderEntries)
  })

  it('openHistorySession accepts straggler chunks of an in-progress replay after load resolves', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-straggle',
        agentId: 'agent-1',
        title: 'Straggler',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 0,
        status: 'closed'
      },
      messages: []
    })
    // The replay STARTS while the load is in flight (streaming), so its window
    // stays open one macrotask past the response for chunks that lose the IPC
    // race.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== 'acp_load_session') {
        throw new Error(`unexpected invoke command in straggler test: ${cmd}`)
      }
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: 's-straggle',
        role: 'user',
        content: { type: 'text', text: 'replayed question' }
      })
      return undefined
    })
    await useAcpStore.getState().openHistorySession('s-straggle')
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's-straggle',
      role: 'agent',
      content: { type: 'text', text: 'late replay tail' }
    })
    expect(useAcpStore.getState().messages['s-straggle']).toHaveLength(2)
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s-straggle'].replaying).toBeNull()
    vi.mocked(invoke).mockReset()
  })

  it('openHistorySession keeps the local transcript when the agent replays nothing', async () => {
    // 'pending' must close as soon as the load response arrives with no replay:
    // a live chunk landing afterwards (e.g. an agent-initiated status message)
    // must APPEND-or-drop, never replace the restored conversation.
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-noreplay',
        agentId: 'agent-1',
        title: 'No replay',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'question' }],
          streaming: false,
          timestamp: 0
        },
        {
          id: 'm2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'answer' }],
          streaming: false,
          timestamp: 1
        }
      ]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await useAcpStore.getState().openHistorySession('s-noreplay')
    expect(useAcpStore.getState().sessions['s-noreplay'].replaying).toBeNull()
    // A live chunk after the empty replay must not wipe the mirror.
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's-noreplay',
      role: 'agent',
      content: { type: 'text', text: 'greeting' }
    })
    const messages = useAcpStore.getState().messages['s-noreplay']
    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages[0].id).toBe('m1')
    expect(messages[1].id).toBe('m2')
  })

  it('openHistorySession replay drops stale tool calls from a previous live period', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      toolCalls: { 's-tools': [{ toolCallId: 'stale-1', seq: 1 }] }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-tools',
        agentId: 'agent-1',
        title: 'Tools',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 0,
        status: 'closed'
      },
      messages: []
    })
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== 'acp_load_session') {
        throw new Error(`unexpected invoke command in tool-replay test: ${cmd}`)
      }
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: 's-tools',
        role: 'user',
        content: { type: 'text', text: 'replayed' }
      })
      return undefined
    })
    await useAcpStore.getState().openHistorySession('s-tools')
    // The replay replaced the transcript; the stale tool calls went with it.
    expect(useAcpStore.getState().toolCalls['s-tools']).toEqual([])
    vi.mocked(invoke).mockReset()
  })

  it('a follow-up prompt can be sent after a replayed reopen (AC1)', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-followup',
        agentId: 'agent-1',
        title: 'Follow up',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 0,
        status: 'closed'
      },
      messages: []
    })
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_load_session') {
        useAcpStore.getState()._onMessageChunk({
          agentId: 'agent-1',
          sessionId: 's-followup',
          role: 'agent',
          content: { type: 'text', text: 'replayed answer' }
        })
        return undefined
      }
      if (cmd === 'acp_send_prompt') return 'end_turn'
      throw new Error(`unexpected invoke command in follow-up test: ${cmd}`)
    })
    await useAcpStore.getState().openHistorySession('s-followup')
    await flushTurnEnd()
    await useAcpStore.getState().sendPrompt('s-followup', 'continue please')
    await flushTurnEnd()
    expect(invoke).toHaveBeenCalledWith('acp_send_prompt', {
      agentId: 'agent-1',
      sessionId: 's-followup',
      text: 'continue please'
    })
    const messages = useAcpStore.getState().messages['s-followup']
    expect(messages.some((m) => m.role === 'user')).toBe(true)
    vi.mocked(invoke).mockReset()
  })

  it('a title update streamed mid-replay does not persist the partial transcript', async () => {
    // _onSessionInfoUpdate persists — but a mid-replay persist would truncate
    // the on-disk history to whatever has replayed so far.
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessionIndex: [
        {
          id: 's-midpersist',
          agentId: 'agent-1',
          title: 'Old',
          cwd: '/w',
          projectId: 'p1',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 5,
          status: 'closed'
        }
      ]
    }))
    const { loadSessionPayload, queueSessionPayloadSave } = await import(
      '@/lib/acp-history-persistence'
    )
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-midpersist',
        agentId: 'agent-1',
        title: 'Old',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 5,
        status: 'closed'
      },
      messages: []
    })
    ;(queueSessionPayloadSave as ReturnType<typeof vi.fn>).mockClear()
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== 'acp_load_session') {
        throw new Error(`unexpected invoke command in mid-persist test: ${cmd}`)
      }
      // Replay starts, then the agent streams a title update mid-replay.
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: 's-midpersist',
        role: 'user',
        content: { type: 'text', text: 'partial replay' }
      })
      useAcpStore.getState()._onSessionInfoUpdate({
        agentId: 'agent-1',
        sessionId: 's-midpersist',
        title: 'New title'
      })
      return undefined
    })
    await useAcpStore.getState().openHistorySession('s-midpersist')
    expect(queueSessionPayloadSave).not.toHaveBeenCalled()
    vi.mocked(invoke).mockReset()
  })

  it('openHistorySession coalesces concurrent opens for the same chat', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    // Only ONE disk read is budgeted: if dedupe fails, the second call falls
    // through to the default (null payload) and rejects the test loudly.
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-race',
        agentId: 'agent-1',
        title: 'Race',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 0,
        status: 'closed'
      },
      messages: []
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    // Sidebar click + restored-tab rehydrate race at startup.
    await Promise.all([
      useAcpStore.getState().openHistorySession('s-race'),
      useAcpStore.getState().openHistorySession('s-race')
    ])
    const loadCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_load_session')
    expect(loadCalls).toHaveLength(1)
    expect(loadSessionPayload).toHaveBeenCalledTimes(1)
    expect(useAcpStore.getState().openingHistoryIds['s-race']).toBeUndefined()
  })

  it('delete/recreate starts a new local reopen and stale finally cannot clear its loading state', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessionIndex: [
        {
          id: 's-local-recreated',
          agentId: 'agent-1',
          title: 'Old',
          cwd: '/old',
          projectId: 'p1',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 0,
          status: 'closed'
        }
      ]
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    const oldPayload = deferred<{
      metadata: SessionIndexEntry
      messages: []
    }>()
    const newPayload = deferred<{
      metadata: SessionIndexEntry
      messages: []
    }>()
    ;(loadSessionPayload as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(oldPayload.promise)
      .mockReturnValueOnce(newPayload.promise)

    const oldOpening = useAcpStore.getState().openHistorySession('s-local-recreated')
    expect(useAcpStore.getState().openingHistoryIds['s-local-recreated']).toBe(true)
    await useAcpStore.getState().deleteHistorySession('s-local-recreated')
    expect(useAcpStore.getState().openingHistoryIds['s-local-recreated']).toBeUndefined()

    useAcpStore.setState({
      sessionIndex: [
        {
          id: 's-local-recreated',
          agentId: 'agent-1',
          title: 'New',
          cwd: '/new',
          projectId: 'p1',
          createdAt: 3,
          lastActivityAt: 4,
          messageCount: 0,
          status: 'closed'
        }
      ]
    })
    const newOpening = useAcpStore.getState().openHistorySession('s-local-recreated')
    expect(newOpening).not.toBe(oldOpening)
    expect(useAcpStore.getState().openingHistoryIds['s-local-recreated']).toBe(true)

    oldPayload.resolve({
      metadata: {
        id: 's-local-recreated',
        agentId: 'agent-1',
        title: 'Old',
        cwd: '/old',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 0,
        status: 'closed'
      },
      messages: []
    })
    await oldOpening
    expect(useAcpStore.getState().openingHistoryIds['s-local-recreated']).toBe(true)

    newPayload.resolve({
      metadata: {
        id: 's-local-recreated',
        agentId: 'agent-1',
        title: 'New',
        cwd: '/new',
        projectId: 'p1',
        createdAt: 3,
        lastActivityAt: 4,
        messageCount: 0,
        status: 'closed'
      },
      messages: []
    })
    await newOpening
    expect(useAcpStore.getState().openingHistoryIds['s-local-recreated']).toBeUndefined()
    expect(useAcpStore.getState().sessions['s-local-recreated']?.cwd).toBe('/new')
  })

  it('deleteHistorySession removes the index entry (P5)', async () => {
    useAcpStore.setState({
      sessionIndex: [
        {
          id: 's1',
          agentId: 'a',
          title: 'T',
          cwd: '',
          projectId: 'p1',
          createdAt: 0,
          lastActivityAt: 0,
          messageCount: 0,
          status: 'closed'
        }
      ]
    })
    await useAcpStore.getState().deleteHistorySession('s1')
    expect(useAcpStore.getState().sessionIndex).toHaveLength(0)
  })

  it('preserves a concurrent index update while durable history deletion is pending', async () => {
    const deleteGate = deferred<void>()
    const { queueSessionPayloadDelete } = await import('@/lib/acp-history-persistence')
    vi.mocked(queueSessionPayloadDelete).mockReturnValueOnce(deleteGate.promise)
    useAcpStore.setState({
      sessionIndex: [
        {
          id: 's-delete',
          agentId: 'a',
          title: 'Delete me',
          cwd: '',
          projectId: 'p1',
          createdAt: 0,
          lastActivityAt: 0,
          messageCount: 0,
          status: 'closed'
        }
      ]
    })

    const deleting = useAcpStore.getState().deleteHistorySession('s-delete')
    useAcpStore.setState((state) => ({
      sessionIndex: [
        ...state.sessionIndex,
        {
          id: 's-concurrent',
          agentId: 'b',
          title: 'Concurrent update',
          cwd: '/work',
          projectId: 'p2',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 1,
          status: 'closed'
        }
      ]
    }))
    deleteGate.resolve()
    await deleting

    expect(useAcpStore.getState().sessionIndex.map((entry) => entry.id)).toEqual(['s-concurrent'])
  })

  it('keeps the index entry when durable history deletion fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { queueSessionPayloadDelete } = await import('@/lib/acp-history-persistence')
    vi.mocked(queueSessionPayloadDelete).mockRejectedValueOnce(new Error('delete failed'))
    useAcpStore.setState({
      sessionIndex: [
        {
          id: 's-delete-fail',
          agentId: 'a',
          title: 'T',
          cwd: '',
          projectId: 'p1',
          createdAt: 0,
          lastActivityAt: 0,
          messageCount: 0,
          status: 'closed'
        }
      ]
    })

    await useAcpStore.getState().deleteHistorySession('s-delete-fail')

    expect(useAcpStore.getState().sessionIndex.map((entry) => entry.id)).toContain('s-delete-fail')
    consoleError.mockRestore()
  })

  it('MCP registry CRUD persists and removes (P6)', async () => {
    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'm1', type: 'stdio', name: 'fs', command: 'npx' })
    expect(useAcpStore.getState().mcpServers).toHaveLength(1)
    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'm1', type: 'stdio', name: 'fs2', command: 'npx' })
    expect(useAcpStore.getState().mcpServers).toHaveLength(1)
    expect(useAcpStore.getState().mcpServers[0].name).toBe('fs2')
    await useAcpStore.getState().deleteMcpServer('m1')
    expect(useAcpStore.getState().mcpServers).toHaveLength(0)
  })

  it('importMcpServers appends a batch in a single atomic persist', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.saveMcpServers).mockClear()
    useAcpStore.setState({
      mcpServers: [{ id: 'm0', type: 'stdio', name: 'Existing', command: 'node', enabled: true }]
    })
    await useAcpStore.getState().importMcpServers([
      { id: 'm2', type: 'stdio', name: 'a', command: 'node', enabled: true },
      { id: 'm3', type: 'http', name: 'b', url: 'https://b.test/mcp', enabled: true }
    ])
    expect(useAcpStore.getState().mcpServers.map((s) => s.id)).toEqual(['m0', 'm2', 'm3'])
    // One disk write for the whole batch — not one per entry.
    expect(vi.mocked(persistence.saveMcpServers)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(persistence.saveMcpServers)).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'm2' }),
        expect.objectContaining({ id: 'm3' })
      ])
    )
  })

  it('syncMcpRegistryToProjectFile mirrors the current registry to the project file (CAP-7)', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.syncMcpRegistryToProjectBestEffort).mockClear()
    useAcpStore.setState({
      mcpServers: [
        { id: 'm1', type: 'stdio', name: 'fs', command: 'npx', enabled: true },
        { id: 'm2', type: 'http', name: 'api', url: 'https://x.test/mcp', enabled: true }
      ],
      mcpServersLoaded: true
    })
    await useAcpStore.getState().syncMcpRegistryToProjectFile()
    expect(vi.mocked(persistence.syncMcpRegistryToProjectBestEffort)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(persistence.syncMcpRegistryToProjectBestEffort)).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'm1' }),
        expect.objectContaining({ id: 'm2' })
      ])
    )
  })

  it('rolls back an import batch when registry persistence fails', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.saveMcpServers).mockRejectedValueOnce(new Error('disk full'))
    useAcpStore.setState({
      mcpServers: [{ id: 'm0', type: 'stdio', name: 'Existing', command: 'node', enabled: true }]
    })
    await expect(
      useAcpStore
        .getState()
        .importMcpServers([{ id: 'm4', type: 'stdio', name: 'c', command: 'node', enabled: true }])
    ).rejects.toThrow('disk full')
    expect(useAcpStore.getState().mcpServers.map((s) => s.id)).toEqual(['m0'])
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp-store.importMcpServers' })
    )
  })

  it('serializes overlapping registry mutations so later writes never clobber earlier ones', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    const save = vi.mocked(persistence.saveMcpServers)
    save.mockClear()
    // The import's disk write stalls until the test releases it.
    let releaseImportWrite: (() => void) | undefined
    save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseImportWrite = () => resolve()
        })
    )
    useAcpStore.setState({
      mcpServers: [{ id: 'q1', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })

    const importPromise = useAcpStore
      .getState()
      .importMcpServers([
        { id: 'q2', type: 'stdio', name: 'Imported', command: 'node', enabled: true }
      ])
    // A toggle issued while the import write is in flight must wait its turn —
    // without the mutation queue it would snapshot the pre-import registry and
    // persist that stale list after the import (dropping q2), and its rollback
    // on failure would drop q2 too.
    const togglePromise = useAcpStore.getState().setMcpServerEnabled('q1', false)

    // Mutations run queued on the microtask queue; let the import mutation
    // reach its stalled disk write before asserting on the mid-flight state.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAcpStore.getState().mcpServers.map((s) => s.id)).toEqual(['q1', 'q2'])
    expect(save).toHaveBeenCalledTimes(1)

    releaseImportWrite?.()
    await importPromise
    await togglePromise

    // Both writes land in mutation order; the toggle's snapshot includes q2.
    expect(save).toHaveBeenCalledTimes(2)
    expect((save.mock.calls[0]?.[0] ?? []).map((s) => s.id)).toEqual(['q1', 'q2'])
    const secondWrite = save.mock.calls[1]?.[0] ?? []
    expect(secondWrite.map((s) => s.id)).toEqual(['q1', 'q2'])
    expect(secondWrite.find((s) => s.id === 'q1')?.enabled).toBe(false)

    const finalList = useAcpStore.getState().mcpServers
    expect(finalList.map((s) => s.id)).toEqual(['q1', 'q2'])
    expect(finalList.find((s) => s.id === 'q1')?.enabled).toBe(false)
  })

  it('derives enabled MCP servers from capabilities when no override is supplied', async () => {
    useAcpStore.setState({
      agents: {
        'agent-1': { id: 'agent-1', capabilities: { mcpCapabilities: { http: false } } }
      },
      agentStatus: { 'agent-1': 'connected' },
      mcpServers: [
        { id: 'stdio', type: 'stdio', name: 'Files', command: 'node', enabled: true },
        { id: 'http', type: 'http', name: 'Remote', url: 'https://x.test/mcp', enabled: true },
        { id: 'off', type: 'stdio', name: 'Off', command: 'node', enabled: false }
      ]
    })
    vi.mocked(invoke).mockResolvedValue({ sessionId: 'derived' })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(invoke).toHaveBeenCalledWith('acp_new_session', {
      agentId: 'agent-1',
      cwd: '/work',
      mcpServers: [{ type: 'stdio', name: 'Files', command: 'node', args: [], env: [] }],
      projectId: 'p1'
    })
    expect(useAcpStore.getState().sessions.derived.mcpServerCount).toBe(1)
    expect(toastWarning).toHaveBeenCalledWith(
      'Some MCP servers were skipped',
      expect.objectContaining({ description: expect.stringContaining('Remote') })
    )
  })

  it('preserves an explicit empty MCP override instead of deriving the registry', async () => {
    useAcpStore.setState({
      agents: { 'agent-1': { id: 'agent-1', capabilities: {} } },
      agentStatus: { 'agent-1': 'connected' },
      mcpServers: [{ id: 'stdio', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    vi.mocked(invoke).mockResolvedValue({ sessionId: 'override' })
    await useAcpStore.getState().createSession('agent-1', '/work', [], 'p1')
    expect(invoke).toHaveBeenCalledWith('acp_new_session', {
      agentId: 'agent-1',
      cwd: '/work',
      mcpServers: [],
      projectId: 'p1'
    })
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('rolls back an enable toggle when registry persistence fails', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.saveMcpServers).mockRejectedValueOnce(new Error('disk full'))
    useAcpStore.setState({
      mcpServers: [{ id: 'm1', type: 'stdio', name: 'Files', command: 'node', enabled: true }]
    })
    await expect(useAcpStore.getState().setMcpServerEnabled('m1', false)).rejects.toThrow(
      'disk full'
    )
    expect(useAcpStore.getState().mcpServers[0].enabled).toBe(true)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp-store.setMcpServerEnabled' })
    )
  })

  it('startChat forwards selected MCP servers to new_session (P6)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ agentId: 'agent-9', capabilities: {}, authMethods: [] })
      .mockResolvedValueOnce({ sessionId: 'sess-9' })
    const servers = [{ type: 'stdio' as const, name: 'fs', command: 'npx' }]
    await useAcpStore.getState().startChat('cfg-1', '/work', servers, 'p1')
    expect(invoke).toHaveBeenNthCalledWith(2, 'acp_new_session', {
      agentId: 'agent-9',
      cwd: '/work',
      mcpServers: servers,
      projectId: 'p1'
    })
  })

  it('probeMcpServer updates status + tools + loaded flag on a connected result', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 'p1', type: 'stdio', name: 'Files', command: 'npx', enabled: true }],
      mcpProbeStatus: {},
      mcpTools: {},
      mcpToolsLoaded: {},
      mcpProbing: {},
      // A stale error from a previous failed probe must be cleared on success.
      mcpProbeError: { p1: 'stale error from previous probe' }
    })
    vi.mocked(invoke).mockResolvedValueOnce({
      status: 'connected',
      tools: [{ name: 'read_file', description: 'read a file' }]
    })
    await useAcpStore.getState().probeMcpServer('p1')
    // The store strips registry-only `id`/`enabled` before passing the wire
    // config to the probe (stateless — no `toWireServer` default-fill, unlike
    // `selectMcpServersForAgent` which fills `args: []`/`env: []`).
    expect(invoke).toHaveBeenCalledWith('acp_probe_mcp_server', {
      server: { type: 'stdio', name: 'Files', command: 'npx' }
    })
    const state = useAcpStore.getState()
    expect(state.mcpProbeStatus.p1).toBe('connected')
    expect(state.mcpTools.p1).toEqual([{ name: 'read_file', description: 'read a file' }])
    expect(state.mcpToolsLoaded.p1).toBe(true)
    expect(state.mcpProbing.p1).toBe(false)
    expect(state.mcpProbeError.p1).toBeUndefined()
  })

  it('probeMcpServer surfaces a disconnected result without throwing', async () => {
    useAcpStore.setState({
      mcpServers: [
        { id: 'p2', type: 'http', name: 'Remote', url: 'https://x.test/m', enabled: true }
      ],
      mcpProbeStatus: {},
      mcpTools: {},
      mcpToolsLoaded: {},
      mcpProbing: {},
      mcpProbeError: {}
    })
    vi.mocked(invoke).mockResolvedValueOnce({
      status: 'disconnected',
      tools: [],
      error: 'initialize failed: connection refused'
    })
    await useAcpStore.getState().probeMcpServer('p2')
    const state = useAcpStore.getState()
    expect(state.mcpProbeStatus.p2).toBe('disconnected')
    expect(state.mcpTools.p2).toEqual([])
    expect(state.mcpToolsLoaded.p2).toBe(true)
    // The backend's redacted failure reason is stored for inline UI surfacing.
    expect(state.mcpProbeError.p2).toBe('initialize failed: connection refused')
    // A disconnected probe is a ProbeResult, NOT a throw — no error log.
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it('probeMcpServer dedupes concurrent probes for the same id', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 'p3', type: 'stdio', name: 'Files', command: 'npx', enabled: true }],
      mcpProbeStatus: {},
      mcpTools: {},
      mcpToolsLoaded: {},
      mcpProbing: {},
      mcpProbeError: {}
    })
    vi.mocked(invoke).mockResolvedValue({ status: 'connected', tools: [] })
    // Two concurrent calls — only one should reach the transport.
    await Promise.all([
      useAcpStore.getState().probeMcpServer('p3'),
      useAcpStore.getState().probeMcpServer('p3')
    ])
    expect(
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === 'acp_probe_mcp_server')
    ).toHaveLength(1)
  })

  it('loadMcpTools no-ops when tools are already loaded', async () => {
    useAcpStore.setState({
      mcpServers: [{ id: 'p4', type: 'stdio', name: 'Files', command: 'npx', enabled: true }],
      mcpToolsLoaded: { p4: true },
      mcpProbing: {}
    })
    vi.mocked(invoke).mockClear()
    await useAcpStore.getState().loadMcpTools('p4')
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('acp_probe_mcp_server', expect.anything())
  })

  it('probeMcpServer logs without env values on a transport failure', async () => {
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'p5',
          type: 'stdio',
          name: 'leaky',
          command: 'npx',
          args: [],
          env: [{ name: 'API_KEY', value: 'super-secret-value' }],
          enabled: true
        }
      ],
      mcpProbeStatus: {},
      mcpTools: {},
      mcpToolsLoaded: {},
      mcpProbing: {},
      mcpProbeError: {}
    })
    vi.mocked(invoke).mockRejectedValueOnce(new Error('transport down'))
    await useAcpStore.getState().probeMcpServer('p5')
    const state = useAcpStore.getState()
    expect(state.mcpProbeStatus.p5).toBe('disconnected')
    expect(state.mcpProbing.p5).toBe(false)
    // The canonical facade (`acp-mcp-probe.ts`) normalizes the invoke rejection
    // to a disconnected ProbeResult carrying the (value-free) error — so the
    // store's success path stores it for inline UI surfacing.
    expect(state.mcpProbeError.p5).toBe('Error: transport down')
    // The canonical facade (`acp-mcp-probe.ts`) normalizes the invoke rejection
    // to a disconnected ProbeResult and logs the transport failure itself — the
    // store's success path runs (probe "completed" with a disconnected result),
    // so `mcpToolsLoaded` is true (no auto-re-probe on next expand — a transport
    // failure is treated as a completed probe, consistent with the contract).
    expect(state.mcpToolsLoaded.p5).toBe(true)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp-mcp-probe.probeMcpServer' })
    )
    const logged = vi.mocked(logFrontendError).mock.calls.at(-1)?.[0]
    expect(logged?.message).toContain('leaky')
    expect(logged?.message).not.toContain('super-secret-value')
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

describe('ACP agent plan store', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
  })

  it('_onPlanUpdate replaces entries and empty update clears plan', () => {
    seedSession('sess-1', 'agent-1', false)
    useAcpStore.getState()._onPlanUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      plan: {
        entries: [{ content: 'step one', status: 'pending', priority: 'high' }]
      }
    })
    expect(useAcpStore.getState().plans['sess-1']).toHaveLength(1)

    useAcpStore.getState()._onPlanUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      plan: { entries: [] }
    })
    expect(useAcpStore.getState().plans['sess-1']).toBeUndefined()
  })

  it('closeSession clears cached plan for the session', async () => {
    seedSession('sess-1', 'agent-1', false)
    useAcpStore.setState({
      plans: {
        'sess-1': [{ content: 'old plan', status: 'completed' }]
      }
    })
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().closeSession('sess-1')
    expect(useAcpStore.getState().plans['sess-1']).toBeUndefined()
  })

  it('logs close failures while still closing the session locally', async () => {
    seedSession('sess-close-failure', 'agent-1', false)
    vi.mocked(invoke).mockRejectedValueOnce(new Error('agent rejected session/close'))

    await useAcpStore.getState().closeSession('sess-close-failure')

    expect(logFrontendError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'acp.closeSession',
      message: 'Failed to close session sess-close-failure: Error: agent rejected session/close'
    })
    expect(useAcpStore.getState().sessions['sess-close-failure']?.status).toBe('closed')
  })

  it('_onSessionClosed clears cached plan for the session', () => {
    seedSession('sess-1', 'agent-1', false)
    useAcpStore.setState({
      plans: {
        'sess-1': [{ content: 'old plan', status: 'completed' }]
      }
    })
    useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId: 'sess-1' })
    expect(useAcpStore.getState().plans['sess-1']).toBeUndefined()
  })

  // --- Plan persistence + sticky snapshot (spec: plan-persistence-sticky-snapshot) ---

  it('sendPrompt preserves plans[sessionId] across a new prompt turn', async () => {
    seedSession('sess-1', 'agent-1', false)
    const plan: PlanEntry[] = [
      { content: 'step one', status: 'in_progress', priority: 'high' },
      { content: 'step two', status: 'pending', priority: 'medium' }
    ]
    useAcpStore.setState({ plans: { 'sess-1': plan } })
    // never resolve so the turn stays active for the assertion
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    void useAcpStore.getState().sendPrompt('sess-1', 'follow up')
    await Promise.resolve()
    // Plan must NOT be cleared by sendPrompt (only _onPlanUpdate empty entries clears it)
    expect(useAcpStore.getState().plans['sess-1']).toBe(plan)
  })

  it('_onPromptComplete appends a termul-plan fence to the last assistant message when plans[sessionId] is non-empty', () => {
    seedSession('sess-1', 'agent-1', true)
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-1': [
          {
            id: 'm-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'do work' }],
            streaming: false,
            timestamp: 0,
            seq: 1
          },
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [{ type: 'text', text: 'working on it' }],
            streaming: true,
            timestamp: 1,
            seq: 2
          }
        ]
      },
      plans: {
        'sess-1': [
          { content: 'Read AC file', status: 'completed', priority: 'high' },
          { content: 'Fix bug', status: 'in_progress', priority: 'high' }
        ]
      }
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      stopReason: 'end_turn'
    })
    const msgs = useAcpStore.getState().messages['sess-1']
    const lastAgent = [...msgs].reverse().find((m) => m.role === 'agent')
    expect(lastAgent).toBeDefined()
    // The fence block must be the last block on the just-finished assistant message
    const fenceBlock = lastAgent!.blocks.find(
      (b) =>
        b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('```termul-plan\n')
    )
    expect(fenceBlock).toBeDefined()
    // Non-fence text blocks (the agent's reply prose) must survive the
    // appendPlanSnapshot filter — regression guard against a filter that
    // accidentally drops all text blocks.
    expect(lastAgent!.blocks).toHaveLength(2)
    // The preceding prose block gains a trailing newline so the fence opener
    // sits on its own line (CommonMark fence requirement). Without it, the
    // joined text "working on it```termul-plan" is not recognized as a fence
    // and the snapshot renders as plain text instead of a PlanPanel.
    expect(lastAgent!.blocks.find((b) => b.text === 'working on it\n')).toBeDefined()
    // The fence JSON decodes to the original PlanEntry[]
    const json = (fenceBlock!.text as string).replace(/^```termul-plan\n/, '').replace(/\n```$/, '')
    expect(JSON.parse(json)).toEqual([
      { content: 'Read AC file', status: 'completed', priority: 'high' },
      { content: 'Fix bug', status: 'in_progress', priority: 'high' }
    ])
    // streaming flag flipped by finalizeStreaming
    expect(lastAgent!.streaming).toBe(false)
    // Regression guard: when blocksToText joins the prose + fence with '', the
    // fence opener must be at the start of a line so Streamdown recognizes it.
    const joined = lastAgent!.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    expect(/(^|\n)```termul-plan/.test(joined)).toBe(true)
  })

  it('_onPromptComplete normalizes the last non-empty text block even when a non-text block follows it', () => {
    // blocksToText skips non-text blocks (images, resources) when joining, so
    // the block that ends up immediately before the fence in the joined text is
    // the last TEXT block — not the last array element. The boundary newline
    // must be applied to that text block, or the fence opener stays glued.
    seedSession('sess-1', 'agent-1', true)
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-1': [
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [
              { type: 'text', text: 'working on it' },
              { type: 'image', source: { uri: 'file:///x.png', mediaType: 'image/png' } }
            ],
            streaming: true,
            timestamp: 0,
            seq: 1
          }
        ]
      },
      plans: { 'sess-1': [{ content: 'task', status: 'completed' }] }
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      stopReason: 'end_turn'
    })
    const lastAgent = useAcpStore.getState().messages['sess-1'].find((m) => m.role === 'agent')!
    // The text block (not the image) gained the trailing newline boundary.
    expect(lastAgent.blocks.find((b) => b.text === 'working on it\n')).toBeDefined()
    // The joined text has the fence opener at the start of a line.
    const joined = lastAgent.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    expect(/(^|\n)```termul-plan/.test(joined)).toBe(true)
  })

  it('_onPromptComplete writes no fence when plans[sessionId] is empty (non-compliant agent)', () => {
    seedSession('sess-1', 'agent-1', true)
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-1': [
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [{ type: 'text', text: 'reply' }],
            streaming: true,
            timestamp: 0,
            seq: 1
          }
        ]
      },
      plans: {}
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      stopReason: 'end_turn'
    })
    const lastAgent = useAcpStore.getState().messages['sess-1'].find((m) => m.role === 'agent')!
    expect(
      lastAgent.blocks.some((b) => b.type === 'text' && b.text?.startsWith('```termul-plan\n'))
    ).toBe(false)
  })

  it('_onPromptComplete replaces a prior termul-plan fence on the same message (one fence per assistant message)', () => {
    seedSession('sess-1', 'agent-1', true)
    const priorFence = '```termul-plan\n[{"content":"old","status":"completed"}]\n```'
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-1': [
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [
              { type: 'text', text: 'reply' },
              { type: 'text', text: priorFence }
            ],
            streaming: true,
            timestamp: 0,
            seq: 1
          }
        ]
      },
      plans: {
        'sess-1': [{ content: 'new plan', status: 'in_progress', priority: 'high' }]
      }
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      stopReason: 'end_turn'
    })
    const lastAgent = useAcpStore.getState().messages['sess-1'].find((m) => m.role === 'agent')!
    const fences = lastAgent.blocks.filter(
      (b) =>
        b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('```termul-plan\n')
    )
    // Exactly one fence — the prior one was replaced, not appended
    expect(fences).toHaveLength(1)
    const json = (fences[0]!.text as string).replace(/^```termul-plan\n/, '').replace(/\n```$/, '')
    expect(JSON.parse(json)).toEqual([
      { content: 'new plan', status: 'in_progress', priority: 'high' }
    ])
  })

  it('_onPromptComplete survives a JSON.stringify failure in appendPlanSnapshot without blocking turn-end (logs source: planSnapshot)', () => {
    // A PlanEntry mutated to carry a circular reference would make
    // JSON.stringify throw. The try/catch in _onPromptComplete logs to
    // source: 'planSnapshot' and continues — the live sticky plan still
    // covers the turn.
    seedSession('sess-circular', 'agent-1', true)
    const circular: PlanEntry = { content: 'bad', status: 'in_progress' } as PlanEntry
    ;(circular as unknown as { self: unknown }).self = circular
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        'sess-circular': [
          {
            id: 'm-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'do work' }],
            streaming: false,
            timestamp: 0,
            seq: 1
          },
          {
            id: 'm-agent',
            role: 'agent',
            blocks: [{ type: 'text', text: 'working on it' }],
            streaming: true,
            timestamp: 1,
            seq: 2
          }
        ]
      },
      plans: { 'sess-circular': [circular] }
    }))
    // Must not throw
    expect(() =>
      useAcpStore.getState()._onPromptComplete({
        agentId: 'agent-1',
        sessionId: 'sess-circular',
        stopReason: 'end_turn'
      })
    ).not.toThrow()
    // The agent's reply prose survives; no fence was appended (stringify threw).
    const lastAgent = useAcpStore
      .getState()
      .messages['sess-circular'].find((m) => m.role === 'agent')!
    expect(lastAgent.blocks.find((b) => b.text === 'working on it')).toBeDefined()
    expect(lastAgent.blocks.some((b) => b.text?.startsWith('```termul-plan'))).toBe(false)
  })

  it('_onPromptComplete updates the in-memory payload cache so a same-session rehydrate finds the fence (CAP-2 host-owned history)', async () => {
    // Seed the cache with a payload that has NO fence — this is the state
    // after the host has written the turn's `message_chunk`/`user_prompt`
    // records but before the renderer has snapshot the plan.
    seedSession('sess-cache', 'agent-1', true)
    const baseMessages: ChatMessage[] = [
      {
        id: 'm-user',
        role: 'user',
        blocks: [{ type: 'text', text: 'do work' }],
        streaming: false,
        timestamp: 0,
        seq: 1
      },
      {
        id: 'm-agent',
        role: 'agent',
        blocks: [{ type: 'text', text: 'working on it' }],
        streaming: true,
        timestamp: 1,
        seq: 2
      }
    ]
    setCachedSessionPayload('sess-cache', {
      metadata: {
        id: 'sess-cache',
        agentId: 'agent-1',
        title: 'T',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 0,
        lastActivityAt: 0,
        messageCount: 2,
        status: 'active' as const
      },
      messages: baseMessages
    })
    useAcpStore.setState((s) => ({
      messages: { ...s.messages, 'sess-cache': baseMessages },
      plans: {
        'sess-cache': [{ content: 'cache task', status: 'in_progress', priority: 'high' }]
      }
    }))

    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 'sess-cache',
      stopReason: 'end_turn'
    })

    // The cache must now reflect the fence-appended messages so a subsequent
    // loadSessionPayload (within the same app session) finds the fence.
    const cached = getCachedSessionPayload('sess-cache')
    expect(cached).toBeDefined()
    const cachedAgent = [...cached!.messages].reverse().find((m) => m.role === 'agent')
    expect(cachedAgent).toBeDefined()
    const cachedFence = cachedAgent!.blocks.find(
      (b) =>
        b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('```termul-plan\n')
    )
    expect(cachedFence).toBeDefined()
    // The live store and the cache must agree on the fence content.
    const storeAgent = useAcpStore
      .getState()
      .messages['sess-cache'].find((m) => m.role === 'agent')!
    const storeFence = storeAgent.blocks.find(
      (b) =>
        b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('```termul-plan\n')
    )!
    expect(cachedFence!.text).toBe(storeFence.text)
  })

  it('openHistorySession repopulates plans[id] from the latest termul-plan fence in the last assistant message', async () => {
    const plan: PlanEntry[] = [
      { content: 'historical task', status: 'completed', priority: 'high' },
      { content: 'next step', status: 'in_progress', priority: 'medium' }
    ]
    const fence = '```termul-plan\n' + JSON.stringify(plan) + '\n```'
    setCachedSessionPayload('sess-rehydrate', {
      metadata: {
        id: 'sess-rehydrate',
        agentId: 'agent-x',
        title: 'Rehydrated',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'm-user',
          role: 'user',
          blocks: [{ type: 'text', text: 'do work' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        },
        {
          id: 'm-agent',
          role: 'agent',
          blocks: [
            { type: 'text', text: 'reply' },
            { type: 'text', text: fence }
          ],
          streaming: false,
          timestamp: 1,
          seq: 2
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('sess-rehydrate')
    expect(useAcpStore.getState().plans['sess-rehydrate']).toEqual(plan)
  })

  it('openHistorySession leaves plans[id] empty and warns when the fence JSON is malformed', async () => {
    setCachedSessionPayload('sess-malformed', {
      metadata: {
        id: 'sess-malformed',
        agentId: 'agent-x',
        title: 'Malformed',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm-agent',
          role: 'agent',
          blocks: [{ type: 'text', text: '```termul-plan\n{not valid json}\n```' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('sess-malformed')
    expect(useAcpStore.getState().plans['sess-malformed']).toBeUndefined()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'planRehydrate' })
    )
  })

  it('openHistorySession does not overwrite a live plans[id] from an in-flight turn', async () => {
    const livePlan: PlanEntry[] = [{ content: 'live', status: 'in_progress', priority: 'high' }]
    const fence =
      '```termul-plan\n' + JSON.stringify([{ content: 'fence', status: 'completed' }]) + '\n```'
    setCachedSessionPayload('sess-live', {
      metadata: {
        id: 'sess-live',
        agentId: 'agent-x',
        title: 'Live',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm-agent',
          role: 'agent',
          blocks: [{ type: 'text', text: fence }],
          streaming: false,
          timestamp: 0,
          seq: 1
        }
      ]
    })
    seedSession('sess-live', 'agent-x', true)
    useAcpStore.setState({ plans: { 'sess-live': livePlan } })
    await useAcpStore.getState().openHistorySession('sess-live')
    // Live plan from the in-flight turn wins; the fence does not overwrite it
    expect(useAcpStore.getState().plans['sess-live']).toBe(livePlan)
  })

  it('openHistorySession last-fence-wins when two termul-plan fences are in the same assistant message', async () => {
    const first =
      '```termul-plan\n' + JSON.stringify([{ content: 'first', status: 'completed' }]) + '\n```'
    const second =
      '```termul-plan\n' + JSON.stringify([{ content: 'second', status: 'in_progress' }]) + '\n```'
    setCachedSessionPayload('sess-twofence', {
      metadata: {
        id: 'sess-twofence',
        agentId: 'agent-x',
        title: 'Two fences',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm-agent',
          role: 'agent',
          blocks: [
            { type: 'text', text: 'reply' },
            { type: 'text', text: first },
            { type: 'text', text: second }
          ],
          streaming: false,
          timestamp: 0,
          seq: 1
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('sess-twofence')
    expect(useAcpStore.getState().plans['sess-twofence']).toEqual([
      { content: 'second', status: 'in_progress' }
    ])
  })
})

describe('acp-store transcript eviction (WebView memory)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetCoalesceForTesting()
    useAcpStore.setState(FRESH)
  })

  function seedTranscript(sessionId: string): void {
    seedSession(sessionId, 'agent-1', false)
    useAcpStore.setState({
      messages: {
        [sessionId]: [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'hello' }],
            streaming: false,
            timestamp: 1
          }
        ]
      },
      toolCalls: {
        [sessionId]: [{ toolCallId: 'tc-1', title: 'read', status: 'completed', seq: 1 }]
      },
      commands: { [sessionId]: [{ name: 'help', description: 'help' }] },
      sessionUsage: {
        [sessionId]: {
          used: 10,
          size: 100,
          baselineUsed: 0,
          updatedAt: 1,
          source: 'reported'
        }
      }
    })
  }

  it('closeSession drops messages/toolCalls/commands/sessionUsage', async () => {
    seedTranscript('sess-mem')
    useAcpStore.setState({
      plans: { 'sess-mem': [{ content: 'plan', status: 'pending' }] }
    })
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().closeSession('sess-mem')
    const st = useAcpStore.getState()
    expect(st.sessions['sess-mem']?.status).toBe('closed')
    expect(st.messages['sess-mem']).toBeUndefined()
    expect(st.toolCalls['sess-mem']).toBeUndefined()
    expect(st.commands['sess-mem']).toBeUndefined()
    expect(st.sessionUsage['sess-mem']).toBeUndefined()
    expect(st.plans['sess-mem']).toBeUndefined()
  })

  it('deleteHistorySession drops in-memory transcript maps', async () => {
    seedTranscript('sess-del')
    useAcpStore.setState({
      sessionIndex: [
        {
          id: 'sess-del',
          agentId: 'agent-1',
          title: 'T',
          cwd: '/work',
          projectId: 'p1',
          createdAt: 0,
          lastActivityAt: 0,
          messageCount: 1,
          status: 'active'
        }
      ]
    })
    await useAcpStore.getState().deleteHistorySession('sess-del')
    const st = useAcpStore.getState()
    expect(st.messages['sess-del']).toBeUndefined()
    expect(st.toolCalls['sess-del']).toBeUndefined()
    expect(st.commands['sess-del']).toBeUndefined()
    expect(st.sessionUsage['sess-del']).toBeUndefined()
  })

  it('_onSessionClosed drops transcript maps after persist', () => {
    seedTranscript('sess-closed')
    useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId: 'sess-closed' })
    const st = useAcpStore.getState()
    expect(st.sessions['sess-closed']?.status).toBe('closed')
    expect(st.messages['sess-closed']).toBeUndefined()
    expect(st.toolCalls['sess-closed']).toBeUndefined()
  })

  it('late _onToolCall for closed session does not recreate toolCalls', async () => {
    seedTranscript('sess-late')
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().closeSession('sess-late')
    useAcpStore.getState()._onToolCall({
      agentId: 'agent-1',
      sessionId: 'sess-late',
      toolCall: { toolCallId: 'late-1', title: 'write', status: 'pending' }
    })
    expect(useAcpStore.getState().toolCalls['sess-late']).toBeUndefined()
  })

  it('late commands/usage/plan updates do not recreate maps after close', async () => {
    seedTranscript('sess-late-maps')
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().closeSession('sess-late-maps')
    useAcpStore.getState()._onCommandsUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-late-maps',
      availableCommands: [{ name: 'x' }]
    })
    useAcpStore.getState()._onUsageUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-late-maps',
      used: 50,
      size: 100
    })
    useAcpStore.getState()._onPlanUpdate({
      agentId: 'agent-1',
      sessionId: 'sess-late-maps',
      plan: { entries: [{ content: 'step', status: 'pending' }] }
    })
    const st = useAcpStore.getState()
    expect(st.commands['sess-late-maps']).toBeUndefined()
    expect(st.sessionUsage['sess-late-maps']).toBeUndefined()
    expect(st.plans['sess-late-maps']).toBeUndefined()
  })

  it('second close after eviction does not persist empty messages', async () => {
    const { queueSessionPayloadSave } = await import('@/lib/acp-history-persistence')
    seedTranscript('sess-twice')
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().closeSession('sess-twice')
    await new Promise((resolve) => setTimeout(resolve, 0))
    vi.mocked(queueSessionPayloadSave).mockClear()
    await useAcpStore.getState().closeSession('sess-twice')
    expect(queueSessionPayloadSave).not.toHaveBeenCalled()
  })

  it('openHistorySession reloads messages after prior close eviction', async () => {
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    seedTranscript('sess-reopen')
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().closeSession('sess-reopen')
    expect(useAcpStore.getState().messages['sess-reopen']).toBeUndefined()

    vi.mocked(loadSessionPayload).mockResolvedValueOnce({
      metadata: {
        id: 'sess-reopen',
        agentId: 'agent-1',
        title: 'Reopen',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm-disk',
          role: 'user',
          blocks: [{ type: 'text', text: 'from disk' }],
          streaming: false,
          timestamp: 1
        }
      ]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await useAcpStore.getState().openHistorySession('sess-reopen')
    expect(useAcpStore.getState().messages['sess-reopen']?.[0]?.id).toBe('m-disk')
  })
})

describe('acp-store live window + lazy-load + coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(invoke as ReturnType<typeof vi.fn>).mockReset()
    _resetCoalesceForTesting()
    _resetLoadingOlderForTesting()
    _clearPayloadCacheForTesting()
    useAcpStore.setState(FRESH)
  })

  /** Build N complete messages [m0..m(N-1)] alternating user/agent. */
  function buildMessages(count: number): ChatMessage[] {
    return Array.from(
      { length: count },
      (_, i): ChatMessage => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'agent',
        blocks: [{ type: 'text', text: `msg ${i}` }],
        streaming: false,
        timestamp: i,
        seq: i
      })
    )
  }

  /** Minimal metadata entry for a cached payload. */
  function fakeMetadata(sid: string, count: number) {
    return {
      id: sid,
      agentId: 'agent-1',
      title: 'T',
      cwd: '/work',
      projectId: 'p1',
      createdAt: 0,
      lastActivityAt: 0,
      messageCount: count,
      status: 'active' as const
    }
  }

  it('(a) trimLiveWindow trims oldest complete messages and keeps the streaming tail', () => {
    const sid = 's-trim'
    seedSession(sid, 'agent-1', true)
    const fullMessages = buildMessages(351)
    // Cache the full payload so trimming is safe (older msgs restorable on scroll-up).
    setCachedSessionPayload(sid, { metadata: fakeMetadata(sid, 351), messages: fullMessages })
    // Live window holds all 351; mark the last as the in-flight streaming tail.
    const liveWindow = fullMessages.map((m, i) => (i === 350 ? { ...m, streaming: true } : m))
    useAcpStore.setState({ messages: { [sid]: liveWindow } })
    // Push a chunk via the coalesced path; flush triggers trimLiveWindow.
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' tail' }
    })
    _flushCoalescedForTesting()
    const msgs = useAcpStore.getState().messages[sid]
    expect(msgs.length).toBeLessThanOrEqual(MAX_LIVE_WINDOW_MESSAGES)
    // The in-flight streaming tail is always retained.
    expect(msgs[msgs.length - 1].streaming).toBe(true)
  })

  it('(b) trim is skipped when no cached payload (no data loss for un-persisted sessions)', () => {
    const sid = 's-no-cache'
    seedSession(sid, 'agent-1', true)
    // No setCachedSessionPayload — the session is not yet persisted to disk.
    const liveWindow = buildMessages(310).map((m, i) => (i === 309 ? { ...m, streaming: true } : m))
    useAcpStore.setState({ messages: { [sid]: liveWindow } })
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' more' }
    })
    _flushCoalescedForTesting()
    const msgs = useAcpStore.getState().messages[sid]
    // No trim — all messages retained (no disk copy to lazy-load from).
    expect(msgs.length).toBe(310)
    expect(msgs[msgs.length - 1].streaming).toBe(true)
  })

  it('(c) loadOlderMessages prepends older messages and is idempotent at history head', async () => {
    const sid = 's-older'
    seedSession(sid, 'agent-1', false)
    const fullMessages = buildMessages(401)
    setCachedSessionPayload(sid, { metadata: fakeMetadata(sid, 401), messages: fullMessages })
    // Live window starts at m150 (trimmed) — [m150..m400] (251 messages).
    useAcpStore.setState({ messages: { [sid]: fullMessages.slice(150) } })
    expect(useAcpStore.getState().messages[sid][0].id).toBe('m150')

    // Load 50 older: should prepend m100..m149.
    await useAcpStore.getState().loadOlderMessages(sid, 50)
    const afterFirst = useAcpStore.getState().messages[sid]
    expect(afterFirst[0].id).toBe('m100')
    expect(afterFirst.length).toBe(301) // 251 + 50

    // Load again: now oldest is m100, load 50 more → m50..m99.
    await useAcpStore.getState().loadOlderMessages(sid, 50)
    expect(useAcpStore.getState().messages[sid][0].id).toBe('m50')

    // Load until history head (oldestId === m0).
    await useAcpStore.getState().loadOlderMessages(sid, 50) // m0..m49
    expect(useAcpStore.getState().messages[sid][0].id).toBe('m0')
    const beforeHead = useAcpStore.getState().messages[sid].length

    // Idempotent at head — no duplicate, no infinite loop.
    await useAcpStore.getState().loadOlderMessages(sid, 50)
    expect(useAcpStore.getState().messages[sid].length).toBe(beforeHead)
    expect(useAcpStore.getState().messages[sid][0].id).toBe('m0')
  })

  it('(d) coalescing collapses a burst of chunks into a single set() per frame', () => {
    const sid = 's-coalesce'
    seedSession(sid, 'agent-1', true)
    let setCount = 0
    const unsub = useAcpStore.subscribe(() => {
      setCount++
    })
    try {
      const store = useAcpStore.getState()
      store._onMessageChunk({
        agentId: 'agent-1',
        sessionId: sid,
        role: 'agent',
        content: { type: 'text', text: 'a' }
      })
      store._onMessageChunk({
        agentId: 'agent-1',
        sessionId: sid,
        role: 'agent',
        content: { type: 'text', text: 'b' }
      })
      store._onMessageChunk({
        agentId: 'agent-1',
        sessionId: sid,
        role: 'agent',
        content: { type: 'text', text: 'c' }
      })
      // A coalesce flush is pending (rAF scheduled) but no set() has fired yet.
      expect(_isCoalescePendingForTesting()).toBe(true)
      expect(setCount).toBe(0)
      // Flush applies all buffered chunks in ONE set().
      _flushCoalescedForTesting()
      expect(setCount).toBe(1)
      // Final state reflects every chunk.
      const msgs = useAcpStore.getState().messages[sid]
      expect(msgs).toHaveLength(1)
      expect(msgs[0].blocks[0]).toEqual({ type: 'text', text: 'abc' })
    } finally {
      unsub()
    }
  })

  it('(e) closed-session chunk is dropped (no map re-growth)', () => {
    const sid = 's-closed-late'
    seedSession(sid, 'agent-1', false)
    // Simulate close-time eviction: messages map entry dropped.
    useAcpStore.setState({
      sessions: { [sid]: { ...useAcpStore.getState().sessions[sid], status: 'closed' } },
      messages: {}
    })
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: 'late' }
    })
    _flushCoalescedForTesting()
    // No messages map entry recreated.
    expect(useAcpStore.getState().messages[sid]).toBeUndefined()
  })

  it('(e) replay mode replaces the transcript immediately (not coalesced)', () => {
    const sid = 's-replay'
    seedSession(sid, 'agent-1', false)
    // Seed an existing transcript that replay should replace.
    useAcpStore.setState({
      messages: {
        [sid]: [
          {
            id: 'old',
            role: 'user',
            blocks: [{ type: 'text', text: 'old' }],
            streaming: false,
            timestamp: 0,
            seq: 0
          }
        ]
      }
    })
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [sid]: { ...s.sessions[sid], status: 'closed', replaying: 'pending' }
      }
    }))
    // First replayed chunk replaces the transcript (immediate set, not buffered).
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: 'replayed' }
    })
    // Replay mode uses immediate set() — no coalesce pending.
    expect(_isCoalescePendingForTesting()).toBe(false)
    const msgs = useAcpStore.getState().messages[sid]
    expect(msgs).toHaveLength(1)
    expect(msgs[0].blocks[0]).toEqual({ type: 'text', text: 'replayed' })
    expect(msgs[0].streaming).toBe(true)
    expect(useAcpStore.getState().sessions[sid].replaying).toBe('streaming')
  })
})

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
      pendingQuestions: {}
    })
    _resetInFlightHistoryOpensForTesting()
    _resetEphemeralSessionIdsForTesting()
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
  })

  it('startChat refills a warm session for the pool target after consuming one', async () => {
    await seedConnectedAgent('cfg-1', 'agent-9')
    useAcpStore.getState().setSelectedAgentConfigId('cfg-1')
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'sess-1' })
    useAcpStore.getState().prepareChat('cfg-1', '/work', undefined, 'p1')
    const key = prepareChatKey('cfg-1', '/work', undefined)
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-1'))
    vi.mocked(invoke).mockResolvedValueOnce({ sessionId: 'sess-2' })
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work', undefined, 'p1')
    expect(sessionId).toBe('sess-1')
    // Refill fired: a fresh session/new produced a new warm slot for the next chat.
    await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[key]).toBe('sess-2'))
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
})

describe('acp provider authentication & recovery', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    _resetAcpAuthForTesting()
    useAcpStore.setState(FRESH)
  })

  /** Register a live agent as if it were spawned + `acp:agent_spawned` reduced. */
  function seedLiveAgent(
    agentId: string,
    authMethods: Array<{ id: string; name: string; description?: string | null }>,
    capabilities: Record<string, unknown> | null = {}
  ): void {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, [agentId]: { id: agentId, capabilities, authMethods } },
      agentStatus: { ...s.agentStatus, [agentId]: 'connected' }
    }))
  }

  it('authenticates the single advertised method before session/new (P1)', async () => {
    // CAP-4: the spawn response populates authMethods synchronously, so
    // `authenticateBeforeSession` reads them directly — no timed wait. Seed
    // the agent with the methods already present (as `spawnAgent` would do
    // from the response) and verify authenticate → session/new ordering.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Sign in with Cursor' }])
    const order: string[] = []
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    expect(order).toEqual(['acp_authenticate', 'acp_new_session'])
    const authCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'acp_authenticate')
    expect(authCall?.[1]).toEqual({ agentId: 'agent-1', methodId: 'cursor_login' })
  })

  it('authenticates before session/new even when the agent_spawned event never arrives (CAP-4 no no-auth fallback)', async () => {
    // CAP-4 acceptance: a Cursor-style agent (one auth method) whose
    // `acp:agent_spawned` event is delayed beyond the former 250ms window
    // must STILL authenticate before `session/new`. The spawn response is the
    // authoritative source; the event is observer-only. The former
    // `SPAWN_DETAILS_WAIT_MS` timeout that inferred no-auth after 250ms is gone.
    //
    // Seed the agent with authMethods from the (synchronous) spawn response.
    // Do NOT emit `_onAgentSpawned` — the event never arrives.
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Sign in with Cursor' }])
    const order: string[] = []
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd)
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') return { sessionId: 's1' }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    // authenticate ran before session/new — no no-auth fallback.
    expect(order).toEqual(['acp_authenticate', 'acp_new_session'])
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
    // Never authenticated nor created a session.
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(0)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(0)
  })

  it('dedupes concurrent authenticate for the same agent (P2)', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    let sessionCounter = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        sessionCounter += 1
        return { sessionId: `s${sessionCounter}` }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await Promise.all([
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1'),
      useAcpStore.getState().createSession('agent-1', '/work', undefined, 'p1')
    ])
    // One shared authenticate, two independent session/new calls.
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_authenticate')).toHaveLength(1)
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'acp_new_session')).toHaveLength(2)
  })

  it('clears the authenticated flag on an auth-category session/new failure so retry re-authenticates (P3)', async () => {
    seedLiveAgent('agent-1', [{ id: 'cursor_login', name: 'Cursor' }])
    let newSessionCalls = 0
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_authenticate') return undefined
      if (cmd === 'acp_new_session') {
        newSessionCalls += 1
        if (newSessionCalls === 1) throw 'authentication required: run cursor login'
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
})

describe('acp-store: composer-selection persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(invoke as ReturnType<typeof vi.fn>).mockReset()
    mockPersistenceApi.read.mockReset()
    mockPersistenceApi.writeDebounced.mockReset()
    mockPersistenceApi.read.mockResolvedValue({ success: false })
    mockPersistenceApi.writeDebounced.mockResolvedValue({ success: true })
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetAcpAuthForTesting()
    _resetInFlightPreparedForTesting()
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    useAcpStore.setState(FRESH)
  })

  it('setModel persists the modelId to persistenceApi (debounced)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-persist', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-persist': {
          ...s.sessions['sess-persist'],
          models: {
            currentModelId: 'm1',
            availableModels: [
              { modelId: 'm1', name: 'Model One' },
              { modelId: 'm2', name: 'Model Two' }
            ]
          }
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined) // set_model

    await useAcpStore.getState().setModel('sess-persist', 'm2')
    // persistComposerOptions chains on a per-key promise queue; flush the
    // microtask before asserting.
    await vi.waitFor(() => expect(mockPersistenceApi.writeDebounced).toHaveBeenCalled())

    expect(mockPersistenceApi.writeDebounced).toHaveBeenCalledWith(
      'agents/composer-options/cfg-1',
      expect.objectContaining({ modelId: 'm2' })
    )
  })

  it('setMode persists the modeId to persistenceApi (debounced)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-persist', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-persist': {
          ...s.sessions['sess-persist'],
          modes: {
            currentModeId: 'agent',
            availableModes: [
              { id: 'agent', name: 'Agent' },
              { id: 'plan', name: 'Plan' }
            ]
          }
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined) // set_mode

    await useAcpStore.getState().setMode('sess-persist', 'plan')
    await vi.waitFor(() => expect(mockPersistenceApi.writeDebounced).toHaveBeenCalled())

    expect(mockPersistenceApi.writeDebounced).toHaveBeenCalledWith(
      'agents/composer-options/cfg-1',
      expect.objectContaining({ modeId: 'plan' })
    )
  })

  it('setConfigOption persists the config value to persistenceApi (debounced)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-persist', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-persist': {
          ...s.sessions['sess-persist'],
          configOptions: [
            {
              id: 'thought_level',
              name: 'Thinking',
              category: 'thought_level',
              type: 'select',
              currentValue: 'low',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' }
              ]
            }
          ]
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' }
        ]
      }
    ]) // set_config_option

    await useAcpStore.getState().setConfigOption('sess-persist', 'thought_level', 'high')
    await vi.waitFor(() => expect(mockPersistenceApi.writeDebounced).toHaveBeenCalled())

    expect(mockPersistenceApi.writeDebounced).toHaveBeenCalledWith(
      'agents/composer-options/cfg-1',
      expect.objectContaining({ configValues: { thought_level: 'high' } })
    )
  })

  it('persistComposerOptions merges partial patches (does not overwrite existing fields)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-persist', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-persist': {
          ...s.sessions['sess-persist'],
          models: {
            currentModelId: 'm1',
            availableModels: [
              { modelId: 'm1', name: 'Model One' },
              { modelId: 'm2', name: 'Model Two' }
            ]
          },
          modes: {
            currentModeId: 'agent',
            availableModes: [
              { id: 'agent', name: 'Agent' },
              { id: 'plan', name: 'Plan' }
            ]
          }
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    // Simulate an existing persisted record with a config value.
    mockPersistenceApi.read.mockResolvedValue({
      success: true,
      data: { configValues: { thought_level: 'high' } }
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined) // set_model

    await useAcpStore.getState().setModel('sess-persist', 'm2')
    await vi.waitFor(() => expect(mockPersistenceApi.writeDebounced).toHaveBeenCalled())

    const callArgs = vi.mocked(mockPersistenceApi.writeDebounced).mock.calls[0]
    expect(callArgs).toBeDefined()
    const written = callArgs![1] as Record<string, unknown>
    // The merge preserves the existing configValues while adding modelId.
    expect(written).toMatchObject({
      modelId: 'm2',
      configValues: { thought_level: 'high' }
    })
  })

  it('skips persistence for ephemeral/warm-pool sessions', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-eph', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-eph': {
          ...s.sessions['sess-eph'],
          models: {
            currentModelId: 'm1',
            availableModels: [
              { modelId: 'm1', name: 'Model One' },
              { modelId: 'm2', name: 'Model Two' }
            ]
          }
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    // Mark the session as ephemeral (warm-pool seed).
    _addEphemeralSessionIdForTesting('sess-eph')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined) // set_model

    await useAcpStore.getState().setModel('sess-eph', 'm2')
    // Ephemeral sessions skip persistence so agent defaults don't overwrite
    // the user's real last selection.
    expect(mockPersistenceApi.writeDebounced).not.toHaveBeenCalled()
  })
})

describe('assistTerminal (#259)', () => {
  beforeEach(() => {
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetAcpAuthForTesting()
    _resetInFlightPreparedForTesting()
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    useAcpStore.setState(FRESH)
  })

  it('explains selected output through a hidden one-shot session and disposes it', async () => {
    useAcpStore.setState({
      selectedAgentConfigId: 'cfg-1',
      agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }]
    })
    let promptBody = ''
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-1', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 'assist-session' }
      if (command === 'acp_send_prompt') {
        promptBody = String((args as { text?: string }).text ?? '')
        useAcpStore.getState()._onMessageChunk({
          agentId: 'agent-1',
          sessionId: 'assist-session',
          role: 'agent',
          content: { type: 'text', text: 'The command failed because ' }
        })
        useAcpStore.getState()._onMessageChunk({
          agentId: 'agent-1',
          sessionId: 'assist-session',
          role: 'agent',
          content: { type: 'text', text: 'the port is in use.\n```sh\nlsof -i :3000\n```' }
        })
        useAcpStore.getState()._onPromptComplete({
          agentId: 'agent-1',
          sessionId: 'assist-session',
          stopReason: 'end_turn'
        })
        return 'end_turn'
      }
      if (command === 'acp_dispose_ephemeral_session') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })

    await expect(
      useAcpStore.getState().assistTerminal('explain', '/work', 'Error: EADDRINUSE', 1)
    ).resolves.toContain('lsof -i :3000')

    // The untrusted selection travels JSON-encoded and the prompt forbids tools.
    expect(promptBody).toContain('"Error: EADDRINUSE"')
    expect(promptBody).toContain('Do not use tools')
    // No visible session/transcript state survives.
    expect(useAcpStore.getState().sessions['assist-session']).toBeUndefined()
    expect(useAcpStore.getState().messages['assist-session']).toBeUndefined()
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_dispose_ephemeral_session')
    ).toBe(true)
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_close_session')).toBe(
      false
    )
  })

  it('fails fast without a configured agent', async () => {
    await expect(
      useAcpStore.getState().assistTerminal('fix', '/work', 'boom', 127)
    ).rejects.toThrow('Configure and select an ACP agent')
  })

  it('rejects empty or oversized selections', async () => {
    await expect(useAcpStore.getState().assistTerminal('fix', '/work', '   ', 1)).rejects.toThrow(
      'No terminal output selected'
    )
    await expect(
      useAcpStore.getState().assistTerminal('fix', '/work', 'x'.repeat(20_001), 1)
    ).rejects.toThrow('too large')
  })
})
