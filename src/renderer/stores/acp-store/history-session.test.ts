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
import { setCachedSessionPayload } from '@/lib/acp-history-persistence'
import { _resetAcpTransportForTests } from '@/lib/acp-transport'
import {
  _flushCoalescedForTesting,
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  agentReuseKey,
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
        },
        {
          id: 'm2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'done' }],
          streaming: false,
          timestamp: 1,
          seq: 2
        }
      ],
      toolCalls: [{ toolCallId: 'tc-9', kind: 'read', status: 'completed', timestamp: 5, seq: 3 }]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({})
    await useAcpStore.getState().resumeLiveSession('s-resume', 'agent-r', '/w')
    expect(invoke).toHaveBeenCalledWith('acp_resume_session', {
      agentId: 'agent-r',
      sessionId: 's-resume',
      cwd: '/w'
    })
    expect(useAcpStore.getState().toolCalls['s-resume']).toEqual([
      expect.objectContaining({ toolCallId: 'tc-9', seq: 3 })
    ])
    expect(useAcpStore.getState().sessions['s-resume'].status).toBe('active')
    // The seq rebase must fold in tool-call seqs (the messages carried only
    // seqs 1–2; the restored tool card holds seq 3): the next live event must
    // sort AFTER the restored tool card, or buildTimeline would render fresh
    // content ahead of older history.
    useAcpStore.getState()._onToolCall({
      agentId: 'agent-r',
      sessionId: 's-resume',
      toolCall: { toolCallId: 'tc-live', kind: 'read', status: 'pending' }
    })
    _flushCoalescedForTesting()
    const restored = useAcpStore.getState().toolCalls['s-resume']
    const liveCall = restored.find((t) => t.toolCallId === 'tc-live')!
    expect(liveCall.seq!).toBeGreaterThan(3)
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
        },
        {
          id: 'm2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'done' }],
          streaming: false,
          timestamp: 1,
          seq: 2
        }
      ],
      toolCalls: [{ toolCallId: 'tc-f', kind: 'edit', status: 'completed', timestamp: 5, seq: 2 }]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('agent gone'))
    await expect(
      useAcpStore.getState().resumeLiveSession('s-resume-fail', 'agent-r', '/w')
    ).rejects.toBeDefined()
    expect(useAcpStore.getState().messages['s-resume-fail']).toHaveLength(2)
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
})
