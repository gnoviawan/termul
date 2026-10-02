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
  setCachedSessionPayload
} from '@/lib/acp-history-persistence'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport
} from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { detachedReuseKey } from '@/stores/acp-reuse-keys'
import {
  _addEphemeralSessionIdForTesting,
  _flushCoalescedForTesting,
  _handoffOnlyTurnIdsForTesting,
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  agentReuseKey,
  MAX_LIVE_WINDOW_MESSAGES,
  prepareChatKey,
  useAcpStore
} from '@/stores/acp-store'
import {
  FRESH,
  flushTurnEnd,
  makeConfigOption,
  makeMode,
  makeModel,
  seedOptionsSession,
  seedSession
} from './testkit'

// --- Story 3 (spec-in-chat-agent-switch): switchAgent orchestration --------

describe('switchAgent (story 3)', () => {
  /** Read one field off a command's recorded invoke payloads. The field read
   * goes through a runtime narrowing guard (never an unchecked cast — the
   * guard proves the field exists first) and each value is type-guarded by
   * the caller-provided predicate. */
  const invokeArgField = <T>(
    command: string,
    field: string,
    isValue: (v: unknown) => v is T
  ): T[] =>
    vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === command)
      .map((c) => {
        const args = c[1]
        if (args && typeof args === 'object' && field in args) {
          return (args as Record<string, unknown>)[field]
        }
        return undefined
      })
      .filter((v): v is T => isValue(v))

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
    _resetSessionIndexLoadGenerationForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetLiveSwitchSourcesForTesting()
    useAcpStore.setState(FRESH)
    workspaceStateRef.current = {
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    }
    // Two configs (old + new) and a live old session whose agent is bound to
    // the canonical reuse key so `configIdForAgentId` resolves `cfg-old`.
    useAcpStore.setState({
      agentConfigs: [
        { id: 'cfg-old', name: 'Gemini', command: 'gemini', args: [], env: {} },
        { id: 'cfg-new', name: 'Claude', command: 'claude', args: [], env: {} }
      ],
      configToLiveAgent: { [agentReuseKey('cfg-old', '/work')]: 'agent-old' },
      agents: { 'agent-old': { id: 'agent-old', capabilities: {} } },
      agentStatus: { 'agent-old': 'connected' }
    })
    seedSession('s-old', 'agent-old', false)
    // The old session carries an index entry (a real created session is
    // persisted on creation) — the ordered-agent cache appends onto it.
    useAcpStore.setState({
      sessionIndex: [
        {
          id: 's-old',
          agentId: 'agent-old',
          agentConfigId: 'cfg-old',
          title: 'Old chat',
          cwd: '/work',
          projectId: 'p1',
          createdAt: 1,
          lastActivityAt: 2,
          messageCount: 0,
          lastSeq: 0,
          status: 'active'
        }
      ]
    })
    // A visible tab for the old session so the guarded remap fires.
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-s-old',
      tabs: [{ type: 'agent-chat', id: 'chat-s-old', sessionId: 's-old' }]
    }
  })

  /** Standard invoke mocks for a successful switch: spawn + new-session + send. */
  function mockHappyPathInvoke(): void {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-new', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 's-new' }
      if (command === 'acp_send_prompt') return 'end_turn'
      if (command === 'acp_record_agent_switch') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })
  }

  it('HAPPY_PATH: arms, sends, and lands the conversation on the new agent/session', async () => {
    mockHappyPathInvoke()
    // A pre-existing transcript so the handoff summary is non-trivial.
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'fix the bug' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          },
          {
            id: 'm2',
            role: 'agent',
            blocks: [{ type: 'text', text: 'fixed it' }],
            streaming: false,
            timestamp: 2,
            seq: 2
          }
        ] as never
      }
    })

    const armed = await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    expect(armed).toBe(true)
    expect(useAcpStore.getState().sessions['s-old'].switching).toEqual({
      toConfigId: 'cfg-new',
      status: 'pending'
    })

    await useAcpStore.getState().sendPrompt('s-old', 'and add a test')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The handoff prompt reached the NEW session: summary + draft as two
    // wire blocks → the blocks transport path (`content` array).
    const send = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === 'acp_send_prompt')
      .map(
        (c) =>
          c[1] as {
            agentId: string
            sessionId: string
            content: Array<{ type: string; text: string }>
            // spec-agent-switch-separator-redesign: the durable record gets
            // the draft, not the wire framing.
            displayContent?: Array<{ type: string; text: string }>
          }
      )
    expect(send).toHaveLength(1)
    expect(send[0].agentId).toBe('agent-new')
    expect(send[0].sessionId).toBe('s-new')
    const wireText = send[0].content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    expect(wireText).toContain('taking over a conversation previously handled by Gemini')
    expect(wireText).toContain('and add a test')
    // displayContent carries ONLY the draft — the durable user_prompt record
    // persists it so a later replay never shows the wire framing.
    expect(send[0].displayContent).toEqual([{ type: 'text', text: 'and add a test' }])
    // The user bubble shows ONLY the draft — the summary never renders.
    // (Spliced pre-switch user records ride the merged transcript with
    // `switch-splice:` ids — they are history, not this turn's bubble.)
    const userMessages = (state.messages['s-new'] ?? []).filter(
      (m) => m.role === 'user' && !m.id.startsWith('switch-splice:')
    )
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].blocks).toEqual([{ type: 'text', text: 'and add a test' }])
    // LIVE_MERGE (spec-agent-switch-live-merged-transcript): the remapped
    // tab's first paint already carries the whole conversation — the spliced
    // old turns (negative-band seqs, `switch-splice:` ids), then the draft
    // bubble. No blank/fresh continuation.
    const merged = state.messages['s-new'] ?? []
    expect(merged.slice(0, 2).map((m) => m.id)).toEqual([
      'switch-splice:s-old:m1',
      'switch-splice:s-old:m2'
    ])
    expect(merged.slice(0, 2).every((m) => (m.seq ?? 0) < 0)).toBe(true)
    expect(merged[2].id).toMatch(/^turn:/)
    expect(merged[2].seq ?? -1).toBeGreaterThanOrEqual(0)
    // Exactly one separator: the fabricated marker (no live `acp:agent_switch`
    // event in this test) joined the splice input at the band top — seq = the
    // old band's max + 1, re-stamped into the negative band, rendering after
    // every old record and before the new turn.
    expect(state.agentSwitches['s-new']).toEqual([
      expect.objectContaining({
        id: 'switch-splice:s-old:switch:fabricated:3',
        fromConfigId: 'cfg-old',
        toConfigId: 'cfg-new',
        newSessionId: 's-new',
        summaryText: expect.stringContaining('taking over')
      })
    ])
    expect(state.agentSwitches['s-new']?.[0]?.seq ?? 0).toBeLessThan(0)
    // The OLD session's slices are untouched — the reopen chain walk and its
    // live-event handlers still need them.
    expect(state.messages['s-old']?.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(state.agentSwitches['s-old'] ?? []).toHaveLength(0)
    // The marker was recorded on the OLD session with the right ids.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('acp_record_agent_switch', {
      sessionId: 's-old',
      fromConfigId: 'cfg-old',
      toConfigId: 'cfg-new',
      newSessionId: 's-new',
      summaryText: expect.stringContaining('taking over')
    })
    // The tab was remapped old → new in the same pane.
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith('s-old', 's-new')
    // The old agent's canonical reuse key is detached (kill stays with the
    // idle reaper — no kill invoke here).
    expect(state.configToLiveAgent[agentReuseKey('cfg-old', '/work')]).toBeUndefined()
    expect(
      state.configToLiveAgent[detachedReuseKey(agentReuseKey('cfg-old', '/work'), 'agent-old')]
    ).toBe('agent-old')
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_kill_agent')).toBe(false)
    // The ordered-agent cache on the old session's index entry.
    const entry = state.sessionIndex.find((e) => e.id === 's-old')
    expect(entry?.agents).toEqual(['cfg-old', 'cfg-new'])
    // The armed switch is cleared; the old session stays live (not closed).
    expect(state.sessions['s-old'].switching).toBeNull()
    expect(state.sessions['s-old'].status).toBe('active')
    // The old session's composer draft was deleted.
    expect(mockPersistenceApi.delete).toHaveBeenCalledWith('chat-draft/p1/s-old')
    // Boundary logs carry session + config ids only.
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp.switchAgent.success' })
    )
  })

  it('BUSY_GATE: an active turn rejects the arm with a banner and no spawn', async () => {
    seedSession('s-busy', 'agent-old', true)
    const armed = await useAcpStore.getState().armAgentSwitch('s-busy', 'cfg-new')
    expect(armed).toBe(false)
    const session = useAcpStore.getState().sessions['s-busy']
    expect(session.lastError).toContain('Could not switch agent')
    expect(session.switching).toBeNull()
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp.switchAgent.start' })
    )
  })

  it('SPAWN_FAIL: a spawn failure rolls back to the live original session', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent') throw new Error('spawn exploded')
      throw new Error(`unexpected invoke command: ${command}`)
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new', { pendingText: 'draft' })

    const state = useAcpStore.getState()
    const session = state.sessions['s-old']
    // The ORIGINAL session stays live and usable — banner, not status:'error'.
    expect(session.status).toBe('active')
    expect(session.agentId).toBe('agent-old')
    expect(session.lastError).toContain('Could not switch agent')
    expect(session.lastError).toContain('spawn exploded')
    expect(session.switching).toBeNull()
    // Nothing durable happened: no marker, no new session, no remap, no kill.
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_record_agent_switch')).toBe(false)
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_new_session')).toBe(false)
    expect(workspaceStateRef.current.remapAgentChatSession).not.toHaveBeenCalled()
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_kill_agent')).toBe(false)
    // ROLLBACK (spec-agent-switch-live-merged-transcript): the splice never
    // ran — no new-session slices exist, and the OLD session's transcript
    // stays exactly as seeded.
    expect(state.messages['s-new']).toBeUndefined()
    expect(state.agentSwitches['s-new']).toBeUndefined()
    expect(state.messages['s-old'] ?? []).toHaveLength(0)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp.switchAgent.failure' })
    )
  })

  it('NEW_SESSION_FAIL: a session/new failure kills the just-spawned agent only when unused', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-new', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') throw new Error('new session rejected')
      if (command === 'acp_kill_agent') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new', { pendingText: 'draft' })

    const state = useAcpStore.getState()
    const session = state.sessions['s-old']
    expect(session.status).toBe('active')
    expect(session.agentId).toBe('agent-old')
    expect(session.lastError).toContain('Could not switch agent')
    expect(session.lastError).toContain('new session rejected')
    expect(session.switching).toBeNull()
    // No marker, no remap — and the orphaned spawned agent was killed (it was
    // spawned FOR this switch and owns no other session).
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_record_agent_switch')).toBe(false)
    expect(workspaceStateRef.current.remapAgentChatSession).not.toHaveBeenCalled()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('acp_kill_agent', { agentId: 'agent-new' })
  })

  it('MARKER_FAIL: a marker write failure is non-blocking — the switch still completes', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-new', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 's-new' }
      if (command === 'acp_send_prompt') return 'end_turn'
      if (command === 'acp_record_agent_switch') throw new Error('marker write failed')
      throw new Error(`unexpected invoke command: ${command}`)
    })
    // A pre-switch transcript so the live merge is observable.
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'earlier work' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ] as never
      }
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new', { pendingText: 'next step' })
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The conversation continued on the new agent: prompt dispatched, tab
    // remapped, switch cleared — only the durable marker is absent.
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_send_prompt')).toBe(true)
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith('s-old', 's-new')
    expect(state.sessions['s-old'].switching).toBeNull()
    // MARKER_FAIL (spec-agent-switch-live-merged-transcript): the splice never
    // depends on the durable write — the merged transcript landed and the
    // fabricated marker still renders exactly one separator.
    expect(state.messages['s-new']?.[0]?.id).toBe('switch-splice:s-old:m1')
    expect(state.agentSwitches['s-new']).toEqual([
      expect.objectContaining({ newSessionId: 's-new', toConfigId: 'cfg-new' })
    ])
    // The non-blocking warning surfaced to the user.
    expect(toastWarning).toHaveBeenCalled()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'acp.switchAgent.failure',
        message: expect.stringContaining('Marker write failed')
      })
    )
  })

  it('EMPTY_DRAFT: a switch without a pending draft sends a summary-only wire prompt and no user bubble', async () => {
    mockHappyPathInvoke()
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'earlier work' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ] as never
      }
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The wire prompt is the summary only (story 1 handles empty pending).
    const sentTexts = invokeArgField(
      'acp_send_prompt',
      'text',
      (v): v is string => typeof v === 'string'
    )
    expect(sentTexts).toHaveLength(1)
    expect(sentTexts[0]).toContain('taking over a conversation')
    expect(sentTexts[0]).not.toContain('---')
    // No NEW user bubble: the merged transcript carries the spliced old
    // turns (`switch-splice:` ids) but the summary-only handoff never mints
    // a draft bubble (the trailing-user reuse skips spliced history —
    // rebranding one would corrupt the projection).
    expect(
      (state.messages['s-new'] ?? []).filter(
        (m) => m.role === 'user' && !m.id.startsWith('switch-splice:')
      )
    ).toHaveLength(0)
    // The spliced band still landed: old turn + one separator.
    expect(state.messages['s-new']?.map((m) => m.id)).toEqual(['switch-splice:s-old:m1'])
    expect(state.agentSwitches['s-new']).toEqual([
      expect.objectContaining({
        id: 'switch-splice:s-old:switch:fabricated:2',
        newSessionId: 's-new'
      })
    ])
  })

  it('MULTI_SWITCH: a second switch appends to the ordered-agent cache and the marker chains', async () => {
    // First switch: cfg-old → cfg-new (session s-new).
    mockHappyPathInvoke()
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new', { pendingText: 'go' })
    await flushTurnEnd()

    // Second switch: cfg-new → cfg-3 from the NEW session. Rebind the old
    // session's agent mapping so configIdForAgentId resolves cfg-new.
    useAcpStore.setState({
      agentConfigs: [
        { id: 'cfg-old', name: 'Gemini', command: 'gemini', args: [], env: {} },
        { id: 'cfg-new', name: 'Claude', command: 'claude', args: [], env: {} },
        { id: 'cfg-3', name: 'Droid', command: 'droid', args: [], env: {} }
      ],
      configToLiveAgent: {
        [agentReuseKey('cfg-new', '/work')]: 'agent-new',
        // The first switch detached cfg-old's canonical key.
        [detachedReuseKey(agentReuseKey('cfg-old', '/work'), 'agent-old')]: 'agent-old'
      },
      agents: {
        'agent-old': { id: 'agent-old', capabilities: {} },
        'agent-new': { id: 'agent-new', capabilities: {} }
      },
      agentStatus: { 'agent-old': 'connected', 'agent-new': 'connected' }
    })
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-s-new',
      tabs: [{ type: 'agent-chat', id: 'chat-s-new', sessionId: 's-new' }]
    }
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-3', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 's-3' }
      if (command === 'acp_send_prompt') return 'end_turn'
      if (command === 'acp_record_agent_switch') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })
    await useAcpStore.getState().armAgentSwitch('s-new', 'cfg-3')
    await useAcpStore.getState().switchAgent('s-new', 'cfg-3', { pendingText: 'again' })
    await flushTurnEnd()

    const state = useAcpStore.getState()
    const entry = state.sessionIndex.find((e) => e.id === 's-old')
    expect(entry?.agents).toEqual(['cfg-old', 'cfg-new'])
    const newEntry = state.sessionIndex.find((e) => e.id === 's-new')
    expect(newEntry?.agents).toEqual(['cfg-new', 'cfg-3'])
    // Both markers recorded — the chain reads the LAST one on reopen.
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === 'acp_record_agent_switch')
        .map((c) => c[1])
    ).toEqual([
      expect.objectContaining({ sessionId: 's-old', newSessionId: 's-new' }),
      expect.objectContaining({ sessionId: 's-new', newSessionId: 's-3' })
    ])
    // MULTI_HOP (spec-agent-switch-live-merged-transcript): the second live
    // splice folds the FIRST switch's merged band into the newest session —
    // both separators render oldest → newest on s-3's timeline. The nested
    // `switch-splice:s-new:switch-splice:s-old:*` id is the accepted shape
    // (a reopen reinstalls flat from durable payloads).
    const hops = state.agentSwitches['s-3'] ?? []
    expect(hops).toHaveLength(2)
    expect(hops[0].id).toBe('switch-splice:s-new:switch-splice:s-old:switch:fabricated:1')
    expect(hops[0].newSessionId).toBe('s-new')
    expect(hops[1].newSessionId).toBe('s-3')
    expect(hops[1].id).toMatch(/^switch-splice:s-new:switch:fabricated:/)
    expect(hops[0].seq).toBeLessThan(hops[1].seq)
    // The first hop's turn ('go' draft bubble) precedes the second hop's.
    const hopTexts = (state.messages['s-3'] ?? []).flatMap((m) =>
      m.blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '')
    )
    expect(hopTexts).toEqual(['go', 'again'])
  })

  it('REMAP_GUARD: no tab for the old session → no remap, no uninvited tab', async () => {
    mockHappyPathInvoke()
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      tabs: [],
      activeTabId: null
    }
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new', { pendingText: 'draft' })
    await flushTurnEnd()

    // The session still lands on the new agent; only the tab adoption is
    // skipped (never add an uninvited tab).
    expect(useAcpStore.getState().sessions['s-new']).toBeDefined()
    expect(workspaceStateRef.current.remapAgentChatSession).not.toHaveBeenCalled()
    expect(addAgentChatTabSpy).not.toHaveBeenCalled()
  })

  it('STAGED_SEND: sendPrompt routes into the armed switch; cancel restores normal sends', async () => {
    mockHappyPathInvoke()
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    // The NEXT send executes the switch instead of a normal turn.
    await useAcpStore.getState().sendPrompt('s-old', 'switch now')
    await flushTurnEnd()
    // The old session got NO new user message (the turn went to s-new).
    const oldUser = (useAcpStore.getState().messages['s-old'] ?? []).filter(
      (m) => m.role === 'user'
    )
    expect(oldUser).toHaveLength(0)
    const sentSessionIds = invokeArgField(
      'acp_send_prompt',
      'sessionId',
      (v): v is string => typeof v === 'string'
    )
    expect(sentSessionIds.every((s) => s === 's-new')).toBe(true)

    // Re-arming then cancelling: the next send behaves normally (old agent).
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    useAcpStore.getState().cancelAgentSwitch('s-old')
    expect(useAcpStore.getState().sessions['s-old'].switching).toBeNull()
    await useAcpStore.getState().sendPrompt('s-old', 'normal send')
    await flushTurnEnd()
    const sentAgentIds = invokeArgField(
      'acp_send_prompt',
      'agentId',
      (v): v is string => typeof v === 'string'
    )
    const normalSessionIds = invokeArgField(
      'acp_send_prompt',
      'sessionId',
      (v): v is string => typeof v === 'string'
    )
    const normalTexts = invokeArgField(
      'acp_send_prompt',
      'text',
      (v): v is string => typeof v === 'string'
    )
    expect(sentAgentIds.at(-1)).toBe('agent-old')
    expect(normalSessionIds.at(-1)).toBe('s-old')
    expect(normalTexts.at(-1)).toBe('normal send')
    const userMessages = (useAcpStore.getState().messages['s-old'] ?? []).filter(
      (m) => m.role === 'user'
    )
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].blocks).toEqual([{ type: 'text', text: 'normal send' }])
  })

  it('BLOCKS_SENDBLOCKS: an armed switch intercepts the structured (composer) submit path', async () => {
    mockHappyPathInvoke()
    // Seed a transcript so the handoff summary is non-trivial (the summary
    // block rides the wire ahead of the structured draft).
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'fix the bug' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ] as never
      }
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    // The composer's structured submit (skills/pills): wire + display pair.
    await useAcpStore.getState().sendPromptBlocks('s-old', [{ type: 'text', text: 'wire draft' }], {
      displayBlocks: [{ type: 'text', text: 'display draft' }]
    })
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The turn went to the NEW session with the caller's display pair as
    // the user bubble (summary only on the wire). Spliced pre-switch user
    // records (`switch-splice:` ids) are projected history, not this turn.
    const userMessages = (state.messages['s-new'] ?? []).filter(
      (m) => m.role === 'user' && !m.id.startsWith('switch-splice:')
    )
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].blocks).toEqual([{ type: 'text', text: 'display draft' }])
    const isTextBlockArray = (v: unknown): v is Array<{ type: string; text: string }> =>
      Array.isArray(v) &&
      v.every(
        (b) =>
          b !== null &&
          typeof b === 'object' &&
          'type' in b &&
          'text' in b &&
          typeof (b as { text: unknown }).text === 'string'
      )
    const sentContents = invokeArgField('acp_send_prompt', 'content', isTextBlockArray)
    const wireText = (sentContents[0] ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    expect(wireText).toContain('taking over a conversation')
    expect(wireText).toContain('wire draft')
    // The OLD session got no NEW user message from the intercepted send
    // (only the seeded pre-switch one remains).
    const oldUsers = (state.messages['s-old'] ?? []).filter((m) => m.role === 'user')
    expect(oldUsers).toHaveLength(1)
    expect(oldUsers[0].id).toBe('m1')
  })

  it('EXECUTE_BUSY: an idle arm is re-gated at execute time when the turn started meanwhile', async () => {
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    // The user sent a normal prompt that started a turn before the staged
    // send executed... (armed sends route into switchAgent, so simulate the
    // turn starting directly on the session state).
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-old': { ...s.sessions['s-old']!, activeTurn: true, openTurnId: 'busy-turn' }
      }
    }))
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new', { pendingText: 'draft' })

    const session = useAcpStore.getState().sessions['s-old']
    expect(session.lastError).toContain('Could not switch agent')
    expect(session.lastError).toContain('still working on a turn')
    expect(session.switching).toBeNull()
    // The blocked switch ran NO switch-execution wire work — the only call
    // is the arm's silent target warm (prepareChat spawns cfg-new so the
    // armed composer can show the target's options).
    await vi.waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_spawn_agent')).toBe(true)
    )
    const commands = vi.mocked(invoke).mock.calls.map((c) => c[0])
    expect(commands.every((c) => c === 'acp_spawn_agent' || c === 'acp_new_session')).toBe(true)
    expect(useAcpStore.getState().sessions['s-new']).toBeUndefined()
  })

  it('DISPATCH_FAIL: a handoff dispatch failure after the durable switch warns on the NEW session', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-new', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 's-new' }
      if (command === 'acp_record_agent_switch') return undefined
      if (command === 'acp_send_prompt') throw new Error('dispatch exploded')
      throw new Error(`unexpected invoke command: ${command}`)
    })
    // A pre-switch transcript so the merge is observable: the dispatch-failure
    // path must keep the spliced timeline intact (the switch is durable once
    // the session exists — the banner lands on the NEW session).
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'keep this' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ] as never
      }
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new', { pendingText: 'go' })
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The switch DURABLY happened: marker recorded, tab remapped, cache
    // written, armed state cleared — the OLD session stays clean (no
    // rollback banner on a session the user can no longer see).
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_record_agent_switch')).toBe(true)
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith('s-old', 's-new')
    expect(state.sessionIndex.find((e) => e.id === 's-old')?.agents).toEqual(['cfg-old', 'cfg-new'])
    expect(state.sessions['s-old'].switching).toBeNull()
    expect(state.sessions['s-old'].lastError).toBeNull()
    // DISPATCH_FAIL (spec-agent-switch-live-merged-transcript): the merged
    // transcript + one separator survive the failed dispatch — the remapped
    // pane shows the whole conversation plus the error banner, not a blank
    // chat. The re-entry guard keeps a second splice from doubling records.
    // (The failed dispatch's optimistic draft bubble also stays painted.)
    expect(state.messages['s-new']?.[0]?.id).toBe('switch-splice:s-old:m1')
    expect(state.agentSwitches['s-new']).toHaveLength(1)
    // The NEW (visible) session carries the failure banner instead.
    expect(state.sessions['s-new'].lastError).toContain('Could not deliver the handoff prompt')
    expect(state.sessions['s-new'].lastError).toContain('dispatch exploded')
    expect(state.sessions['s-new'].status).toBe('active')
    // Warn — not a hard failure log.
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'acp.switchAgent.failure',
        message: expect.stringContaining('Handoff dispatch failed')
      })
    )
  })

  it('CLOSED_ARMED: closing an armed session clears the switch; a later send surfaces the closed error', async () => {
    mockHappyPathInvoke()
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    expect(useAcpStore.getState().sessions['s-old'].switching).toEqual({
      toConfigId: 'cfg-new',
      status: 'pending'
    })
    // The chat is closed (closeSession runs on tab close / delete).
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_close_session') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })
    await useAcpStore.getState().closeSession('s-old')
    expect(useAcpStore.getState().sessions['s-old'].switching).toBeNull()

    // A later send is a NORMAL closed-session rejection — it must not route
    // into switchAgent (no spawn). Clear the call log first so the arm-time
    // warm spawn for cfg-new doesn't count against the send path.
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      throw new Error(`unexpected invoke command: ${command}`)
    })
    vi.mocked(invoke).mockClear()
    await expect(useAcpStore.getState().sendPrompt('s-old', 'hello?')).rejects.toThrow(
      'session is closed'
    )
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_spawn_agent')).toBe(false)
  })

  it('DOUBLE_SEND: two rapid sends while armed run ONE switch (race guard)', async () => {
    // Gate the spawn so both sends observe the armed state before the first
    // switch clears it.
    let releaseSpawn!: (value: {
      agentId: string
      capabilities: unknown
      authMethods: never[]
    }) => void
    const spawnGate = new Promise<{ agentId: string; capabilities: unknown; authMethods: never[] }>(
      (resolve) => {
        releaseSpawn = resolve
      }
    )
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent') return spawnGate
      if (command === 'acp_new_session') return { sessionId: 's-new' }
      if (command === 'acp_send_prompt') return 'end_turn'
      if (command === 'acp_record_agent_switch') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    const first = useAcpStore.getState().sendPrompt('s-old', 'first')
    // The second send fires while the first is still parked in spawn.
    const second = useAcpStore.getState().sendPrompt('s-old', 'second')
    releaseSpawn({ agentId: 'agent-new', capabilities: {}, authMethods: [] })
    await Promise.all([first, second])
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // ONE spawn, ONE marker, ONE remap — the second send was ignored.
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === 'acp_spawn_agent')).toHaveLength(1)
    expect(
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === 'acp_record_agent_switch')
    ).toHaveLength(1)
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledTimes(1)
    expect(state.sessions['s-new']).toBeDefined()
    expect(state.sessions['s-old'].switching).toBeNull()
  })

  it('ECHO_SUPPRESSED: the user_prompt echo of a summary-only handoff adds no user bubble', async () => {
    mockHappyPathInvoke()
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'earlier work' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ] as never
      }
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new')
    await flushTurnEnd()

    // The turn is dispatched; emit the server's user_prompt echo carrying
    // the handoff wire (the summary text) and the SAME client-minted turn id
    // — it must not render a bubble.
    const turnId = [..._handoffOnlyTurnIdsForTesting()][0]
    expect(turnId).toBeTruthy()
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-new',
      sessionId: 's-new',
      role: 'user',
      turnId,
      content: [{ type: 'text', text: 'the handoff summary wire' }]
    })
    // Spliced pre-switch records (`switch-splice:` ids) are projected history —
    // the new session's OWN transcript still holds no user bubble.
    expect(
      (useAcpStore.getState().messages['s-new'] ?? []).filter(
        (m) => m.role === 'user' && !m.id.startsWith('switch-splice:')
      )
    ).toHaveLength(0)
  })

  it('ECHO_STRIP: a framed handoff user_prompt echo from an old-format sender renders only the draft', async () => {
    // spec-agent-switch-separator-redesign: a queued flush or another client
    // on a pre-fix build persists the wire framing verbatim; the live echo
    // must strip the preamble like the replay folds do.
    seedSession('s-echo', 'agent-1', false)
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's-echo',
      role: 'user',
      turnId: 'framed-1',
      content: [
        {
          type: 'text',
          text: '# Conversation handoff\n\nYou are taking over.\n\n---\n\nthe real draft'
        }
      ]
    })
    const messages = useAcpStore.getState().messages['s-echo']
    expect(messages.map((m) => m.id)).toEqual(['turn:framed-1'])
    expect(messages[0].blocks).toEqual([{ type: 'text', text: 'the real draft' }])
  })

  it('ECHO_STRIP: a summary-only framed echo with an unregistered turn id renders nothing', async () => {
    // Same defense for the no-draft shape: `handoffOnlyTurnIds` only covers
    // THIS client's dispatches — foreign senders rely on the strip.
    seedSession('s-echo2', 'agent-1', false)
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's-echo2',
      role: 'user',
      turnId: 'foreign-1',
      content: [
        {
          type: 'text',
          text: '# Conversation handoff\n\nYou are taking over a conversation previously handled by OMP.'
        }
      ]
    })
    expect(useAcpStore.getState().messages['s-echo2'] ?? []).toHaveLength(0)
  })

  it('ARM_VALIDATION: arming rejects an unknown config and the same-config switch', async () => {
    const unknown = await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-missing')
    expect(unknown).toBe(false)
    let session = useAcpStore.getState().sessions['s-old']
    expect(session.lastError).toContain('unknown agent config cfg-missing')
    expect(session.switching).toBeNull()

    // Same-config: the old agent's config is cfg-old.
    const same = await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-old')
    expect(same).toBe(false)
    session = useAcpStore.getState().sessions['s-old']
    expect(session.lastError).toContain('already owns this chat')
    expect(session.switching).toBeNull()
    // Nothing spawned on either rejection.
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  it('PERSIST_CARRY: a re-persist of the old session carries the ordered-agent cache forward', async () => {
    mockHappyPathInvoke()
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().switchAgent('s-old', 'cfg-new', { pendingText: 'go' })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessionIndex.find((e) => e.id === 's-old')?.agents).toEqual([
      'cfg-old',
      'cfg-new'
    ])

    // A later normal persist (e.g. the title updates) must carry the list
    // forward verbatim — not drop or duplicate it.
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, 's-old': { ...s.sessions['s-old']!, title: 'Renamed' } }
    }))
    const before = useAcpStore.getState().sessionIndex.find((e) => e.id === 's-old')
    // Direct persistSession projection check: re-run the close-path persist
    // by invoking closeSession with the transport closed cleanly.
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_close_session') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })
    await useAcpStore.getState().closeSession('s-old')
    const after = useAcpStore.getState().sessionIndex.find((e) => e.id === 's-old')
    expect(after?.agents).toEqual(['cfg-old', 'cfg-new'])
    expect(after?.title).toBe('Renamed')
    expect(before?.agents).toEqual(['cfg-old', 'cfg-new'])
  })

  it('BUSY_REPLAYING: an arm is rejected while the session is replaying history', async () => {
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-old': { ...s.sessions['s-old']!, replaying: 'pending' }
      }
    }))
    const armed = await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    expect(armed).toBe(false)
    const session = useAcpStore.getState().sessions['s-old']
    expect(session.lastError).toContain('still being restored')
    expect(session.switching).toBeNull()
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
  })

  // --- Story 6 (spec-in-chat-agent-switch): hardening regressions ---------

  it('LATE_OLD_AGENT_EVENTS: old-agent chunks and tool events after the marker never land in the NEW session chat', async () => {
    mockHappyPathInvoke()
    // Live marker fan-out: the host emits `acp:agent_switch` after the
    // durable write — drive it through the store's handler so the marker
    // (the routing authority for "after the switch") is in place.
    useAcpStore.getState()._onAgentSwitch(
      {
        agentId: 'agent-old',
        sessionId: 's-old',
        fromConfigId: 'cfg-old',
        toConfigId: 'cfg-new',
        newSessionId: 's-new',
        summaryText: 'Handoff summary'
      },
      9
    )
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().sendPrompt('s-old', 'handoff draft')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    expect((state.agentSwitches['s-old'] ?? []).some((sw) => sw.newSessionId === 's-new')).toBe(
      true
    )
    // Baseline: the switch happened, the tab owns the NEW session.
    expect(state.sessions['s-new']).toBeDefined()
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith('s-old', 's-new')
    // EVENT_EARLY (spec-agent-switch-live-merged-transcript): the live
    // `acp:agent_switch` record beat the splice, so the splice carries THE
    // REAL record — exactly one separator on the new timeline, no fabricated
    // duplicate alongside it.
    expect(state.agentSwitches['s-new']).toEqual([
      expect.objectContaining({
        id: 'switch-splice:s-old:switch:seq-9',
        toConfigId: 'cfg-new',
        newSessionId: 's-new',
        summaryText: 'Handoff summary'
      })
    ])

    // Late old-agent events (the old agent's process still streaming a chunk
    // or a tool call after the marker was recorded): they cite the OLD
    // session, whose transcript is the pre-switch view. The regression this
    // pins: nothing from the old agent may leak into the NEW session's
    // transcript — the accepts gate keeps routing keyed by sessionId, and
    // the new session's chat stays clean of old-agent content.
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-old',
      sessionId: 's-old',
      role: 'agent',
      content: { type: 'text', text: 'late old-agent chunk' }
    })
    useAcpStore.getState()._onToolCall({
      agentId: 'agent-old',
      sessionId: 's-old',
      toolCall: { toolCallId: 'late-old-tool', title: 'Old tool', status: 'pending' }
    })
    _flushCoalescedForTesting()

    const after = useAcpStore.getState()
    const newTexts = (after.messages['s-new'] ?? [])
      .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text ?? ''))
      .join('\n')
    expect(newTexts).not.toContain('late old-agent chunk')
    expect((after.messages['s-new'] ?? []).some((m) => m.streaming)).toBe(false)
    expect((after.toolCalls['s-new'] ?? []).some((t) => t.toolCallId === 'late-old-tool')).toBe(
      false
    )
    // The NEW session's agent stays the new agent (ownership never drifts).
    expect(after.sessions['s-new']?.agentId).toBe('agent-new')
  })

  it('LATE_OLD_AGENT_EVENTS: a late old-agent event for an UNKNOWN session id never leaks into the new chat', async () => {
    mockHappyPathInvoke()
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().sendPrompt('s-old', 'go')
    await flushTurnEnd()

    // A fully unknown session id (an evicted/replaced record) — the
    // accepts-gate must reject it outright, not route it anywhere.
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-old',
      sessionId: 's-unknown-late',
      role: 'agent',
      content: { type: 'text', text: 'ghost chunk' }
    })
    _flushCoalescedForTesting()
    const state = useAcpStore.getState()
    expect(state.messages['s-unknown-late']).toBeUndefined()
    const newTexts = (state.messages['s-new'] ?? [])
      .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text ?? ''))
      .join('\n')
    expect(newTexts).not.toContain('ghost chunk')
  })

  it('EVENT_LATE: an acp:agent_switch event landing after the splice stays on the old session — one separator on the new timeline', async () => {
    mockHappyPathInvoke()
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'earlier work' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ] as never
      }
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().sendPrompt('s-old', 'handoff')
    await flushTurnEnd()

    // Baseline: the splice already ran — the fabricated marker is the one
    // separator on the new session's band (the real event hasn't arrived).
    expect(useAcpStore.getState().agentSwitches['s-new']).toEqual([
      expect.objectContaining({
        id: 'switch-splice:s-old:switch:fabricated:2',
        newSessionId: 's-new'
      })
    ])

    // The host's marker fan-out lands AFTER the splice — it records on the
    // OLD session (the reopen-chain input), never inside the new session's
    // band, so the new timeline keeps exactly one separator.
    useAcpStore.getState()._onAgentSwitch(
      {
        agentId: 'agent-old',
        sessionId: 's-old',
        fromConfigId: 'cfg-old',
        toConfigId: 'cfg-new',
        newSessionId: 's-new',
        summaryText: 'Handoff summary'
      },
      9
    )
    const state = useAcpStore.getState()
    expect(state.agentSwitches['s-new']).toHaveLength(1)
    expect((state.agentSwitches['s-old'] ?? []).some((sw) => sw.id === 'switch:seq-9')).toBe(true)
  })

  it('ARMED_QUEUE_RECOVERY: a queued prompt plus an armed switch clears the turn without a half-switch (queue preserved, armed state intact)', async () => {
    mockHappyPathInvoke()
    // Arm FIRST on the idle session (beforeEach seeds s-old idle — the
    // arm's busy gate is clean), THEN the queue + a busy turn land (the
    // realistic race: a send raced the arm — recoverPromptToQueue or a WS
    // turn-busy rejection queued it after the arm's check).
    const armed = await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    expect(armed).toBe(true)
    expect(useAcpStore.getState().sessions['s-old'].switching).toEqual({
      toConfigId: 'cfg-new',
      status: 'pending'
    })
    // The arm silently warms the TARGET config (prepareChat → spawn + a
    // prepared warm session) so the armed composer shows target options.
    // Wait for it to land so the "no switch execution" counts below are
    // deterministic.
    await vi.waitFor(() =>
      expect(
        useAcpStore.getState().preparedSessions[prepareChatKey('cfg-new', '/work', undefined)]
      ).toBe('s-new')
    )
    // The queue + busy turn land AFTER the arm (the race this regression pins).
    useAcpStore.setState((s) => ({
      promptQueues: {
        ...s.promptQueues,
        's-old': [
          {
            id: 'q-late',
            blocks: [{ type: 'text', text: 'queued follow-up' }],
            createdAt: 1
          }
        ]
      },
      sessions: {
        ...s.sessions,
        's-old': { ...s.sessions['s-old']!, activeTurn: true, openTurnId: 'busy-turn' }
      }
    }))

    // The turn clears (prompt_complete path): flushNextQueuedPrompt fires.
    // The contract under test: the flush must NOT execute the armed switch
    // (flushNextQueuedPrompt dispatches to the session's CURRENT agentId
    // through runPromptTurn, never through the sendPrompt interception) and
    // must not lose the queued prompt — the queue belongs to the OLD
    // session; the user's next SEND (sendPrompt/sendPromptBlocks) is the
    // switch's execution trigger, not the turn-clear.
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-old',
      sessionId: 's-old',
      stopReason: 'end_turn'
    })
    await flushTurnEnd()
    await Promise.resolve()

    const state = useAcpStore.getState()
    // No half-switch fired: no marker, no remap, and no SECOND session —
    // the only session/new so far is the arm-time warm prepare ('s-new'
    // lives in preparedSessions, it is not a switch result).
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_record_agent_switch')).toBe(false)
    expect(workspaceStateRef.current.remapAgentChatSession).not.toHaveBeenCalled()
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === 'acp_new_session')).toHaveLength(1)
    // The armed state survives until the user's next send.
    expect(state.sessions['s-old'].switching).toEqual({ toConfigId: 'cfg-new', status: 'pending' })
    // The queued prompt landed coherently: it flushed to the OLD session's
    // CURRENT agent (agent-old) — the queue belongs to the old session, and
    // the armed switch still executes on the NEXT user send.
    const sent = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === 'acp_send_prompt')
      .map((c) => c[1] as { agentId: string; sessionId: string; text?: string })
    expect(sent.some((s) => s.agentId === 'agent-old' && s.sessionId === 's-old')).toBe(true)
    const flushedUser = (state.messages['s-old'] ?? []).filter((m) => m.role === 'user')
    expect(
      flushedUser.some((m) =>
        m.blocks.some((b) => b.type === 'text' && b.text === 'queued follow-up')
      )
    ).toBe(true)
    // No lost prompt: the queue drained by flushing (not by dropping).
    expect(state.promptQueues['s-old'] ?? []).toHaveLength(0)

    // Drain the flushed turn's own deferred end (scheduleTurnEnd's
    // setTimeout(0)) so the session is idle again, then send.
    await flushTurnEnd()
    await flushTurnEnd()
    // The user's next send STILL executes the armed switch (the staged
    // contract survives the flush).
    await useAcpStore.getState().sendPrompt('s-old', 'now switch')
    await flushTurnEnd()
    const after = useAcpStore.getState()
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'acp_record_agent_switch')).toBe(true)
    expect(after.sessions['s-new']).toBeDefined()
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith('s-old', 's-new')
    expect(after.sessions['s-old'].switching).toBeNull()
  })

  it('REOPEN: reopening a live-spliced chat reinstalls durable state and re-splices — no doubled rows or separators', async () => {
    _clearPayloadCacheForTesting()
    mockHappyPathInvoke()
    // A live switch on a chat with a pre-switch transcript.
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'hello old agent' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          },
          {
            id: 'm2',
            role: 'agent',
            blocks: [{ type: 'text', text: 'old agent reply' }],
            streaming: false,
            timestamp: 2,
            seq: 2
          }
        ] as never
      }
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().sendPrompt('s-old', 'please continue')
    await flushTurnEnd()
    // Baseline: the LIVE splice landed — projected records carry renderer-side
    // ids (`switch-splice:s-old:m1`), which differ from the durable ids the
    // host writes (`user:seq-1`). Reopen must not mix the two projections.
    expect(
      (useAcpStore.getState().messages['s-new'] ?? []).some((m) =>
        m.id.startsWith('switch-splice:s-old:')
      )
    ).toBe(true)

    // The reopen path: both session records closed + host-owned durable
    // payloads cached (the live-spliced projection was never persisted —
    // `record_agent_switch` wrote only the marker on the OLD session's log).
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-old': { ...s.sessions['s-old']!, status: 'closed' as const },
        's-new': { ...s.sessions['s-new']!, status: 'closed' as const }
      }
    }))
    setCachedSessionPayload('s-old', {
      metadata: {
        id: 's-old',
        agentId: 'agent-old',
        agentConfigId: 'cfg-old',
        title: 'Old chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        lastSeq: 3,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello old agent' }],
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
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-3',
          fromConfigId: 'cfg-old',
          toConfigId: 'cfg-new',
          newSessionId: 's-new',
          summaryText: 'Handoff summary',
          timestamp: 3,
          seq: 3
        }
      ]
    })
    setCachedSessionPayload('s-new', {
      metadata: {
        id: 's-new',
        agentId: 'agent-new',
        agentConfigId: 'cfg-new',
        title: 'Continuation',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 4,
        lastActivityAt: 8,
        messageCount: 2,
        lastSeq: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'the handoff wire' }],
          streaming: false,
          timestamp: 4,
          seq: 1
        },
        {
          id: 'snapshot:agent:2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'new agent reply' }],
          streaming: false,
          timestamp: 5,
          seq: 2
        }
      ] as never
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      recordAgentSwitch: vi.fn(async () => {}),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-new': { id: 'agent-new', capabilities: { loadSession: true } }
      },
      agentStatus: { ...s.agentStatus, 'agent-new': 'connected' }
    }))

    await useAcpStore.getState().openHistorySession('s-old')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The redirect continued on the FINAL session/agent.
    expect(loadSession).toHaveBeenCalledWith('agent-new', 's-new', '/work')
    // The reinstall replaced the live-spliced projection wholesale, then the
    // chain re-spliced the durable old band — exactly one copy of every old
    // turn, no live/durable duplicates.
    const merged = state.messages['s-new'] ?? []
    const texts = merged.map((m) => m.blocks.find((b) => b.type === 'text')?.text)
    expect(texts).toEqual([
      'hello old agent',
      'old agent reply',
      'the handoff wire',
      'new agent reply'
    ])
    const ids = merged.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    // The durable marker re-splices under the source's durable id space —
    // the reinstall wholesale-replaced the live projection (whose fabricated
    // `switch:fabricated:*` marker is gone) — exactly one separator.
    expect(state.agentSwitches['s-new']).toEqual([
      expect.objectContaining({
        id: 'switch-splice:s-old:switch:seq-3',
        newSessionId: 's-new'
      })
    ])
  })

  it('LIVE_TRIM: the merged transcript still respects the live window once durable history is cached', async () => {
    _clearPayloadCacheForTesting()
    mockHappyPathInvoke()
    // 305 pre-switch messages → the merged list exceeds the live window.
    useAcpStore.setState({
      messages: {
        's-old': Array.from({ length: 305 }, (_, i) => ({
          id: `m${i}`,
          role: i % 2 === 0 ? 'user' : 'agent',
          blocks: [{ type: 'text', text: `old ${i}` }],
          streaming: false,
          timestamp: i + 1,
          seq: i + 1
        })) as never
      }
    })
    // The new session's durable payload is already cached (host-owned), so
    // trimming the merged list is lossless — the oldest spliced records fall
    // out of the live window instead of growing it unboundedly.
    setCachedSessionPayload('s-new', {
      metadata: {
        id: 's-new',
        agentId: 'agent-new',
        agentConfigId: 'cfg-new',
        title: 'Continuation',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 1,
        messageCount: 0,
        lastSeq: 0,
        status: 'closed'
      },
      messages: [] as never
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().sendPrompt('s-old', 'continue')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    const merged = state.messages['s-new'] ?? []
    // The splice trimmed the merged band to the live window (300 of the 305
    // spliced records retained), then the turn appended its draft bubble.
    expect(merged.length).toBeLessThanOrEqual(MAX_LIVE_WINDOW_MESSAGES + 1)
    // The spliced band's head fell out — the oldest records are gone.
    expect(merged[0]?.id).toBe('switch-splice:s-old:m5')
    // The newest records survive: the draft bubble is the tail.
    expect(merged[merged.length - 1]?.id).toMatch(/^turn:/)
    // The separator lives on `agentSwitches` — outside the message window,
    // never trimmed.
    expect(state.agentSwitches['s-new']).toHaveLength(1)
  })

  it('REOPEN_ACTIVE_TARGET: reopening the source while its live-spliced target stays active canonicalizes the band — no duplicates', async () => {
    _clearPayloadCacheForTesting()
    mockHappyPathInvoke()
    // A live switch on a chat with a pre-switch transcript.
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'hello old agent' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ] as never
      }
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().sendPrompt('s-old', 'please continue')
    await flushTurnEnd()
    // Baseline: the LIVE splice landed on the still-ACTIVE target — its band
    // carries renderer-side ids (`switch-splice:s-old:m1`), and the
    // target-reinstall path never runs for an active session.
    expect(useAcpStore.getState().sessions['s-new']?.status).toBe('active')
    expect(
      (useAcpStore.getState().messages['s-new'] ?? []).some((m) =>
        m.id.startsWith('switch-splice:s-old:')
      )
    ).toBe(true)

    // The source's session record is CLOSED (the switch closed it) and its
    // host-owned durable payload is cached — reopening it walks the marker.
    // The TARGET stays active (no wholesale reinstall, no
    // `respliceLiveSwitchTarget`): the redirect must canonicalize the live
    // band to the durable projection instead of folding a duplicate.
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-old': { ...s.sessions['s-old']!, status: 'closed' as const }
      }
    }))
    setCachedSessionPayload('s-old', {
      metadata: {
        id: 's-old',
        agentId: 'agent-old',
        agentConfigId: 'cfg-old',
        title: 'Old chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        lastSeq: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello old agent' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-2',
          fromConfigId: 'cfg-old',
          toConfigId: 'cfg-new',
          newSessionId: 's-new',
          summaryText: 'Handoff summary',
          timestamp: 2,
          seq: 2
        }
      ]
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      recordAgentSwitch: vi.fn(async () => {}),
      dispose: vi.fn()
    } as unknown as AcpTransport)

    await useAcpStore.getState().openHistorySession('s-old')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // Exactly ONE pre-switch user turn: the durable band canonicalized the
    // live projection (live-id records are gone, durable-id records render).
    const merged = state.messages['s-new'] ?? []
    const oldTurns = merged.filter((m) =>
      m.blocks.some((b) => b.type === 'text' && b.text === 'hello old agent')
    )
    expect(oldTurns).toHaveLength(1)
    expect(oldTurns[0].id).toBe('switch-splice:s-old:user:seq-1')
    expect(merged.some((m) => m.id === 'switch-splice:s-old:m1')).toBe(false)
    // Exactly one separator: the durable marker, not the fabricated one.
    expect(state.agentSwitches['s-new']).toHaveLength(1)
    expect(state.agentSwitches['s-new']?.[0]?.id).toBe('switch-splice:s-old:switch:seq-2')
  })

  it('REOPEN_TARGET: reopening the switch TARGET itself re-splices the pre-switch band', async () => {
    _clearPayloadCacheForTesting()
    mockHappyPathInvoke()
    // A live switch on a chat with a pre-switch transcript.
    useAcpStore.setState({
      messages: {
        's-old': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'hello old agent' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ] as never
      }
    })
    await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
    await useAcpStore.getState().sendPrompt('s-old', 'please continue')
    await flushTurnEnd()
    expect(
      (useAcpStore.getState().messages['s-new'] ?? []).some((m) =>
        m.id.startsWith('switch-splice:s-old:')
      )
    ).toBe(true)

    // Simulate a wholesale reinstall window on the target (crash retry /
    // direct history open): the transcript slices are replaced by the raw
    // durable log — band gone — while the session record is CLOSED and the
    // target→source liveSwitchSources link stays warm.
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-new': { ...s.sessions['s-new']!, status: 'closed' as const }
      },
      messages: { ...s.messages, 's-new': [] },
      toolCalls: { ...s.toolCalls, 's-new': [] },
      agentSwitches: { ...s.agentSwitches, 's-new': [] }
    }))
    // Durable payloads: the target's own log (post-switch turns only) plus
    // the source's log carrying the marker (what resplice re-splices).
    setCachedSessionPayload('s-new', {
      metadata: {
        id: 's-new',
        agentId: 'agent-new',
        agentConfigId: 'cfg-new',
        title: 'Continuation',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        lastSeq: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'snapshot:agent:1',
          role: 'agent',
          blocks: [{ type: 'text', text: 'new agent reply' }],
          streaming: false,
          timestamp: 2,
          seq: 1
        }
      ] as never
    })
    setCachedSessionPayload('s-old', {
      metadata: {
        id: 's-old',
        agentId: 'agent-old',
        agentConfigId: 'cfg-old',
        title: 'Old chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        lastSeq: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello old agent' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-2',
          fromConfigId: 'cfg-old',
          toConfigId: 'cfg-new',
          newSessionId: 's-new',
          summaryText: 'Handoff summary',
          timestamp: 2,
          seq: 2
        }
      ]
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      recordAgentSwitch: vi.fn(async () => {}),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-new': { id: 'agent-new', capabilities: { loadSession: true } }
      },
      agentStatus: { ...s.agentStatus, 'agent-new': 'connected' }
    }))

    await useAcpStore.getState().openHistorySession('s-new')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    const merged = state.messages['s-new'] ?? []
    // The source band was re-spliced under durable ids — the pre-switch user
    // turn renders on the target's own reinstall, exactly once.
    const oldTurns = merged.filter((m) =>
      m.blocks.some((b) => b.type === 'text' && b.text === 'hello old agent')
    )
    expect(oldTurns).toHaveLength(1)
    expect(oldTurns[0].id).toBe('switch-splice:s-old:user:seq-1')
    // The separator re-renders from the durable marker.
    expect(state.agentSwitches['s-new']).toEqual([
      expect.objectContaining({ newSessionId: 's-new' })
    ])
  })

  it('REOPEN_INFLIGHT_TARGET: reopening the source while the target is still opening joins the in-flight open instead of reopening standalone', async () => {
    // Live repro from the Tauri MCP drive: a restored tab rehydrates the
    // switch target at startup; clicking the SOURCE row before that open
    // settles must still redirect (the delegated open coalesces onto the
    // in-flight promise), not fall back to the stale standalone view.
    _clearPayloadCacheForTesting()
    setCachedSessionPayload('s-old', {
      metadata: {
        id: 's-old',
        agentId: 'agent-old',
        agentConfigId: 'cfg-old',
        title: 'Old chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        lastSeq: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello old agent' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-2',
          fromConfigId: 'cfg-old',
          toConfigId: 'cfg-new',
          newSessionId: 's-new',
          summaryText: 'Handoff summary',
          timestamp: 2,
          seq: 2
        }
      ]
    })
    setCachedSessionPayload('s-new', {
      metadata: {
        id: 's-new',
        agentId: 'agent-new',
        agentConfigId: 'cfg-new',
        title: 'Continuation',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        lastSeq: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-0',
          role: 'user',
          blocks: [{ type: 'text', text: 'continue the work' }],
          streaming: false,
          timestamp: 1,
          seq: 0
        },
        {
          id: 'snapshot:agent:1',
          role: 'agent',
          blocks: [{ type: 'text', text: 'new agent reply' }],
          streaming: false,
          timestamp: 2,
          seq: 1
        }
      ] as never
    })
    // Hold s-new's resume load mid-flight so openHistorySessionInner has
    // already installed its entry into inFlightHistoryOpens when the source
    // open runs — the timing hole the cycle guard misread as a loop.
    let resolveNewLoad: (() => void) | undefined
    const newLoadGate = new Promise<void>((r) => {
      resolveNewLoad = r
    })
    const loadSession = vi.fn(async (_agentId: string, sessionId: string) => {
      if (sessionId === 's-new') await newLoadGate
      return {}
    })
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      recordAgentSwitch: vi.fn(async () => {}),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agents: {
        'agent-old': { id: 'agent-old', capabilities: { loadSession: true } },
        'agent-new': { id: 'agent-new', capabilities: { loadSession: true } }
      },
      agentStatus: { 'agent-old': 'connected', 'agent-new': 'connected' }
    })
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-s-old',
      tabs: [{ type: 'agent-chat', id: 'chat-s-old', sessionId: 's-old' }]
    }

    // The source session must read closed for the inner reopen to run (the
    // store's live-session early return skips openHistorySessionInner —
    // and the redirect — otherwise). Mirror the real reopened state.
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-old': { ...s.sessions['s-old']!, status: 'closed' as const }
      }
    }))
    const newOpen = useAcpStore.getState().openHistorySession('s-new')
    // Let s-new's open reach the parked loadSession before the source open
    await vi.waitFor(() => expect(loadSession).toHaveBeenCalledWith('agent-new', 's-new', '/work'))
    const oldOpen = useAcpStore.getState().openHistorySession('s-old')
    // Release s-new's parked resume so both opens can finish.
    resolveNewLoad!()
    await Promise.all([newOpen, oldOpen])
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The redirect landed: the old tab remapped to the live continuation —
    // never reopened standalone. (Buggy code: bail at the in-flight guard,
    // s-old opens as its own row + the tab keeps the stale title.)
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith('s-old', 's-new')
    // The spliced pre-switch turn landed under the target exactly once.
    const texts = (state.messages['s-new'] ?? []).map(
      (m) => m.blocks.find((b) => b.type === 'text')?.text
    )
    expect(texts).toContain('hello old agent')
    expect(texts).toContain('new agent reply')
    // The source session stayed standalone — its own slices intact for the
    // reopen chain walk; it did not spawn a fresh transcript of its own.
    expect(state.sessions['s-new']?.agentId).toBe('agent-new')
  })
})

