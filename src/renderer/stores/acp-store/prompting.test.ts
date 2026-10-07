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
import { commandToken } from '@/lib/skill-tokens'
import {
  _acceptedServerPromptTurnIdsForTesting,
  _flushCoalescedForTesting,
  _resetAcceptedServerPromptTurnIdsForTesting,
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
import { flushNextQueuedPrompt } from './slices/prompt'
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

  it('retryCrashedSession re-dispatches sanitized wire text for a command-token turn (no sentinel leaks)', async () => {
    // The last user message's DISPLAY text carries the raw command token
    // (timeline renders the chip). The replayed resend must dispatch the
    // sanitized wire text — `/compact hello` — while the transcript keeps the
    // token blocks so the timeline keeps chips.
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
        's-crash': {
          id: 's-crash',
          agentId: 'agent-1',
          cwd: '/w',
          projectId: 'p1',
          status: 'error',
          title: null,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: 'agent crashed',
          createdAt: 1
        }
      },
      messages: {
        's-crash': [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: `${commandToken('compact')} hello` }],
            streaming: false,
            timestamp: 0
          }
        ]
      }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-crash',
        agentId: 'agent-1',
        title: 'Crash',
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
          blocks: [{ type: 'text', text: `${commandToken('compact')} hello` }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    const dispatched: Array<{ cmd: string; args: unknown }> = []
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string, args: unknown) => {
      dispatched.push({ cmd, args })
      if (cmd === 'acp_resume_session')
        return {
          modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] }
        }
      if (cmd === 'acp_send_prompt') return 'end_turn'
      return undefined
    })

    await useAcpStore.getState().retryCrashedSession('s-crash')
    await flushTurnEnd()

    const sendCall = dispatched.find((d) => d.cmd === 'acp_send_prompt')
    expect(sendCall).toBeDefined()
    // The re-sent prompt text is the sanitized wire: `/compact hello`,
    // byte-identical to a fresh send of the same composer value.
    // Wire args carry the sanitized text; displayContent carries the token
    // display blocks by design (the durable bubble replays display text).
    const sendArgs = sendCall!.args as {
      sessionId: string
      text: string
      displayContent?: Array<{ type: string; text: string }>
    }
    expect(sendArgs.text).toBe('/compact hello')
    // No private-use sentinel leaks into the dispatched WIRE fields.
    const { displayContent, ...wireArgs } = sendArgs
    expect(JSON.stringify(wireArgs)).not.toMatch(/[\uE000-\uE007]/)
    expect(displayContent).toEqual([{ type: 'text', text: `${commandToken('compact')} hello` }])
    // The timeline keeps the token display blocks (chips still render).
    const msgs = useAcpStore.getState().messages['s-crash']
    let lastUser: (typeof msgs)[number] | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUser = msgs[i]
        break
      }
    }
    expect(lastUser?.blocks).toEqual([{ type: 'text', text: `${commandToken('compact')} hello` }])
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

  it('queues a prompt sent while a history reopen is in flight, then flushes onto the repointed agent', async () => {
    // Mid-reopen shape: the install stamps status 'closed' while
    // `openingHistoryIds` marks the open in flight. A send typed in that
    // window must QUEUE — dispatching would hit the pre-repoint (possibly
    // dead) agentId with `unknown agent`.
    seedSession('s1', 'agent-dead', false)
    useAcpStore.setState((s) => ({
      sessions: { s1: { ...s.sessions.s1, status: 'closed', agentId: 'agent-dead' } },
      openingHistoryIds: { s1: true }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))

    await useAcpStore.getState().sendPrompt('s1', 'typed mid-reopen')
    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(1)
    expect(useAcpStore.getState().promptQueues['s1'][0].blocks).toEqual([
      { type: 'text', text: 'typed mid-reopen' }
    ])
    // Nothing dispatched and no optimistic bubble painted yet.
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)

    // The open lands: repoint + 'active' + marker drop, then the open's
    // finally flushes — the send runs on the NEW agent, never the dead one.
    useAcpStore.setState((s) => ({
      sessions: {
        s1: { ...s.sessions.s1, status: 'active', agentId: 'agent-live' }
      },
      openingHistoryIds: {}
    }))
    flushNextQueuedPrompt(useAcpStore.setState, 's1')
    await Promise.resolve()
    await Promise.resolve()

    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(0)
    expect(useAcpStore.getState().messages['s1']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s1'][0].blocks).toEqual([
      { type: 'text', text: 'typed mid-reopen' }
    ])
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(true)
  })

  it('queues a prompt sent while a reopen marker is set even on an active record', async () => {
    // The tail of the open: `withSessionActive` already flipped status to
    // 'active' but the marker still runs until the finally — sends here must
    // queue so they never race the repoint.
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState({ openingHistoryIds: { s1: true } })
    await useAcpStore.getState().sendPrompt('s1', 'still opening')
    expect(useAcpStore.getState().promptQueues['s1']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
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
})

// --- Issue #846: Retry after a mid-turn transport drop ------------------------

describe('issue #846: transport drop after server-accepted prompt', () => {
  beforeEach(() => {
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetLiveSwitchSourcesForTesting()
    _resetAcceptedServerPromptTurnIdsForTesting()
    useAcpStore.setState(FRESH)
  })

  it('keeps the turn in-flight (no error banner, no queue re-send) when the drop follows an accepted prompt', async () => {
    // The server accepts the prompt BEFORE dispatching to the agent: the
    // `user_prompt` echo lands first. A later WS drop then leaves the outcome
    // UNKNOWN — the agent keeps running server-side and the reconnect
    // resubscribe replays the rest of the turn. `runPromptTurn` must keep
    // `activeTurn` + `openTurnId` (spinner/stop button stay) and NOT set
    // `lastError` (the Retry affordance must not blindly re-send a prompt
    // that is already running).
    seedSession('s1', 'agent-1', false)
    // The dispatch promise rejects with the transport-drop error later.
    let rejectDispatch!: (reason: unknown) => void
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectDispatch = reject
      })
    )
    const dispatched = useAcpStore.getState().sendPrompt('s1', 'do the deploy')
    await Promise.resolve()
    // The server's accepted-prompt echo arrives (proof of acceptance).
    const turnId = useAcpStore.getState().messages['s1'][0].id.slice('turn:'.length)
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's1',
      turnId,
      content: [{ type: 'text', text: 'do the deploy' }]
    })
    // Now the connection drops mid-turn.
    rejectDispatch(
      new (await import('@/lib/acp-transport')).AcpTransportError('closed', 'WebSocket closed')
    )
    await dispatched.then(
      () => {},
      () => {}
    )
    await flushTurnEnd()
    const session = useAcpStore.getState().sessions['s1']
    expect(session.activeTurn).toBe(true)
    // `openTurnId` is the optimistic `newId('turn')` handle — the exact id
    // value is not the contract; what matters is that it is NON-NULL so the
    // spinner + stop button render.
    expect(session.openTurnId).toBeTypeOf('string')
    expect((session.openTurnId ?? '').length).toBeGreaterThan(0)
    expect(session.lastError).toBeNull()
    // The prompt was NOT recovered into the queue for a re-send.
    expect(useAcpStore.getState().promptQueues['s1']).toBeUndefined()
    // The accepted-turn marker was consumed by the unknown-outcome branch.
    expect(_acceptedServerPromptTurnIdsForTesting().has(turnId)).toBe(false)
  })

  it('still surfaces the error (re-send allowed) when the prompt was never accepted', async () => {
    // No `user_prompt` echo arrived before the drop → the server may never
    // have received the prompt; Retry re-sending is safe and the failure
    // surfaces as before.
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (await import('@/lib/acp-transport')).AcpTransportError('closed', 'WebSocket closed')
    )
    await useAcpStore
      .getState()
      .sendPrompt('s1', 'never accepted')
      .then(
        () => {},
        () => {}
      )
    await flushTurnEnd()
    const session = useAcpStore.getState().sessions['s1']
    expect(session.activeTurn).toBe(false)
    expect(session.openTurnId).toBeNull()
    expect(session.lastError).toContain('WebSocket closed')
  })
})

