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
// Canvas MCP upsert tests drive the WEB branch (Authorization header): a
// controllable token source instead of localStorage/hash games.
const { webAuthToken } = vi.hoisted(() => ({ webAuthToken: { value: null as string | null } }))
vi.mock('@/lib/web-auth-token', () => ({
  getWebAuthToken: () => webAuthToken.value
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
import { loadSessionIndex } from '@/lib/acp-history-persistence'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport,
  AcpTransportError
} from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import {
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  initAcpEventListeners,
  useAcpStore
} from '@/stores/acp-store'
import { deferred, FRESH, flushTurnEnd } from './testkit'

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
          hostAuthReady: true,
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
    expect(useAcpStore.getState().agents['agent-caps']?.hostAuthReady).toBe(true)
    expect(useAcpStore.getState().agentStatus['agent-caps']).toBe('connected')
    vi.mocked(invoke).mockReset()
  })

  it('spawn response host-auth readiness wins over event-first metadata', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'acp_spawn_agent') {
        useAcpStore.getState()._onAgentSpawned({
          agentId: 'agent-host-auth',
          capabilities: {},
          authMethods: [
            { id: 'claude-code', name: 'Claude Code' },
            { id: 'api-key', name: 'API key' }
          ],
          hostAuthReady: false
        })
        return {
          agentId: 'agent-host-auth',
          capabilities: {},
          authMethods: [
            { id: 'claude-code', name: 'Claude Code' },
            { id: 'api-key', name: 'API key' }
          ],
          hostAuthReady: true
        }
      }
      throw new Error(`unexpected invoke command: ${cmd}`)
    })
    await useAcpStore.getState().spawnAgent({ name: 'Claude', command: 'node', args: [], env: {} })
    expect(useAcpStore.getState().agents['agent-host-auth']?.hostAuthReady).toBe(true)

    // A delayed observer event cannot overwrite the authoritative response.
    useAcpStore.getState()._onAgentSpawned({
      agentId: 'agent-host-auth',
      capabilities: {},
      authMethods: [],
      hostAuthReady: false
    })
    expect(useAcpStore.getState().agents['agent-host-auth']?.hostAuthReady).toBe(true)
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
      text: 'continue please',
      turnId: expect.any(String)
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

  it('upsertCanvasMcpServer creates the canvas-mcp-<projectId> http entry with the web Authorization header (canvas mode)', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.saveMcpServers).mockClear()
    vi.mocked(isTauriContext).mockReturnValue(false)
    webAuthToken.value = 't0ken'
    try {
      // Web ignores the passed token — the web-auth bearer is the credential
      // server-side agent clients present at /canvas/mcp.
      await useAcpStore.getState().upsertCanvasMcpServer('proj-7', '/canvas/mcp', 'managed-ignored')

      expect(useAcpStore.getState().mcpServers).toHaveLength(1)
      expect(useAcpStore.getState().mcpServers[0]).toMatchObject({
        id: 'canvas-mcp-proj-7',
        type: 'http',
        name: 'OpenPencil Canvas',
        url: `${window.location.origin}/canvas/mcp`,
        enabled: true
      })
      expect(useAcpStore.getState().mcpServers[0].headers).toEqual([
        { name: 'Authorization', value: 'Bearer t0ken' }
      ])
      expect(vi.mocked(persistence.saveMcpServers)).toHaveBeenCalledTimes(1)
    } finally {
      vi.mocked(isTauriContext).mockReturnValue(true)
      webAuthToken.value = null
    }
  })

  it('upsertCanvasMcpServer carries the desktop managed token (canvasToken) as the Authorization header', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.saveMcpServers).mockClear()
    // isTauriContext defaults to true (desktop) in this suite.
    await useAcpStore
      .getState()
      .upsertCanvasMcpServer('proj-7', 'http://127.0.0.1:5199/canvas/mcp', 'managed-t0k')

    expect(useAcpStore.getState().mcpServers).toHaveLength(1)
    expect(useAcpStore.getState().mcpServers[0]).toMatchObject({
      id: 'canvas-mcp-proj-7',
      type: 'http',
      name: 'OpenPencil Canvas',
      url: 'http://127.0.0.1:5199/canvas/mcp',
      enabled: true
    })
    expect(useAcpStore.getState().mcpServers[0].headers).toEqual([
      { name: 'Authorization', value: 'Bearer managed-t0k' }
    ])
    expect(vi.mocked(persistence.saveMcpServers)).toHaveBeenCalledTimes(1)
  })

  it('upsertCanvasMcpServer refreshes when the desktop managed token rotates (same URL)', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.saveMcpServers).mockClear()
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'canvas-mcp-proj-7',
          type: 'http',
          name: 'OpenPencil Canvas',
          url: 'http://127.0.0.1:5199/canvas/mcp',
          enabled: true,
          headers: [{ name: 'Authorization', value: 'Bearer managed-old' }]
        }
      ]
    })

    await useAcpStore
      .getState()
      .upsertCanvasMcpServer('proj-7', 'http://127.0.0.1:5199/canvas/mcp', 'managed-new')

    expect(useAcpStore.getState().mcpServers[0].headers).toEqual([
      { name: 'Authorization', value: 'Bearer managed-new' }
    ])
    expect(vi.mocked(persistence.saveMcpServers)).toHaveBeenCalledTimes(1)
  })

  it('upsertCanvasMcpServer on desktop without a token writes no Authorization header', async () => {
    await useAcpStore.getState().upsertCanvasMcpServer('proj-7', 'http://127.0.0.1:5199/canvas/mcp')

    expect(useAcpStore.getState().mcpServers[0].headers).toBeUndefined()
  })

  it('upsertCanvasMcpServer refreshes the URL on re-open while preserving a user-set enabled: false', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    webAuthToken.value = 't0ken'
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'canvas-mcp-proj-7',
          type: 'http',
          name: 'OpenPencil Canvas',
          url: 'http://127.0.0.1:5199/canvas/mcp',
          enabled: false,
          headers: [{ name: 'Authorization', value: 'Bearer t0ken' }]
        }
      ]
    })
    try {
      await useAcpStore
        .getState()
        .upsertCanvasMcpServer('proj-7', 'http://127.0.0.1:5200/canvas/mcp')

      const servers = useAcpStore.getState().mcpServers
      expect(servers).toHaveLength(1)
      expect(servers[0]).toMatchObject({
        id: 'canvas-mcp-proj-7',
        url: 'http://127.0.0.1:5200/canvas/mcp',
        enabled: false
      })
      expect(servers[0].headers).toEqual([{ name: 'Authorization', value: 'Bearer t0ken' }])
    } finally {
      vi.mocked(isTauriContext).mockReturnValue(true)
      webAuthToken.value = null
    }
  })

  it('upsertCanvasMcpServer refreshes the Authorization header when the web token rotates (same URL)', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.saveMcpServers).mockClear()
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'canvas-mcp-proj-7',
          type: 'http',
          name: 'OpenPencil Canvas',
          url: 'http://127.0.0.1:5199/canvas/mcp',
          enabled: true,
          headers: [{ name: 'Authorization', value: 'Bearer old-token' }]
        }
      ]
    })
    vi.mocked(isTauriContext).mockReturnValue(false)
    webAuthToken.value = 'new-token'
    try {
      await useAcpStore
        .getState()
        .upsertCanvasMcpServer('proj-7', 'http://127.0.0.1:5199/canvas/mcp')

      expect(useAcpStore.getState().mcpServers[0].headers).toEqual([
        { name: 'Authorization', value: 'Bearer new-token' }
      ])
      expect(vi.mocked(persistence.saveMcpServers)).toHaveBeenCalledTimes(1)
    } finally {
      vi.mocked(isTauriContext).mockReturnValue(true)
      webAuthToken.value = null
    }
  })

  it('upsertCanvasMcpServer is a no-op write when the URL and Authorization header are unchanged', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.saveMcpServers).mockClear()
    useAcpStore.setState({
      mcpServers: [
        {
          id: 'canvas-mcp-proj-7',
          type: 'http',
          name: 'OpenPencil Canvas',
          url: 'http://127.0.0.1:5199/canvas/mcp',
          enabled: true,
          headers: [{ name: 'Authorization', value: 'Bearer t0ken' }]
        }
      ]
    })
    vi.mocked(isTauriContext).mockReturnValue(false)
    webAuthToken.value = 't0ken'
    try {
      await useAcpStore
        .getState()
        .upsertCanvasMcpServer('proj-7', 'http://127.0.0.1:5199/canvas/mcp')

      expect(vi.mocked(persistence.saveMcpServers)).not.toHaveBeenCalled()
    } finally {
      vi.mocked(isTauriContext).mockReturnValue(true)
      webAuthToken.value = null
    }
  })

  it('upsertCanvasMcpServer rolls back the registry when persistence fails', async () => {
    const persistence = await import('@/lib/acp-mcp-persistence')
    vi.mocked(persistence.saveMcpServers).mockRejectedValueOnce(new Error('disk full'))
    useAcpStore.setState({
      mcpServers: [{ id: 'm0', type: 'stdio', name: 'Existing', command: 'node', enabled: true }]
    })

    await expect(
      useAcpStore.getState().upsertCanvasMcpServer('proj-7', 'http://127.0.0.1:5199/canvas/mcp')
    ).rejects.toThrow('disk full')

    expect(useAcpStore.getState().mcpServers.map((s) => s.id)).toEqual(['m0'])
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp-store.upsertCanvasMcpServer' })
    )
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
})