// --- Story 3 (spec-in-chat-agent-switch): CAP-7 reopen redirect ------------

describe('switchAgent CAP-7 reopen (story 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(invoke as ReturnType<typeof vi.fn>).mockReset()
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetAcpAuthForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetLiveSwitchSourcesForTesting()
    _clearPayloadCacheForTesting()
    useAcpStore.setState(FRESH)
    workspaceStateRef.current = {
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    }
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-s-old',
      tabs: [{ type: 'agent-chat', id: 'chat-s-old', sessionId: 's-old' }]
    }
  })

  it('REDIRECT: reopening a switched chat continues on the new agent/session', async () => {
    // OLD session payload: pre-switch transcript + the switch marker.
    setCachedSessionPayload('s-old', {
      metadata: {
        id: 's-old',
        agentId: 'agent-old',
        agentConfigId: 'cfg-old',
        title: 'Switched chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 10,
        messageCount: 2,
        lastSeq: 3,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello old agent' }],
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
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-3',
          fromConfigId: 'cfg-old',
          toConfigId: 'cfg-new',
          newSessionId: 's-new',
          summaryText: 'Handoff summary',
          timestamp: 3,
          seq: 3
        }
      ]
    })
    // NEW session payload: the continuation turns. REALISTIC shape — the
    // host assigns per-session seqs, so the new session's log restarts at 1
    // (a namespace that would collide with the old records without the
    // splice's re-stamping).
    setCachedSessionPayload('s-new', {
      metadata: {
        id: 's-new',
        agentId: 'agent-new',
        agentConfigId: 'cfg-new',
        title: 'Continuation',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 4,
        lastActivityAt: 8,
        messageCount: 2,
        lastSeq: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'new agent please continue' }],
          streaming: false,
          timestamp: 4,
          seq: 1
        },
        {
          id: 'snapshot:agent:2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'new agent reply' }],
          streaming: false,
          timestamp: 5,
          seq: 2
        }
      ] as never
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      recordAgentSwitch: vi.fn(async () => {}),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    // The new agent is live + load-capable so decideResume resolves 'load'.
    useAcpStore.setState({
      agentConfigs: [{ id: 'cfg-new', name: 'Claude', command: 'claude', args: [], env: {} }],
      agents: { 'agent-new': { id: 'agent-new', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-new': 'connected' }
    })

    await useAcpStore.getState().openHistorySession('s-old')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The continuation ran against the NEW session id — session/load carried
    // the new agent + new session, not the old pair.
    expect(loadSession).toHaveBeenCalledWith('agent-new', 's-new', '/work')
    expect(loadSession).not.toHaveBeenCalledWith(expect.anything(), 's-old', expect.anything())
    // The merged transcript renders under the NEW id in the right ORDER
    // (old turns → separator → new turns): the spliced old records are
    // re-stamped ABOVE the new session's max seq, so the seq-first timeline
    // sort keeps them before the continuation even though both payloads use
    // per-session seq spaces starting at 1.
    const merged = state.messages['s-new'] ?? []
    const texts = merged.map((m) => m.blocks.find((b) => b.type === 'text')?.text)
    expect(texts).toEqual([
      'hello old agent',
      'old agent reply',
      'new agent please continue',
      'new agent reply'
    ])
    // Spliced ids live in their own namespace (no React-key collision with
    // the new session's own `user:seq-1`).
    const ids = merged.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => id.startsWith('switch-splice:'))).toHaveLength(2)
    // The separator is re-stamped into the same namespace and lands between
    // the old and new turns.
    const switches = state.agentSwitches['s-new'] ?? []
    expect(switches.map((sw) => sw.id)).toEqual(['switch-splice:s-old:switch:seq-3'])
    const oldMaxSeq = Math.max(
      ...merged.filter((m) => m.id.startsWith('switch-splice:')).map((m) => m.seq ?? 0)
    )
    const newMinSeq = Math.min(
      ...merged.filter((m) => !m.id.startsWith('switch-splice:')).map((m) => m.seq ?? 0)
    )
    expect(oldMaxSeq).toBeLessThan(newMinSeq)
    expect(switches[0]?.seq).toBeLessThan(newMinSeq)
    // The tab was remapped old → new (the new id owns the ACTIVE conversation).
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith('s-old', 's-new')
    // The new session's record is the active chat.
    expect(state.sessions['s-new']?.agentId).toBe('agent-new')
    expect(state.sessions['s-new']?.status).toBe('active')
  })

  it('UNSWITCHED: reopening a chat with no switch markers takes the original path', async () => {
    setCachedSessionPayload('s-plain', {
      metadata: {
        id: 's-plain',
        agentId: 'agent-plain',
        agentConfigId: 'cfg-plain',
        title: 'Plain chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        lastSeq: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hi' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        },
        {
          id: 'snapshot:agent:2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'hello' }],
          streaming: false,
          timestamp: 2,
          seq: 2
        }
      ] as never
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agents: { 'agent-plain': { id: 'agent-plain', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-plain': 'connected' }
    })

    await useAcpStore.getState().openHistorySession('s-plain')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // Exactly the original path: load against the SAME session, no remap.
    expect(loadSession).toHaveBeenCalledWith('agent-plain', 's-plain', '/work')
    expect(workspaceStateRef.current.remapAgentChatSession).not.toHaveBeenCalled()
    expect(state.sessions['s-plain']?.status).toBe('active')
    expect((state.messages['s-plain'] ?? []).length).toBe(2)
  })

  it('CORRUPT: a missing newSessionId degrades to the original reopen path', async () => {
    setCachedSessionPayload('s-corrupt', {
      metadata: {
        id: 's-corrupt',
        agentId: 'agent-corrupt',
        agentConfigId: 'cfg-old',
        title: 'Corrupt marker chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 3,
        messageCount: 2,
        lastSeq: 3,
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
      ] as never,
      // Corrupt record: empty newSessionId (the documented degraded shape).
      switches: [
        {
          id: 'switch:seq-3',
          fromConfigId: 'cfg-old',
          toConfigId: 'cfg-new',
          newSessionId: '',
          summaryText: 'Handoff summary',
          timestamp: 3,
          seq: 3
        }
      ]
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agents: { 'agent-corrupt': { id: 'agent-corrupt', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-corrupt': 'connected' }
    })

    await useAcpStore.getState().openHistorySession('s-corrupt')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // Degraded to the ORIGINAL path: the old agent/session reconnected.
    expect(loadSession).toHaveBeenCalledWith('agent-corrupt', 's-corrupt', '/work')
    expect(workspaceStateRef.current.remapAgentChatSession).not.toHaveBeenCalled()
    expect(state.sessions['s-corrupt']?.status).toBe('active')
    // The corrupt marker still renders its separator on the old session.
    expect((state.agentSwitches['s-corrupt'] ?? []).map((sw) => sw.id)).toEqual(['switch:seq-3'])
  })

  it('REPEAT_OPEN: opening the switched chat twice does not double-splice', async () => {
    // Old payload with one switch marker → s-new; new payload (own seq space).
    setCachedSessionPayload('s-old', {
      metadata: {
        id: 's-old',
        agentId: 'agent-old',
        agentConfigId: 'cfg-old',
        title: 'Switched chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 10,
        messageCount: 2,
        lastSeq: 3,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello old agent' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-3',
          fromConfigId: 'cfg-old',
          toConfigId: 'cfg-new',
          newSessionId: 's-new',
          summaryText: 'Handoff summary',
          timestamp: 3,
          seq: 3
        }
      ]
    })
    setCachedSessionPayload('s-new', {
      metadata: {
        id: 's-new',
        agentId: 'agent-new',
        agentConfigId: 'cfg-new',
        title: 'Continuation',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 4,
        lastActivityAt: 8,
        messageCount: 1,
        lastSeq: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'new agent turn' }],
          streaming: false,
          timestamp: 4,
          seq: 1
        }
      ] as never
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agentConfigs: [{ id: 'cfg-new', name: 'Claude', command: 'claude', args: [], env: {} }],
      agents: { 'agent-new': { id: 'agent-new', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-new': 'connected' }
    })

    await useAcpStore.getState().openHistorySession('s-old')
    await flushTurnEnd()
    const first = useAcpStore.getState().messages['s-new'] ?? []
    expect(first).toHaveLength(2)

    // The second open of the OLD session (the sidebar row still exists):
    // close the new session record first so the open re-runs (a cached
    // non-closed session early-returns).
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-new': s.sessions['s-new'] ? { ...s.sessions['s-new']!, status: 'closed' } : s.sessions
      }
    }))
    await useAcpStore.getState().openHistorySession('s-old')
    await flushTurnEnd()

    // The splice is idempotent: the re-stamped old ids already exist in the
    // target list, so no [old, old, new] duplication.
    const second = useAcpStore.getState().messages['s-new'] ?? []
    const texts = second.map((m) => m.blocks.find((b) => b.type === 'text')?.text)
    expect(texts).toEqual(['hello old agent', 'new agent turn'])
  })

  it('TWO_HOP: A→B→C reopens land on the FINAL session with the full chain', async () => {
    // s-a: pre-switch turn + marker → s-b (per-session seqs from 1).
    setCachedSessionPayload('s-a', {
      metadata: {
        id: 's-a',
        agentId: 'agent-a',
        agentConfigId: 'cfg-a',
        title: 'A',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 3,
        messageCount: 1,
        lastSeq: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'turn on A' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-2',
          fromConfigId: 'cfg-a',
          toConfigId: 'cfg-b',
          newSessionId: 's-b',
          summaryText: 'A to B',
          timestamp: 2,
          seq: 2
        }
      ]
    })
    // s-b: B's own turn + marker → s-c.
    setCachedSessionPayload('s-b', {
      metadata: {
        id: 's-b',
        agentId: 'agent-b',
        agentConfigId: 'cfg-b',
        title: 'B',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 2,
        lastActivityAt: 6,
        messageCount: 2,
        lastSeq: 3,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'turn on B' }],
          streaming: false,
          timestamp: 3,
          seq: 1
        },
        {
          id: 'snapshot:agent:2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'B reply' }],
          streaming: false,
          timestamp: 4,
          seq: 2
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-3',
          fromConfigId: 'cfg-b',
          toConfigId: 'cfg-c',
          newSessionId: 's-c',
          summaryText: 'B to C',
          timestamp: 5,
          seq: 3
        }
      ]
    })
    // s-c: the FINAL session — no outgoing switch.
    setCachedSessionPayload('s-c', {
      metadata: {
        id: 's-c',
        agentId: 'agent-c',
        agentConfigId: 'cfg-c',
        title: 'C',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 5,
        lastActivityAt: 8,
        messageCount: 1,
        lastSeq: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'turn on C' }],
          streaming: false,
          timestamp: 6,
          seq: 1
        }
      ] as never
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agentConfigs: [
        { id: 'cfg-b', name: 'Bee', command: 'bee', args: [], env: {} },
        { id: 'cfg-c', name: 'Cee', command: 'cee', args: [], env: {} }
      ],
      agents: {
        'agent-c': { id: 'agent-c', capabilities: { loadSession: true } }
      },
      agentStatus: { 'agent-c': 'connected' }
    })
    // The tab starts on A.
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-s-a',
      tabs: [{ type: 'agent-chat', id: 'chat-s-a', sessionId: 's-a' }]
    }

    await useAcpStore.getState().openHistorySession('s-a')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // ONE final target: the load ran for the FINAL session (C), never the
    // intermediate hop.
    expect(loadSession).toHaveBeenCalledWith('agent-c', 's-c', '/work')
    expect(loadSession).not.toHaveBeenCalledWith(expect.anything(), 's-b', expect.anything())
    // The tab moved straight to the FINAL session — no intermediate steal.
    const remaps = workspaceStateRef.current.remapAgentChatSession.mock.calls
    expect(remaps).toEqual([['s-a', 's-c']])
    // The FINAL session holds the whole chain: A's turn + B's turns + C's turn.
    const texts = (state.messages['s-c'] ?? []).map(
      (m) => m.blocks.find((b) => b.type === 'text')?.text
    )
    expect(texts).toEqual(['turn on A', 'turn on B', 'B reply', 'turn on C'])
    expect(state.sessions['s-c']?.agentId).toBe('agent-c')
    expect(state.sessions['s-c']?.status).toBe('active')
  })

  it('RESUME_REDIRECT: resumeLiveSession redirects a switched chat to the final session', async () => {
    setCachedSessionPayload('s-res', {
      metadata: {
        id: 's-res',
        agentId: 'agent-r',
        agentConfigId: 'cfg-old',
        title: 'Resumed chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 4,
        messageCount: 1,
        lastSeq: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'pre-switch turn' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-2',
          fromConfigId: 'cfg-old',
          toConfigId: 'cfg-new',
          newSessionId: 's-rnew',
          summaryText: 'Handoff',
          timestamp: 2,
          seq: 2
        }
      ]
    })
    setCachedSessionPayload('s-rnew', {
      metadata: {
        id: 's-rnew',
        agentId: 'agent-rn',
        agentConfigId: 'cfg-new',
        title: 'Continuation',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 3,
        lastActivityAt: 5,
        messageCount: 1,
        lastSeq: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'new session turn' }],
          streaming: false,
          timestamp: 3,
          seq: 1
        }
      ] as never
    })
    const loadSession = vi.fn(async () => ({}))
    const resumeSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      resumeSession,
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agentConfigs: [{ id: 'cfg-new', name: 'Claude', command: 'claude', args: [], env: {} }],
      agents: { 'agent-rn': { id: 'agent-rn', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-rn': 'connected' }
    })
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-s-res',
      tabs: [{ type: 'agent-chat', id: 'chat-s-res', sessionId: 's-res' }]
    }

    await useAcpStore.getState().resumeLiveSession('s-res', 'agent-r', '/w')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The caller's (pre-switch) agent was superseded: the continuation opened
    // the NEW session — no resume against the stale pair.
    expect(resumeSession).not.toHaveBeenCalledWith('agent-r', 's-res', '/w')
    expect(loadSession).toHaveBeenCalledWith('agent-rn', 's-rnew', '/w')
    // The merged transcript + separator landed under the NEW id.
    const texts = (state.messages['s-rnew'] ?? []).map(
      (m) => m.blocks.find((b) => b.type === 'text')?.text
    )
    expect(texts).toEqual(['pre-switch turn', 'new session turn'])
    expect((state.agentSwitches['s-rnew'] ?? []).map((sw) => sw.id)).toEqual([
      'switch-splice:s-res:switch:seq-2'
    ])
    // The old session's resume window closed (no lingering replaying state).
    expect(state.sessions['s-res']?.replaying).toBeNull()
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith('s-res', 's-rnew')
  })

  // --- Story 6 (spec-in-chat-agent-switch): CAP-7 failure-mode regressions

  it('LAST_SWITCH_WINS: TWO markers on one session — the SECOND supersedes, never the first', async () => {
    // One session whose payload carries TWO markers (a re-switch recorded on
    // the same source session): the LAST one must win — the FIRST is a
    // superseded hop, not the reopen target.
    setCachedSessionPayload('s-two', {
      metadata: {
        id: 's-two',
        agentId: 'agent-two',
        agentConfigId: 'cfg-a',
        title: 'Double switch',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 8,
        messageCount: 1,
        lastSeq: 5,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'turn before both switches' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        }
      ] as never,
      switches: [
        {
          id: 'switch:seq-2',
          fromConfigId: 'cfg-a',
          toConfigId: 'cfg-b',
          newSessionId: 's-first-hop',
          summaryText: 'first switch',
          timestamp: 2,
          seq: 2
        },
        {
          id: 'switch:seq-5',
          fromConfigId: 'cfg-b',
          toConfigId: 'cfg-c',
          newSessionId: 's-final',
          summaryText: 'second switch supersedes',
          timestamp: 5,
          seq: 5
        }
      ]
    })
    // The FIRST hop's payload exists and is resolvable — reopening it would
    // be the regression (the last marker is authoritative).
    setCachedSessionPayload('s-first-hop', {
      metadata: {
        id: 's-first-hop',
        agentId: 'agent-b',
        agentConfigId: 'cfg-b',
        title: 'First hop',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 2,
        lastActivityAt: 3,
        messageCount: 1,
        lastSeq: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'turn on the superseded hop' }],
          streaming: false,
          timestamp: 2,
          seq: 1
        }
      ] as never
    })
    setCachedSessionPayload('s-final', {
      metadata: {
        id: 's-final',
        agentId: 'agent-c',
        agentConfigId: 'cfg-c',
        title: 'Final',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 5,
        lastActivityAt: 7,
        messageCount: 1,
        lastSeq: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'turn on the final session' }],
          streaming: false,
          timestamp: 6,
          seq: 1
        }
      ] as never
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agentConfigs: [{ id: 'cfg-c', name: 'Cee', command: 'cee', args: [], env: {} }],
      agents: { 'agent-c': { id: 'agent-c', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-c': 'connected' }
    })
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-s-two',
      tabs: [{ type: 'agent-chat', id: 'chat-s-two', sessionId: 's-two' }]
    }

    await useAcpStore.getState().openHistorySession('s-two')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // The FINAL session (the LAST marker's target) owns the reopen — never
    // the superseded first hop and never the original session.
    expect(loadSession).toHaveBeenCalledWith('agent-c', 's-final', '/work')
    expect(loadSession).not.toHaveBeenCalledWith(
      expect.anything(),
      's-first-hop',
      expect.anything()
    )
    expect(loadSession).not.toHaveBeenCalledWith(expect.anything(), 's-two', expect.anything())
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith('s-two', 's-final')
    expect(state.sessions['s-final']?.agentId).toBe('agent-c')
    // The merged transcript under the FINAL id carries the pre-switch turn
    // (spliced) + the final session's own turn — and never the superseded
    // hop's content.
    const finalMessages = state.messages['s-final'] ?? []
    expect(finalMessages.map((m) => (m.blocks[0] as { text?: string })?.text ?? '')).toContain(
      'turn before both switches'
    )
    expect(finalMessages.map((m) => (m.blocks[0] as { text?: string })?.text ?? '')).toContain(
      'turn on the final session'
    )
    expect(finalMessages.map((m) => (m.blocks[0] as { text?: string })?.text ?? '')).not.toContain(
      'turn on the superseded hop'
    )
  })

  it('UNSWITCHED_NO_SWITCH_MACHINERY: a chat with no markers fires no resolution, remap, or extra loads', async () => {
    // A plain unswitched chat: the byte-identical install path. The failure
    // mode this pins is anything switch-related firing on it — marker
    // resolution (a payload fetch for a nonexistent hop), a remap, or a
    // second loadSession.
    setCachedSessionPayload('s-plain-un', {
      metadata: {
        id: 's-plain-un',
        agentId: 'agent-plain',
        agentConfigId: 'cfg-plain',
        title: 'Plain chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        lastSeq: 2,
        status: 'closed'
      },
      messages: [
        {
          id: 'user:seq-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hi' }],
          streaming: false,
          timestamp: 1,
          seq: 1
        },
        {
          id: 'snapshot:agent:2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'hello' }],
          streaming: false,
          timestamp: 2,
          seq: 2
        }
      ] as never
    })
    const loadSession = vi.fn(async () => ({}))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession,
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState({
      agents: { 'agent-plain': { id: 'agent-plain', capabilities: { loadSession: true } } },
      agentStatus: { 'agent-plain': 'connected' }
    })
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-s-plain-un',
      tabs: [{ type: 'agent-chat', id: 'chat-s-plain-un', sessionId: 's-plain-un' }]
    }

    await useAcpStore.getState().openHistorySession('s-plain-un')
    await flushTurnEnd()

    const state = useAcpStore.getState()
    // Exactly ONE load for the ORIGINAL pair — no chain walk (a second
    // loadSession or any other-session load means the redirect fired).
    expect(loadSession).toHaveBeenCalledTimes(1)
    expect(loadSession).toHaveBeenCalledWith('agent-plain', 's-plain-un', '/work')
    // Nothing switch-related: no remap, no tab surgery, no markers, and the
    // payload was fetched exactly once (no hop resolution re-read).
    expect(workspaceStateRef.current.remapAgentChatSession).not.toHaveBeenCalled()
    expect(addAgentChatTabSpy).not.toHaveBeenCalled()
    expect(workspaceStateRef.current.removeTab).not.toHaveBeenCalled()
    // The install writes the (empty) switches list — no markers, and no
    // switch machinery ran (the load-count assertion above proves that).
    expect(state.agentSwitches['s-plain-un']).toEqual([])
    expect((state.messages['s-plain-un'] ?? []).map((m) => m.id)).toEqual([
      'user:seq-1',
      'snapshot:agent:2'
    ])
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    expect(vi.mocked(loadSessionPayload)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(loadSessionPayload)).toHaveBeenCalledWith('s-plain-un')
  })
})