// --- Issue #838: activeTurn from a live user_prompt echo (second device) ------

describe('issue #838: live user_prompt echo marks the turn active', () => {
  beforeEach(() => {
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetLiveSwitchSourcesForTesting()
    _resetAcceptedServerPromptTurnIdsForTesting()
    useAcpStore.setState(FRESH)
  })

  it('a user_prompt echo from another device sets activeTurn + openTurnId so the spinner and stop button show', async () => {
    // The second device (or a reloaded tab) never ran the local prompt
    // dispatch — the ONLY signal it sees is the server's `user_prompt` echo.
    // Before the fix the turn state stayed idle; sending anything hit
    // `rate_limited` with no working-state UI.
    seedSession('s2', 'agent-1', false)
    expect(useAcpStore.getState().sessions['s2'].activeTurn).toBe(false)
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's2',
      turnId: 'turn-from-device-a',
      content: [{ type: 'text', text: 'long running task' }]
    })
    const session = useAcpStore.getState().sessions['s2']
    expect(session.activeTurn).toBe(true)
    expect(session.openTurnId).toBe('turn:turn-from-device-a')
    // The echo also renders the user bubble.
    expect(useAcpStore.getState().messages['s2']).toHaveLength(1)
    // Agent chunks now ingest (the openTurnId gate in mayStartChunkMessage
    // opens a bubble for the streaming reply — issue #847's second-device
    // reply text).
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's2',
      role: 'agent',
      content: { type: 'text', text: 'reply text' }
    })
    _flushCoalescedForTesting()
    const messages = useAcpStore.getState().messages['s2']
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('agent')
    expect(messages[1].blocks[0]).toEqual({ type: 'text', text: 'reply text' })
    // prompt_complete closes the turn.
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's2',
      stopReason: 'end_turn',
      turnId: 'turn-from-device-a'
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s2'].activeTurn).toBe(false)
    expect(useAcpStore.getState().sessions['s2'].openTurnId).toBeNull()
  })

  it("a duplicate echo (the sending device's own optimistic message) does not double-mark", async () => {
    // The sending device already staged the optimistic bubble with id
    // `turn:<id>`; the echo's dedup path must run BEFORE the turn marking so
    // the state is not re-stamped over a live turn with a fresh timestamp.
    seedSession('s3', 'agent-1', true)
    const before = useAcpStore.getState().sessions['s3']
    useAcpStore.setState({
      messages: {
        s3: [
          {
            id: 'turn:dup-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'same' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ]
      }
    })
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's3',
      turnId: 'dup-1',
      content: [{ type: 'text', text: 'same' }]
    })
    const after = useAcpStore.getState().sessions['s3']
    expect(after.activeTurn).toBe(before.activeTurn)
    expect(after.openTurnId).toBe(before.openTurnId)
    expect(useAcpStore.getState().messages['s3']).toHaveLength(1)
  })
})
