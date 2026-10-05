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
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport
} from '@/lib/acp-transport'
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

  it('splits agent chunks when messageId changes and merges equal ids', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'one ' },
      messageId: 'msg-a'
    })
    _flushCoalescedForTesting()
    // Close the streaming tail so the equal-id merge cannot pass on the
    // streaming heuristic. Removing the sameMessageId branch fails this test.
    useAcpStore.setState((s) => {
      const list = s.messages['s1'] ?? []
      const last = list[list.length - 1]
      if (!last) return {}
      return {
        messages: { ...s.messages, s1: [...list.slice(0, -1), { ...last, streaming: false }] }
      }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'two' },
      messageId: 'msg-a'
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'next' },
      messageId: 'msg-b'
    })
    _flushCoalescedForTesting()
    const msgs = useAcpStore.getState().messages['s1'].filter((m) => m.role === 'agent')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].messageId).toBe('msg-a')
    expect(msgs[0].blocks[0]).toEqual({ type: 'text', text: 'one two' })
    expect(msgs[1].messageId).toBe('msg-b')
    expect(msgs[1].blocks[0]).toEqual({ type: 'text', text: 'next' })
  })

  it('does not heuristic-merge a tagged chunk into an untagged bubble', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'plain' }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'tagged' },
      messageId: 'msg-a'
    })
    _flushCoalescedForTesting()
    const agent = useAcpStore.getState().messages['s1'].filter((m) => m.role === 'agent')
    expect(agent).toHaveLength(2)
    expect(agent[0].messageId).toBeUndefined()
    expect(agent[1].messageId).toBe('msg-a')
    expect(agent[1].blocks[0]).toEqual({ type: 'text', text: 'tagged' })
  })

  it('does not merge a later chunk into the pre-tool bubble when the messageId matches', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'before' },
      messageId: 'msg-a'
    })
    _flushCoalescedForTesting()
    const before = useAcpStore.getState().messages['s1'].find((m) => m.role === 'agent')
    useAcpStore.setState((s) => ({
      toolCalls: {
        ...s.toolCalls,
        s1: [
          {
            toolCallId: 'tc-1',
            status: 'completed',
            title: 'Read',
            seq: (before?.seq ?? 0) + 1
          }
        ]
      }
    }))
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'after' },
      messageId: 'msg-a'
    })
    _flushCoalescedForTesting()
    const agent = useAcpStore.getState().messages['s1'].filter((m) => m.role === 'agent')
    expect(agent.map((m) => m.blocks[0])).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' }
    ])
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

  // CAP-2 (spec-in-chat-agent-switch): live `acp:agent_switch` markers.
  const switchEvent = (overrides: Record<string, string> = {}) => ({
    agentId: 'agent-1',
    sessionId: 's1',
    fromConfigId: 'omp',
    toConfigId: 'claude',
    newSessionId: 's2',
    summaryText: 'Handoff summary',
    ...overrides
  })

  it('_onAgentSwitch dedups same-seq re-emissions: one entry, latest fields win', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onAgentSwitch(switchEvent(), 9)
    expect(useAcpStore.getState().agentSwitches['s1']).toHaveLength(1)
    const original = useAcpStore.getState().agentSwitches['s1'][0]
    expect(original.id).toBe('switch:seq-9')
    expect(original.seq).toBe(9)

    // Same eventSeq + updated summary → upsert, not append.
    store._onAgentSwitch(switchEvent({ summaryText: 'Updated summary' }), 9)
    const list = useAcpStore.getState().agentSwitches['s1']
    expect(list).toHaveLength(1)
    expect(list[0].summaryText).toBe('Updated summary')
    // The durable id/seq + arrival timestamp are preserved (no jump).
    expect(list[0].id).toBe('switch:seq-9')
    expect(list[0].seq).toBe(9)
    expect(list[0].timestamp).toBe(original.timestamp)
  })

  it('_onAgentSwitch drops events at or below the installed history watermark', async () => {
    // A payload install records the authoritative watermark; live replays at
    // or below it are the CAP-3 replay contract's responsibility to drop.
    const id = 's-wm'
    setCachedSessionPayload(id, {
      metadata: {
        id,
        agentId: 'agent-1',
        title: 'Chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        lastSeq: 20,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        },
        {
          id: 'snapshot:agent:2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'reply' }],
          streaming: false,
          timestamp: 2,
          seq: 2
        }
      ] as never
    })
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession: vi.fn(async () => ({})),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agents: { 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-1': 'connected' }
    })
    await useAcpStore.getState().openHistorySession(id)
    // The payload install recorded seq 20 (metadata.lastSeq) — an event at
    // or below it is a replay the payload already covers: dropped.
    useAcpStore.getState()._onAgentSwitch({ ...switchEvent(), sessionId: 's-wm' }, 9)
    expect(useAcpStore.getState().agentSwitches['s-wm']).toHaveLength(0)
  })

  it('openHistorySession installs payload switches into agentSwitches (reopen)', async () => {
    const id = 's-reopen'
    setCachedSessionPayload(id, {
      metadata: {
        id,
        agentId: 'agent-1',
        title: 'Chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 3,
        lastSeq: 6,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        },
        {
          id: 'snapshot:agent:2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'old agent reply' }],
          streaming: false,
          timestamp: 2,
          seq: 2
        },
        {
          id: 'snapshot:agent:5',
          role: 'agent',
          blocks: [{ type: 'text', text: 'new agent reply' }],
          streaming: false,
          timestamp: 5,
          seq: 5
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-3',
          fromConfigId: 'omp',
          toConfigId: 'claude',
          newSessionId: 's2',
          summaryText: 'Handoff summary',
          timestamp: 3,
          seq: 3
        }
      ]
    })
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession: vi.fn(async () => ({})),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agents: { 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-1': 'connected' }
    })
    await useAcpStore.getState().openHistorySession(id)
    const installed = useAcpStore.getState().agentSwitches[id]
    expect(installed).toHaveLength(1)
    expect(installed[0].id).toBe('switch:seq-3')
    expect(installed[0].fromConfigId).toBe('omp')
    expect(installed[0].toConfigId).toBe('claude')
    expect(installed[0].newSessionId).toBe('s2')
    expect(installed[0].summaryText).toBe('Handoff summary')
    expect(installed[0].seq).toBe(3)
  })

  it('_onAgentSwitch drops events for closed or nonexistent sessions', () => {
    seedSession('s-closed', 'agent-1')
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-closed': { ...s.sessions['s-closed']!, status: 'closed', replaying: null }
      }
    }))
    useAcpStore.getState()._onAgentSwitch({ ...switchEvent(), sessionId: 's-closed' }, 1)
    expect(useAcpStore.getState().agentSwitches['s-closed']).toBeUndefined()

    useAcpStore.getState()._onAgentSwitch({ ...switchEvent(), sessionId: 's-unknown' }, 1)
    expect(useAcpStore.getState().agentSwitches['s-unknown']).toBeUndefined()
  })

  it('_onAgentSwitch upserts by content when a live re-emission carries a new seq (reconnect regression)', () => {
    seedSession('s1', 'agent-1')
    // A payload-installed entry (durable id/seq from the host fold)…
    useAcpStore.setState({
      agentSwitches: {
        s1: [
          {
            id: 'switch:seq-7',
            fromConfigId: 'omp',
            toConfigId: 'claude',
            newSessionId: 's2',
            summaryText: 'Handoff summary',
            timestamp: 1_000,
            seq: 7
          }
        ]
      }
    })
    // …and the live re-emission after a reload resubscribes: assign_and_append
    // stamped a NEW relay seq (8), so the fabricated id differs. The content
    // (toConfigId + newSessionId + summaryText) identifies the same switch.
    useAcpStore.getState()._onAgentSwitch(switchEvent(), 8)
    const list = useAcpStore.getState().agentSwitches['s1']
    expect(list).toHaveLength(1)
    // One entry, and it keeps the payload-installed durable id/seq.
    expect(list[0].id).toBe('switch:seq-7')
    expect(list[0].seq).toBe(7)
    expect(list[0].timestamp).toBe(1_000)
    // A genuinely different switch (different content) still appends.
    useAcpStore
      .getState()
      ._onAgentSwitch(switchEvent({ toConfigId: 'cursor', newSessionId: 's3' }), 9)
    expect(useAcpStore.getState().agentSwitches['s1']).toHaveLength(2)
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
})