describe('composer option fidelity', () => {
  const invokeCallsFor = (command: string) =>
    vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === command)
      .map((c) => c[1] as Record<string, unknown>)

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
    workspaceStateRef.current = {
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    }
  })

  describe('creation-default echo protection', () => {
    it('createSession records creationOptionDefaults from the session/new outcome', async () => {
      useAcpStore.setState({
        agents: { 'agent-1': { id: 'agent-1', capabilities: {}, authMethods: [] } },
        agentStatus: { 'agent-1': 'connected' }
      })
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'acp_new_session')
          return {
            sessionId: 's1',
            modes: {
              currentModeId: 'agent',
              availableModes: [makeMode('agent'), makeMode('plan')]
            },
            models: { currentModelId: 'm1', availableModels: [makeModel('m1'), makeModel('m2')] },
            configOptions: [makeConfigOption('thought_level', 'low', ['low', 'max'])]
          }
        throw new Error(`unexpected invoke command: ${command}`)
      })

      await useAcpStore.getState().createSession('agent-1', '/work', [], 'p1')
      const session = useAcpStore.getState().sessions['s1']
      expect(session.creationOptionDefaults).toEqual({
        modeId: 'agent',
        modelId: 'm1',
        configValues: { thought_level: 'low' }
      })
    })

    it('_onSessionCreated fills empty fields but never clobbers populated ones', () => {
      seedOptionsSession('s1', 'agent-1', {
        modes: { currentModeId: 'bypass', availableModes: [makeMode('agent'), makeMode('bypass')] },
        models: { currentModelId: 'm2', availableModels: [makeModel('m1'), makeModel('m2')] },
        configOptions: [makeConfigOption('thought_level', 'max', ['low', 'max'])],
        creationOptionDefaults: {
          modeId: 'agent',
          modelId: 'm1',
          configValues: { thought_level: 'low' }
        }
      })

      useAcpStore.getState()._onSessionCreated({
        agentId: 'agent-1',
        sessionId: 's1',
        modes: { currentModeId: 'agent', availableModes: [makeMode('agent'), makeMode('bypass')] },
        models: { currentModelId: 'm1', availableModels: [makeModel('m1'), makeModel('m2')] },
        configOptions: [makeConfigOption('thought_level', 'low', ['low', 'max'])]
      })

      const session = useAcpStore.getState().sessions['s1']
      // The stale event re-asserts creation defaults — local selections win.
      expect(session.modes?.currentModeId).toBe('bypass')
      expect(session.models?.currentModelId).toBe('m2')
      expect(session.configOptions[0]?.currentValue).toBe('max')
      expect(session.creationOptionDefaults?.modeId).toBe('agent')
    })

    it('_onSessionCreated populates an event stub with the payload as creation defaults', () => {
      useAcpStore.getState()._onSessionCreated({
        agentId: 'agent-1',
        sessionId: 's-stub',
        modes: { currentModeId: 'agent', availableModes: [makeMode('agent'), makeMode('plan')] },
        models: null,
        configOptions: [makeConfigOption('thought_level', 'low', ['low', 'max'])]
      })

      const session = useAcpStore.getState().sessions['s-stub']
      expect(session).toBeDefined()
      expect(session.modes?.currentModeId).toBe('agent')
      expect(session.creationOptionDefaults).toEqual({
        modeId: 'agent',
        modelId: undefined,
        configValues: { thought_level: 'low' }
      })
    })

    it('_onModeUpdate preserves a moved-off mode against a creation-default echo', () => {
      seedOptionsSession('s1', 'agent-1', {
        modes: { currentModeId: 'bypass', availableModes: [makeMode('agent'), makeMode('bypass')] },
        creationOptionDefaults: { modeId: 'agent', configValues: {} }
      })

      // Stale echo of the creation default: preserved.
      useAcpStore.getState()._onModeUpdate({
        agentId: 'agent-1',
        sessionId: 's1',
        currentModeId: 'agent',
        availableModes: [makeMode('agent'), makeMode('bypass')]
      })
      expect(useAcpStore.getState().sessions['s1'].modes?.currentModeId).toBe('bypass')
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'acp.modeEchoPreserved', level: 'warn' })
      )

      // A NON-default incoming value is a genuine agent-side change: applies.
      vi.mocked(logFrontendError).mockClear()
      useAcpStore.getState()._onModeUpdate({
        agentId: 'agent-1',
        sessionId: 's1',
        currentModeId: 'plan',
        availableModes: [makeMode('agent'), makeMode('bypass'), makeMode('plan')]
      })
      expect(useAcpStore.getState().sessions['s1'].modes?.currentModeId).toBe('plan')
    })

    it('_onConfigOptionsUpdate preserves moved-off values against creation-default echoes', () => {
      seedOptionsSession('s1', 'agent-1', {
        configOptions: [
          makeConfigOption('thought_level', 'max', ['low', 'max', 'high']),
          makeConfigOption('other', 'x', ['x', 'y'])
        ],
        creationOptionDefaults: { configValues: { thought_level: 'low', other: 'x' } }
      })

      // Stale echo: thought_level re-asserts 'low' while 'other' moves to a
      // genuinely new value — the default echoes are pinned, the real change flows.
      useAcpStore.getState()._onConfigOptionsUpdate({
        agentId: 'agent-1',
        sessionId: 's1',
        configOptions: [
          makeConfigOption('thought_level', 'low', ['low', 'max', 'high']),
          makeConfigOption('other', 'y', ['x', 'y'])
        ]
      })
      const options = useAcpStore.getState().sessions['s1'].configOptions
      expect(options.find((o) => o.id === 'thought_level')?.currentValue).toBe('max')
      expect(options.find((o) => o.id === 'other')?.currentValue).toBe('y')
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'acp.configOptionEchoPreserved', level: 'warn' })
      )
    })

    it('setConfigOption response snapshots cannot re-assert creation defaults on moved-off options', async () => {
      seedOptionsSession('s1', 'agent-1', {
        configOptions: [
          makeConfigOption('thought_level', 'max', ['low', 'max']),
          makeConfigOption('other', 'x', ['x', 'y'])
        ],
        creationOptionDefaults: { configValues: { thought_level: 'low', other: 'x' } }
      })
      // The response acknowledges 'other' → 'y' but echoes the creation
      // default for the already-moved-off thought_level.
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'acp_set_config_option')
          return [
            makeConfigOption('thought_level', 'low', ['low', 'max']),
            makeConfigOption('other', 'y', ['x', 'y'])
          ]
        throw new Error(`unexpected invoke command: ${command}`)
      })

      await useAcpStore.getState().setConfigOption('s1', 'other', 'y')

      const options = useAcpStore.getState().sessions['s1'].configOptions
      expect(options.find((o) => o.id === 'thought_level')?.currentValue).toBe('max')
      expect(options.find((o) => o.id === 'other')?.currentValue).toBe('y')
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'acp.configOptionEchoPreserved', level: 'warn' })
      )
    })
  })

  describe('armed-switch option scoping', () => {
    const cfgOldReuseKey = () => agentReuseKey('cfg-old', '/work')
    const cfgNewReuseKey = () => agentReuseKey('cfg-new', '/work')

    beforeEach(() => {
      // Old session on cfg-old/agent-old; target cfg-new warm-pool session
      // already prepared (prepareChat short-circuits on preparedSessions).
      useAcpStore.setState({
        agentConfigs: [
          { id: 'cfg-old', name: 'Gemini', command: 'gemini', args: [], env: {} },
          { id: 'cfg-new', name: 'Claude', command: 'claude', args: [], env: {} }
        ],
        agents: {
          'agent-old': { id: 'agent-old', capabilities: {}, authMethods: [] },
          'agent-new': { id: 'agent-new', capabilities: {}, authMethods: [] }
        },
        agentStatus: { 'agent-old': 'connected', 'agent-new': 'connected' },
        configToLiveAgent: {
          [cfgOldReuseKey()]: 'agent-old',
          [cfgNewReuseKey()]: 'agent-new'
        },
        preparedSessions: { [prepareChatKey('cfg-new', '/work', undefined)]: 's-warm' },
        sessionIndex: [
          {
            id: 's-old',
            agentId: 'agent-old',
            agentConfigId: 'cfg-old',
            title: 'Old chat',
            cwd: '/work',
            projectId: 'p1',
            createdAt: 1,
            lastActivityAt: 2,
            messageCount: 0,
            lastSeq: 0,
            status: 'active'
          }
        ]
      })
      seedOptionsSession('s-old', 'agent-old', {
        modes: { currentModeId: 'agent', availableModes: [makeMode('agent'), makeMode('bypass')] },
        configOptions: [makeConfigOption('thought_level', 'low', ['low', 'max'])]
      })
      seedOptionsSession('s-warm', 'agent-new', {
        modes: {
          currentModeId: 'chat',
          availableModes: [makeMode('chat'), makeMode('code')]
        },
        configOptions: [
          makeConfigOption('model', 'm1', ['m1', 'm2'], 'model'),
          makeConfigOption('thought_level', 'low', ['low', 'max'])
        ]
      })
      // Warm-pool sessions are backend-ephemeral: mark 's-warm' so
      // ensureLiveAgent keeps agent-new for the switch instead of detaching
      // it for a fresh spawn (a real prepared session is created with
      // ephemeral: true).
      _addEphemeralSessionIdForTesting('s-warm')
      workspaceStateRef.current.root = {
        type: 'leaf',
        id: 'pane-1',
        activeTabId: 'chat-s-old',
        tabs: [{ type: 'agent-chat', id: 'chat-s-old', sessionId: 's-old' }]
      }
    })

    it('setSwitchPendingOption queues picks on the switch without touching the old session', async () => {
      // The warm session already shows the picked values → the live preview
      // apply is a no-op; persistence is still asserted via writeDebounced.
      await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
      vi.mocked(invoke).mockClear()
      mockPersistenceApi.writeDebounced.mockClear()

      await useAcpStore.getState().setSwitchPendingOption('s-old', {
        modeId: 'code',
        configValues: { thought_level: 'max' }
      })

      const session = useAcpStore.getState().sessions['s-old']
      expect(session.switching).toEqual({
        toConfigId: 'cfg-new',
        status: 'pending',
        pendingOptions: {
          modelId: undefined,
          modeId: 'code',
          configValues: { thought_level: 'max' }
        }
      })
      // Persisted under the TARGET config — never the old config's key.
      // persistComposerOptions resolves on its own queue (read → debounced
      // write), so wait for the write to land rather than racing it.
      await vi.waitFor(() =>
        expect(mockPersistenceApi.writeDebounced).toHaveBeenCalledWith(
          'agents/composer-options/cfg-new',
          expect.objectContaining({ modeId: 'code', configValues: { thought_level: 'max' } })
        )
      )
      expect(
        vi
          .mocked(mockPersistenceApi.writeDebounced)
          .mock.calls.some((c) => c[0] === 'agents/composer-options/cfg-old')
      ).toBe(false)
      // The old session's option state + its agent's wire are untouched.
      expect(session.configOptions[0]?.currentValue).toBe('low')
      expect(session.modes?.currentModeId).toBe('agent')
      for (const command of ['acp_set_mode', 'acp_set_model', 'acp_set_config_option']) {
        expect(invokeCallsFor(command).filter((c) => c.sessionId === 's-old')).toEqual([])
      }
    })

    it('switchAgent applies armed picks to the NEW session before the handoff prompt', async () => {
      vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
        if (command === 'acp_new_session')
          return {
            sessionId: 's-new',
            modes: {
              currentModeId: 'chat',
              availableModes: [makeMode('chat'), makeMode('code')]
            },
            models: null,
            configOptions: [
              makeConfigOption('model', 'm1', ['m1', 'm2'], 'model'),
              makeConfigOption('thought_level', 'low', ['low', 'max'])
            ]
          }
        if (command === 'acp_set_mode') return undefined
        if (command === 'acp_set_model') return undefined
        if (command === 'acp_set_config_option') {
          const { configId, valueId } = args as { configId: string; valueId: string }
          return [
            makeConfigOption('model', 'm1', ['m1', 'm2'], 'model'),
            makeConfigOption('thought_level', 'low', ['low', 'max'])
          ].map((o) => (o.id === configId ? { ...o, currentValue: valueId } : o))
        }
        if (command === 'acp_send_prompt') return 'end_turn'
        if (command === 'acp_record_agent_switch') return undefined
        throw new Error(`unexpected invoke command: ${command}`)
      })
      useAcpStore.setState({
        messages: {
          ...useAcpStore.getState().messages,
          's-old': [
            {
              id: 'm1',
              role: 'user',
              blocks: [{ type: 'text', text: 'hello' }],
              streaming: false,
              timestamp: 1,
              seq: 1
            }
          ] as never
        }
      })

      await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
      await useAcpStore.getState().setSwitchPendingOption('s-old', {
        modelId: 'm2',
        modeId: 'code',
        configValues: { thought_level: 'max' }
      })
      // The live-preview apply already ran the picks against s-warm; clear
      // the recorded calls so the assertions below see only switch-time calls.
      vi.mocked(invoke).mockClear()

      await useAcpStore.getState().switchAgent('s-old', 'cfg-new', { pendingText: 'go' })
      await flushTurnEnd()

      // Armed picks applied to the NEW session (order: options before prompt).
      const orderedCommands = vi.mocked(invoke).mock.calls.map((c) => c[0])
      const sendIdx = orderedCommands.indexOf('acp_send_prompt')
      expect(sendIdx).toBeGreaterThan(-1)
      for (const command of ['acp_set_mode', 'acp_set_config_option']) {
        for (const call of invokeCallsFor(command)) {
          expect(call.sessionId).toBe('s-new')
          expect(orderedCommands.indexOf(command)).toBeLessThan(sendIdx)
        }
      }
      // modeId 'code' differs from the s-new creation mode 'chat' → wire call.
      expect(invokeCallsFor('acp_set_mode')).toEqual([
        expect.objectContaining({ agentId: 'agent-new', sessionId: 's-new', modeId: 'code' })
      ])
      // model 'm2' lands via the model-category config option; thought_level too.
      const configCalls = invokeCallsFor('acp_set_config_option')
      expect(configCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: 's-new', configId: 'model', valueId: 'm2' }),
          expect.objectContaining({ sessionId: 's-new', configId: 'thought_level', valueId: 'max' })
        ])
      )
      // No setter ever touched the OLD session or its agent.
      for (const command of ['acp_set_mode', 'acp_set_model', 'acp_set_config_option']) {
        expect(invokeCallsFor(command).filter((c) => c.sessionId === 's-old')).toEqual([])
      }
      expect(useAcpStore.getState().sessions['s-old'].configOptions[0]?.currentValue).toBe('low')
    })

    it('setSwitchPendingOption drops picks when no switch is armed (warn-logged, nothing persisted)', async () => {
      vi.mocked(logFrontendError).mockClear()
      mockPersistenceApi.writeDebounced.mockClear()

      await useAcpStore.getState().setSwitchPendingOption('s-old', { modeId: 'code' })

      expect(useAcpStore.getState().sessions['s-old'].switching).toBeFalsy()
      expect(mockPersistenceApi.writeDebounced).not.toHaveBeenCalled()
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'acp.setSwitchPendingOption', level: 'warn' })
      )
    })

    it('setSwitchPendingOption drops picks once the switch is executing', async () => {
      // Gate session/new so switchAgent stays in-flight while a pick lands.
      let resolveNewSession!: (value: unknown) => void
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'acp_new_session')
          return await new Promise((resolve) => {
            resolveNewSession = resolve
          })
        if (command === 'acp_send_prompt') return 'end_turn'
        if (command === 'acp_record_agent_switch') return undefined
        throw new Error(`unexpected invoke command: ${command}`)
      })
      await useAcpStore.getState().armAgentSwitch('s-old', 'cfg-new')
      vi.mocked(logFrontendError).mockClear()
      mockPersistenceApi.writeDebounced.mockClear()

      const switchPromise = useAcpStore
        .getState()
        .switchAgent('s-old', 'cfg-new', { pendingText: 'go' })
      await vi.waitFor(() => expect(invokeCallsFor('acp_new_session')).toHaveLength(1))

      await useAcpStore.getState().setSwitchPendingOption('s-old', { modeId: 'code' })

      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'acp.setSwitchPendingOption',
          level: 'warn',
          message: expect.stringContaining('already executing')
        })
      )
      expect(useAcpStore.getState().sessions['s-old'].switching?.pendingOptions).toBeUndefined()
      expect(mockPersistenceApi.writeDebounced).not.toHaveBeenCalled()

      resolveNewSession({ sessionId: 's-new' })
      await switchPromise
    })
  })
})
