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
  _clearPayloadCacheForTesting,
  getCachedSessionPayload,
  setCachedSessionPayload
} from '@/lib/acp-history-persistence'
import { logFrontendError } from '@/lib/log-api'
import { commandToken, fileToken, SKILL_PAD_CHAR, skillToken } from '@/lib/skill-tokens'
import {
  _flushCoalescedForTesting,
  _isCoalescePendingForTesting,
  _resetCoalesceForTesting,
  _resetLoadingOlderForTesting,
  type ChatMessage,
  MAX_LIVE_TOOL_CALLS,
  MAX_LIVE_WINDOW_MESSAGES,
  useAcpStore
} from '@/stores/acp-store'
import { deferred, FRESH, flushTurnEnd, seedSession } from './testkit'

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

  it('(b) cold cache over-limit fires a probe; null result never trims', async () => {
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    const sid = 's-no-cache'
    seedSession(sid, 'agent-1', true)
    // No setCachedSessionPayload — the session's durable copy lives on the
    // host, so the first over-limit flush fires a background probe instead of
    // trimming (nothing is lost while the probe is in flight).
    const liveWindow = buildMessages(310).map((m, i) => (i === 309 ? { ...m, streaming: true } : m))
    useAcpStore.setState({ messages: { [sid]: liveWindow } })
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' more' }
    })
    // Probe resolution is deferred: hold it until the first flush completes.
    const probe = deferred<null>()
    vi.mocked(loadSessionPayload).mockReturnValueOnce(probe.promise as never)
    _flushCoalescedForTesting()
    // While the probe is in flight: no trim — all messages retained.
    expect(useAcpStore.getState().messages[sid].length).toBe(310)
    expect(loadSessionPayload).toHaveBeenCalledWith(sid)

    // Probe resolves null (no durable history / live_only): session marked
    // untrimmable — a boundary warn fires once and every later flush keeps
    // every message (lossless).
    probe.resolve(null)
    await vi.waitFor(() => {
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', source: 'acp.store' })
      )
    })
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' again' }
    })
    _flushCoalescedForTesting()
    expect(useAcpStore.getState().messages[sid].length).toBe(310)
    // The probe does not refire for an untrimmable session.
    expect(loadSessionPayload).toHaveBeenCalledTimes(1)
  })

  it('(b2) probe payload seeds the cache; trim engages on the next flush', async () => {
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    const sid = 's-probe-cache'
    seedSession(sid, 'agent-1', true)
    const fullMessages = buildMessages(310)
    const liveWindow = fullMessages.map((m, i) => (i === 309 ? { ...m, streaming: true } : m))
    useAcpStore.setState({ messages: { [sid]: liveWindow } })
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' x' }
    })
    const payload = { metadata: fakeMetadata(sid, 310), messages: fullMessages }
    const probe = deferred<typeof payload>()
    vi.mocked(loadSessionPayload).mockReturnValueOnce(probe.promise as never)
    _flushCoalescedForTesting()
    // In flight: no trim, no cached payload yet.
    expect(useAcpStore.getState().messages[sid].length).toBe(310)
    probe.resolve(payload)
    await vi.waitFor(() => {
      expect(getCachedSessionPayload(sid)).toBeDefined()
    })
    // Next over-limit flush now trims (the cache holds the durable copy).
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' y' }
    })
    _flushCoalescedForTesting()
    const msgs = useAcpStore.getState().messages[sid]
    expect(msgs.length).toBeLessThanOrEqual(MAX_LIVE_WINDOW_MESSAGES)
    expect(msgs[msgs.length - 1].streaming).toBe(true)
  })

  it('(b3) a rejected probe warns, releases the slot, and re-probes next flush', async () => {
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    const sid = 's-probe-fail'
    seedSession(sid, 'agent-1', true)
    const fullMessages = buildMessages(310)
    const liveWindow = fullMessages.map((m, i) => (i === 309 ? { ...m, streaming: true } : m))
    useAcpStore.setState({ messages: { [sid]: liveWindow } })
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' x' }
    })
    const first = deferred<null>()
    const second = deferred<null>()
    vi.mocked(loadSessionPayload)
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValueOnce(second.promise as never)
    _flushCoalescedForTesting()
    // In flight: no trim.
    expect(useAcpStore.getState().messages[sid].length).toBe(310)

    // The probe rejects (IPC error): warn fires, session is NOT untrimmable.
    first.reject(new Error('ipc down'))
    await flushTurnEnd()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'acp.store',
        message: expect.stringContaining('Durability probe failed')
      })
    )
    // Slot released (finally ran): the next over-limit flush re-probes.
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' y' }
    })
    _flushCoalescedForTesting()
    expect(loadSessionPayload).toHaveBeenCalledTimes(2)
    // Still no trim while the retry is in flight (nothing lost).
    expect(useAcpStore.getState().messages[sid].length).toBe(310)
    // The retry resolving null marks it untrimmable — lossless from here on.
    second.resolve(null)
    await flushTurnEnd()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'acp.store',
        message: expect.stringContaining('no durable history')
      })
    )
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' z' }
    })
    _flushCoalescedForTesting()
    expect(useAcpStore.getState().messages[sid].length).toBe(310)
    expect(loadSessionPayload).toHaveBeenCalledTimes(2)
  })

  it('(f2) install paths cap toolCalls at the live bound (openHistory + resume)', async () => {
    const sid = 's-install-cap'
    // 600 finished calls in the payload — an install must plateau at the cap.
    const manyCalls = Array.from(
      { length: 600 },
      (_, i): ToolCall => ({
        toolCallId: `p-${i}`,
        title: 'read',
        status: 'completed',
        seq: i
      })
    )
    setCachedSessionPayload(sid, {
      metadata: fakeMetadata(sid, 1),
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
      toolCalls: manyCalls
    })
    useAcpStore.setState({
      agents: { 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-1': 'connected' }
    })
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().openHistorySession(sid)
    const installed = useAcpStore.getState().toolCalls[sid]
    expect(installed).toHaveLength(MAX_LIVE_TOOL_CALLS)
    // Oldest finished calls dropped (p-0..p-99 gone, p-100 kept).
    expect(installed.some((c) => c.toolCallId === 'p-99')).toBe(false)
    expect(installed.some((c) => c.toolCallId === 'p-100')).toBe(true)
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

  it('(c2) loadOlderMessages anchors by seq when the head id is absent from the payload', async () => {
    // A tail fold that opened mid-run mints a window-local `snapshot:` id the
    // full payload never contains; the seq anchor must still locate the
    // persisted position so scroll-back keeps working.
    const sid = 's-seq-anchor'
    seedSession(sid, 'agent-1', false)
    const fullMessages = buildMessages(401)
    setCachedSessionPayload(sid, { metadata: fakeMetadata(sid, 401), messages: fullMessages })
    // Live window: head carries a drifted id but a seq inside the persisted
    // domain (152). Anchoring by id misses; seq finds m152 → prepend m102..m151.
    const drifted = { ...fullMessages[152], id: 'snapshot:agent:152-drifted' }
    useAcpStore.setState({ messages: { [sid]: [drifted, ...fullMessages.slice(153)] } })

    await useAcpStore.getState().loadOlderMessages(sid, 50)
    const msgs = useAcpStore.getState().messages[sid]
    expect(msgs[0].id).toBe('m102')
    expect(msgs.length).toBe(299) // 50 prepended + 249 live
    // The drifted head is retained, not duplicated by a persisted twin.
    expect(msgs.filter((m) => m.id === 'snapshot:agent:152-drifted').length).toBe(1)
    expect(msgs.filter((m) => m.id === 'm152').length).toBe(0)

    // Continues loading older pages by id anchor once the head is persisted.
    await useAcpStore.getState().loadOlderMessages(sid, 50)
    expect(useAcpStore.getState().messages[sid][0].id).toBe('m52')

    // A head whose seq precedes every persisted message anchors at index 0 —
    // idempotent, nothing prepended.
    const sid2 = 's-seq-before-head'
    seedSession(sid2, 'agent-1', false)
    setCachedSessionPayload(sid2, {
      metadata: fakeMetadata(sid2, 401),
      messages: fullMessages
    })
    const early = { ...fullMessages[0], id: 'msg-live-only', seq: undefined }
    useAcpStore.setState({ messages: { [sid2]: [early, ...fullMessages.slice(1)] } })
    await useAcpStore.getState().loadOlderMessages(sid2, 50)
    expect(useAcpStore.getState().messages[sid2][0].id).toBe('msg-live-only')
    expect(useAcpStore.getState().messages[sid2].length).toBe(401)
    // The un-anchorable head logs a durable warn instead of silently stalling.
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'acp.loadOlderMessages' })
    )
  })

  it('(c3) loadOlderMessages drops persisted twins of live bubbles instead of duplicating the turn', async () => {
    // The live/persisted id dialects legitimately diverge: the desktop host
    // logs `user:seq-*` for a `turn:*` optimistic prompt and folds live
    // `msg-*` streams into `snapshot:*` bubbles. When the live window's head
    // is such a live-only bubble (a fresh chat's in-flight turn), the id
    // anchor misses and the seq anchor lands at the payload tail (the
    // process-wide seq counter was rebased above the persisted domain by an
    // earlier install). The backfill must fold the durable twins by content
    // instead of prepending the whole turn again.
    const sid = 's-twin-dedup'
    seedSession(sid, 'agent-1', false)
    const persisted: ChatMessage[] = [
      ...buildMessages(4), // m0..m3 — genuinely older history
      {
        id: 'user:seq-10',
        role: 'user',
        blocks: [{ type: 'text', text: 'current prompt' }],
        streaming: false,
        timestamp: 10,
        seq: 10
      },
      {
        id: 'snapshot:agent:11',
        role: 'agent',
        // The durable copy of a still-streaming live bubble can hold more
        // text (the host logged further chunks before the read).
        blocks: [{ type: 'text', text: 'working on it now' }],
        streaming: false,
        timestamp: 11,
        seq: 11
      }
    ]
    setCachedSessionPayload(sid, { metadata: fakeMetadata(sid, 6), messages: persisted })
    useAcpStore.setState({
      messages: {
        [sid]: [
          {
            id: 'turn:live-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'current prompt' }],
            streaming: false,
            timestamp: 0,
            seq: 900
          },
          {
            id: 'msg-live-1',
            role: 'agent',
            blocks: [{ type: 'text', text: 'working on it' }],
            streaming: true,
            timestamp: 0,
            seq: 901
          }
        ]
      }
    })

    await useAcpStore.getState().loadOlderMessages(sid, 50)
    const messages = useAcpStore.getState().messages[sid]
    // Older history prepends; the current turn renders exactly once.
    expect(messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'turn:live-1', 'msg-live-1'])
  })

  it('(c3b) twin folding canonicalizes display tokens: a padded skill-pill prompt does not double', async () => {
    // Launch-path regression: the optimistic user bubble holds DISPLAY text
    // (skill token + caret-alignment padding block + the splicer's trailing
    // space), while the durable `user_prompt` record holds the trimmed WIRE
    // framing. `normalizeUserMessageBlocks` reconstructs display tokens on
    // the way in — without padding — so the raw texts never match. The twin
    // compare must canonicalize both sides or scroll-up re-renders the first
    // prompt above its live copy.
    const sid = 's-twin-skill'
    seedSession(sid, 'agent-1', false)
    const persisted: ChatMessage[] = [
      {
        id: 'user:seq-1',
        role: 'user',
        // WIRE text, exactly as the host-persisted record materializes:
        // command prefix + framed skill header + `(name)` marker, trimmed.
        blocks: [
          {
            type: 'text',
            text: '/bmad-build # Agent Skills\n\nfix-repo: /skills/fix-repo.md\n\n---\n\n(fix-repo) do the thing'
          }
        ],
        streaming: false,
        timestamp: 1,
        seq: 1
      },
      {
        id: 'snapshot:agent:2',
        role: 'agent',
        blocks: [{ type: 'text', text: 'done' }],
        streaming: false,
        timestamp: 2,
        seq: 2
      }
    ]
    setCachedSessionPayload(sid, { metadata: fakeMetadata(sid, 2), messages: persisted })
    useAcpStore.setState({
      messages: {
        [sid]: [
          {
            id: 'turn:live-1',
            role: 'user',
            // DISPLAY text as seeded by the launcher: command token + skill
            // token carrying the figure-space padding block + trailing space.
            blocks: [
              {
                type: 'text',
                text: `${commandToken('bmad-build')} ${skillToken('fix-repo', SKILL_PAD_CHAR.repeat(3))} do the thing `
              }
            ],
            streaming: false,
            timestamp: 0,
            seq: 900
          },
          {
            id: 'msg-live-1',
            role: 'agent',
            blocks: [{ type: 'text', text: 'done' }],
            streaming: false,
            timestamp: 0,
            seq: 901
          }
        ]
      }
    })

    await useAcpStore.getState().loadOlderMessages(sid, 50)
    const messages = useAcpStore.getState().messages[sid]
    expect(messages.map((m) => m.id)).toEqual(['turn:live-1', 'msg-live-1'])
  })

  it('(c3c) twin folding keeps chip markers distinct from literal text: a `(name)` prompt does not swallow a persisted skill-chip prompt', async () => {
    // The canonical compare reduces both dialects to token text — but a
    // persisted `(name)` that came from a real chip reconstructs to
    // `\uE000…\uE001` sentinels while a literally-typed `(name)` stays plain
    // text. Equating the two would silently drop the distinct persisted
    // prompt during backfill (CodeRabbit review on PR #751).
    const sid = 's-twin-literal-skill'
    seedSession(sid, 'agent-1', false)
    const persisted: ChatMessage[] = [
      ...buildMessages(2), // m0..m1 — genuinely older history
      {
        id: 'user:seq-10',
        role: 'user',
        // A real chip prompt as it materializes from the wire record —
        // `normalizeUserMessageBlocks` will rebuild `\uE000fix-repo\uE001`.
        blocks: [
          {
            type: 'text',
            text: '# Agent Skills\n\nfix-repo: /skills/fix-repo.md\n\n---\n\n(fix-repo) do the thing'
          }
        ],
        streaming: false,
        timestamp: 10,
        seq: 10
      },
      {
        id: 'snapshot:agent:11',
        role: 'agent',
        blocks: [{ type: 'text', text: 'done' }],
        streaming: false,
        timestamp: 11,
        seq: 11
      }
    ]
    setCachedSessionPayload(sid, { metadata: fakeMetadata(sid, 4), messages: persisted })
    useAcpStore.setState({
      messages: {
        [sid]: [
          {
            id: 'turn:live-1',
            role: 'user',
            // The user literally typed `(fix-repo) do the thing` — no tokens.
            blocks: [{ type: 'text', text: '(fix-repo) do the thing' }],
            streaming: false,
            timestamp: 0,
            seq: 900
          },
          {
            id: 'msg-live-1',
            role: 'agent',
            blocks: [{ type: 'text', text: 'working' }],
            streaming: true,
            timestamp: 0,
            seq: 901
          }
        ]
      }
    })

    await useAcpStore.getState().loadOlderMessages(sid, 50)
    const messages = useAcpStore.getState().messages[sid]
    // The persisted chip prompt is a DIFFERENT message — it must survive.
    expect(messages.map((m) => m.id)).toEqual([
      'm0',
      'm1',
      'user:seq-10',
      'turn:live-1',
      'msg-live-1'
    ])
  })

  it('(c3d) twin folding checks file evidence: a `(display)` collision with a resource_link prompt is kept, a real file-pill twin is folded', async () => {
    // File chips never round-trip — the wire carries `(display)` text + a
    // `resource_link` block — so canonical text alone cannot distinguish the
    // chip from literal `(display)` text. The evidence check requires the
    // persisted resource block iff the live text carries the `\uE006` token.
    const sid = 's-twin-file-evidence'
    seedSession(sid, 'agent-1', false)
    const persisted: ChatMessage[] = [
      ...buildMessages(2), // m0..m1 — genuinely older history
      {
        id: 'user:seq-10',
        role: 'user',
        blocks: [
          { type: 'text', text: 'check (report.pdf)' },
          {
            type: 'resource_link',
            uri: 'file:///abs/report.pdf',
            name: 'report.pdf',
            mimeType: 'application/pdf'
          }
        ],
        streaming: false,
        timestamp: 10,
        seq: 10
      },
      {
        id: 'snapshot:agent:11',
        role: 'agent',
        blocks: [{ type: 'text', text: 'done' }],
        streaming: false,
        timestamp: 11,
        seq: 11
      }
    ]
    setCachedSessionPayload(sid, { metadata: fakeMetadata(sid, 4), messages: persisted })
    useAcpStore.setState({
      messages: {
        [sid]: [
          {
            id: 'turn:live-1',
            role: 'user',
            // Literally-typed `check (report.pdf)` — no file token.
            blocks: [{ type: 'text', text: 'check (report.pdf)' }],
            streaming: false,
            timestamp: 0,
            seq: 900
          }
        ]
      }
    })

    await useAcpStore.getState().loadOlderMessages(sid, 50)
    // Distinct message — the file-pill record must not be swallowed.
    expect(useAcpStore.getState().messages[sid].map((m) => m.id)).toEqual([
      'm0',
      'm1',
      'user:seq-10',
      'turn:live-1'
    ])

    // …but the same persisted record DOES fold against a real file-pill twin
    // (live `\uE006` token ↔ persisted resource_link evidence match).
    const sid2 = 's-twin-file-fold'
    seedSession(sid2, 'agent-1', false)
    setCachedSessionPayload(sid2, { metadata: fakeMetadata(sid2, 4), messages: persisted })
    useAcpStore.setState({
      messages: {
        [sid2]: [
          {
            id: 'turn:live-1',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text: `check ${fileToken('report.pdf', '/abs/report.pdf')}`
              }
            ],
            streaming: false,
            timestamp: 0,
            seq: 900
          }
        ]
      }
    })

    await useAcpStore.getState().loadOlderMessages(sid2, 50)
    expect(useAcpStore.getState().messages[sid2].map((m) => m.id)).toEqual([
      'm0',
      'm1',
      'turn:live-1'
    ])
  })

  it('(c4) twin folding is count-bounded: a repeated identical prompt keeps its older copy', async () => {
    // The user sent the same prompt twice — the persisted copy adjacent to
    // the live seam is the live bubble's twin, but the identical older copy
    // is real history and must survive.
    const sid = 's-twin-repeat'
    seedSession(sid, 'agent-1', false)
    const persisted: ChatMessage[] = [
      {
        id: 'user:seq-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'repeat me' }],
        streaming: false,
        timestamp: 1,
        seq: 1
      },
      {
        id: 'snapshot:agent:2',
        role: 'agent',
        blocks: [{ type: 'text', text: 'first answer' }],
        streaming: false,
        timestamp: 2,
        seq: 2
      },
      {
        id: 'user:seq-10',
        role: 'user',
        blocks: [{ type: 'text', text: 'repeat me' }],
        streaming: false,
        timestamp: 10,
        seq: 10
      },
      {
        id: 'snapshot:agent:11',
        role: 'agent',
        blocks: [{ type: 'text', text: 'second answer' }],
        streaming: false,
        timestamp: 11,
        seq: 11
      }
    ]
    setCachedSessionPayload(sid, { metadata: fakeMetadata(sid, 4), messages: persisted })
    useAcpStore.setState({
      messages: {
        [sid]: [
          {
            id: 'turn:live-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'repeat me' }],
            streaming: false,
            timestamp: 0,
            seq: 900
          },
          {
            id: 'msg-live-1',
            role: 'agent',
            blocks: [{ type: 'text', text: 'second answer' }],
            streaming: false,
            timestamp: 0,
            seq: 901
          }
        ]
      }
    })

    await useAcpStore.getState().loadOlderMessages(sid, 50)
    const messages = useAcpStore.getState().messages[sid]
    expect(messages.map((m) => m.id)).toEqual([
      'user:seq-1',
      'snapshot:agent:2',
      'turn:live-1',
      'msg-live-1'
    ])
  })

  it('(c5) streaming-prefix fold stays near the seam: a prefix-superset deep in history survives', async () => {
    // A short streaming live text ("OK") is a prefix of an unrelated older
    // persisted message ("OK, checking the logs"). That deep record is NOT
    // the live bubble's twin — the prefix rule must only apply near the
    // recent-end seam, or backfill silently drops real history.
    const sid = 's-twin-prefix-seam'
    seedSession(sid, 'agent-1', false)
    const persisted: ChatMessage[] = [
      {
        id: 'user:seq-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'first question' }],
        streaming: false,
        timestamp: 1,
        seq: 1
      },
      {
        id: 'snapshot:agent:2',
        role: 'agent',
        blocks: [{ type: 'text', text: 'OK, checking the logs' }],
        streaming: false,
        timestamp: 2,
        seq: 2
      },
      {
        id: 'user:seq-10',
        role: 'user',
        blocks: [{ type: 'text', text: 'current prompt' }],
        streaming: false,
        timestamp: 10,
        seq: 10
      },
      {
        id: 'snapshot:agent:11',
        role: 'agent',
        blocks: [{ type: 'text', text: 'OK let me look' }],
        streaming: false,
        timestamp: 11,
        seq: 11
      }
    ]
    setCachedSessionPayload(sid, { metadata: fakeMetadata(sid, 4), messages: persisted })
    useAcpStore.setState({
      messages: {
        [sid]: [
          {
            id: 'turn:live-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'current prompt' }],
            streaming: false,
            timestamp: 0,
            seq: 900
          },
          {
            id: 'msg-live-1',
            role: 'agent',
            blocks: [{ type: 'text', text: 'OK' }],
            streaming: true,
            timestamp: 0,
            seq: 901
          }
        ]
      }
    })

    await useAcpStore.getState().loadOlderMessages(sid, 50)
    const messages = useAcpStore.getState().messages[sid]
    // The seam-adjacent snapshot:agent:11 folds into the streaming "OK"
    // bubble; the deep "OK, checking the logs" prefix-superset stays.
    expect(messages.map((m) => m.id)).toEqual([
      'user:seq-1',
      'snapshot:agent:2',
      'turn:live-1',
      'msg-live-1'
    ])
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

  it('(f) toolCalls plateau at the live cap while retaining in-flight calls', () => {
    const sid = 's-tools-cap'
    seedSession(sid, 'agent-1', true)
    // 600 finished calls + one in-flight call at the tail.
    const finished = Array.from(
      { length: 600 },
      (_, i): ToolCall => ({
        toolCallId: `fin-${i}`,
        title: 'done',
        status: 'completed',
        seq: i
      })
    )
    const inFlight: ToolCall = { toolCallId: 'live-1', status: 'in_progress', seq: 600 }
    useAcpStore.setState({ toolCalls: { [sid]: [...finished, inFlight] } })
    // Push a live update through the coalesced path; flush triggers the cap.
    useAcpStore.getState()._onToolCallUpdate({
      agentId: 'agent-1',
      sessionId: sid,
      update: { toolCallId: 'live-1', status: 'in_progress' }
    })
    _flushCoalescedForTesting()
    const calls = useAcpStore.getState().toolCalls[sid]
    // Live array plateaus at the cap; the in-flight call is always retained.
    expect(calls).toHaveLength(MAX_LIVE_TOOL_CALLS)
    expect(calls.some((c) => c.toolCallId === 'live-1')).toBe(true)
    // Oldest finished calls dropped first: 601 calls drop 101 finished
    // (fin-0..fin-100 gone, fin-101 kept).
    expect(calls.some((c) => c.toolCallId === 'fin-100')).toBe(false)
    expect(calls.some((c) => c.toolCallId === 'fin-101')).toBe(true)
  })

  it('(f2) a late tool update for a trimmed-out call is a no-op (no window re-growth)', () => {
    const sid = 's-late-update'
    seedSession(sid, 'agent-1', true)
    // 500 finished calls at the cap; fin-0 is the first to be trimmed.
    const finished = Array.from(
      { length: 500 },
      (_, i): ToolCall => ({ toolCallId: `fin-${i}`, status: 'completed', seq: i })
    )
    useAcpStore.setState({ toolCalls: { [sid]: finished } })
    // Push one more finished call; the flush trims fin-0 out.
    useAcpStore.getState()._onToolCall({
      agentId: 'agent-1',
      sessionId: sid,
      toolCall: { toolCallId: 'fin-500', status: 'completed', seq: 500 }
    })
    _flushCoalescedForTesting()
    const afterTrim = useAcpStore.getState().toolCalls[sid]
    expect(afterTrim).toHaveLength(MAX_LIVE_TOOL_CALLS)
    expect(afterTrim.some((c) => c.toolCallId === 'fin-0')).toBe(false)

    // A late update targets the trimmed-out fin-0: idx === -1 → no-op. The
    // call is not resurrected and the window never grows past the cap.
    useAcpStore.getState()._onToolCallUpdate({
      agentId: 'agent-1',
      sessionId: sid,
      update: { toolCallId: 'fin-0', status: 'failed', rawOutput: 'late' }
    })
    _flushCoalescedForTesting()
    const calls = useAcpStore.getState().toolCalls[sid]
    expect(calls).toHaveLength(MAX_LIVE_TOOL_CALLS)
    expect(calls.some((c) => c.toolCallId === 'fin-0')).toBe(false)
  })

  it('(g) oversized string rawOutput clamps to 32 KiB + marker, logged without content', () => {
    const sid = 's-clamp'
    seedSession(sid, 'agent-1', true)
    useAcpStore.setState({
      toolCalls: { [sid]: [{ toolCallId: 'big-1', status: 'in_progress' }] }
    })
    const bigOutput = 'x'.repeat(32 * 1024 + 500)
    useAcpStore.getState()._onToolCallUpdate({
      agentId: 'agent-1',
      sessionId: sid,
      update: { toolCallId: 'big-1', status: 'in_progress', rawOutput: bigOutput }
    })
    _flushCoalescedForTesting()
    const stored = useAcpStore.getState().toolCalls[sid][0]
    const text = stored.rawOutput as string
    expect(text.length).toBe(32 * 1024 + '\n[termul: tool output truncated]'.length)
    expect(text.endsWith('\n[termul: tool output truncated]')).toBe(true)
    expect(text.startsWith('x'.repeat(100))).toBe(true)
    // Clamp is logged once at warn level without the content.
    const clampCalls = vi
      .mocked(logFrontendError)
      .mock.calls.filter((c) => c[0]?.message?.includes('Clamped tool rawOutput'))
    expect(clampCalls).toHaveLength(1)
    expect(clampCalls[0]?.[0]?.level).toBe('warn')
    expect(clampCalls[0]?.[0]?.message).not.toContain('xxxx')
  })

  it('(h) delta merge: one flush of a chunk burst equals sequential appends', () => {
    const sidBurst = 's-burst'
    const sidSeq = 's-sequential'
    seedSession(sidBurst, 'agent-1', true)
    // seedSession replaces the maps — merge the second session in instead.
    const burstSession = useAcpStore.getState().sessions[sidBurst]
    seedSession(sidSeq, 'agent-1', true)
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, [sidBurst]: burstSession },
      messages: { ...s.messages, [sidBurst]: [] }
    }))
    const chunks = ['Hello, ', 'world', '! ', 'How ', 'are ', 'you?']
    // Burst: all chunks buffered, one flush applies them in order.
    for (const text of chunks) {
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: sidBurst,
        role: 'agent',
        content: { type: 'text', text }
      })
    }
    _flushCoalescedForTesting()
    // Sequential: one chunk per flush (the eager baseline).
    for (const text of chunks) {
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: sidSeq,
        role: 'agent',
        content: { type: 'text', text }
      })
      _flushCoalescedForTesting()
    }
    const burst = useAcpStore.getState().messages[sidBurst]
    const seq = useAcpStore.getState().messages[sidSeq]
    expect(burst).toHaveLength(1)
    expect(seq).toHaveLength(1)
    // Byte-identical blocks: one merged text block with the joined text.
    expect(burst[0].blocks).toEqual(seq[0].blocks)
    expect(burst[0].blocks).toEqual([{ type: 'text', text: chunks.join('') }])
  })

  it('(i) reopening a still-streamming session tail-installs and gap-replays cleanly', async () => {
    const sid = 's-reopen-stream'
    // Durable host history: user prompt + agent reply (the last one mid-turn).
    setCachedSessionPayload(sid, {
      metadata: fakeMetadata(sid, 2),
      messages: [
        {
          id: 'u1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hi' }],
          streaming: false,
          timestamp: 0,
          seq: 1
        },
        {
          id: 'a1',
          role: 'agent',
          blocks: [{ type: 'text', text: 'partial ' }],
          streaming: true,
          timestamp: 1,
          seq: 2
        }
      ]
    })
    // resumeLiveSession: tail-first install, then resume; chunks that
    // streamed during the fetch window must APPEND via gap replay.
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd !== 'acp_resume_session') {
        throw new Error(`unexpected invoke command in reopen-streaming test: ${cmd}`)
      }
      // Chunks arrive mid-resume: the replay window is 'streaming', so they
      // append to the restored tail instead of replacing it.
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: sid,
        role: 'agent',
        content: { type: 'text', text: 'gap ' }
      })
      useAcpStore.getState()._onMessageChunk({
        agentId: 'agent-1',
        sessionId: sid,
        role: 'agent',
        content: { type: 'text', text: 'replayed' }
      })
      return undefined
    })
    await useAcpStore.getState().resumeLiveSession(sid, 'agent-1', '/work')
    _flushCoalescedForTesting()
    const msgs = useAcpStore.getState().messages[sid]
    // No blank, no truncation: the tail-first install kept both restored
    // messages and the gap-replayed chunks appended onto the streaming tail.
    expect(msgs).toHaveLength(2)
    expect(msgs[0].id).toBe('u1')
    expect(msgs[1].id).toBe('a1')
    expect(msgs[1].streaming).toBe(false)
    // The restored tail's text carries the gap-replayed deltas — no gap
    // (dropped chunk) and no duplicate (re-rendered bubble).
    expect(msgs[1].blocks).toEqual([{ type: 'text', text: 'partial gap replayed' }])
    // The resume window closed: the session is live again and later chunks
    // coalesce normally.
    expect(useAcpStore.getState().sessions[sid].status).toBe('active')
    expect(useAcpStore.getState().sessions[sid].replaying).toBeNull()
  })

  it('(j) probe resolving after the session dropped pins nothing', async () => {
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    const sid = 's-probe-race'
    seedSession(sid, 'agent-1', true)
    const fullMessages = buildMessages(310)
    const liveWindow = fullMessages.map((m, i) => (i === 309 ? { ...m, streaming: true } : m))
    useAcpStore.setState({ messages: { [sid]: liveWindow } })
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: sid,
      role: 'agent',
      content: { type: 'text', text: ' x' }
    })
    const payload = { metadata: fakeMetadata(sid, 310), messages: fullMessages }
    const probe = deferred<typeof payload>()
    vi.mocked(loadSessionPayload).mockReturnValueOnce(probe.promise as never)
    _flushCoalescedForTesting()
    // Session dropped (close/delete) BEFORE the probe resolves.
    vi.mocked(invoke).mockResolvedValue(undefined)
    await useAcpStore.getState().closeSession(sid)
    expect(useAcpStore.getState().messages[sid]).toBeUndefined()
    // The probe resolves late. Drain the microtask chain (then/finally) so
    // the guard's skip decision has actually executed before asserting.
    probe.resolve(payload)
    await flushTurnEnd()
    // Cache seeding was skipped: no pin resurrection, cache stays empty.
    expect(getCachedSessionPayload(sid)).toBeUndefined()
    // No boundary/untrimmable log fired for the dropped session.
    const storeLogs = vi
      .mocked(logFrontendError)
      .mock.calls.filter((c) => c[0]?.source === 'acp.store')
    expect(storeLogs).toHaveLength(0)
  })
})
