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

import {
  _clearPayloadCacheForTesting,
  setCachedSessionPayload
} from '@/lib/acp-history-persistence'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport,
  AcpTransportError
} from '@/lib/acp-transport'
import { commandToken, skillToken } from '@/lib/skill-tokens'
import {
  _flushCoalescedForTesting,
  _installTransportRecoveryForTesting,
  _resetCoalesceForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetLiveSwitchSourcesForTesting,
  initAcpEventListeners,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, flushTurnEnd, seedSession } from './testkit'

describe('replay render dedup on reconnect (story 11 / CAP-3 client half)', () => {
  beforeEach(() => {
    _clearPayloadCacheForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetLiveSwitchSourcesForTesting()
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetCoalesceForTesting()
    useAcpStore.setState(FRESH)
  })

  type TestMessage = {
    id: string
    role: 'user' | 'agent' | 'thought'
    blocks: Array<{ type: 'text'; text: string }>
    streaming: boolean
    timestamp: number
    seq: number
  }

  function msg(id: string, role: TestMessage['role'], text: string, seq: number): TestMessage {
    return {
      id,
      role,
      blocks: [{ type: 'text', text }],
      streaming: false,
      timestamp: seq,
      seq
    }
  }

  function seedServerPayload(id: string, messages: TestMessage[], lastSeq: number): void {
    setCachedSessionPayload(id, {
      metadata: {
        id,
        agentId: 'agent-1',
        title: 'Chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: messages.length,
        lastSeq,
        status: 'closed'
      },
      messages: messages as never
    })
  }

  function seedServerTransport(onLoad?: () => void): void {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession: vi.fn(async () => {
        onLoad?.()
        return {}
      }),
      dispose: vi.fn()
    } as unknown as AcpTransport)
  }

  it('renders the leading agent greeting and hides the empty synthetic turn', async () => {
    // Leading agent text is a real session update. An empty user bubble and
    // the agent rows that belong only to it stay hidden.
    seedServerPayload(
      's-greet',
      [
        msg('snapshot:agent:2', 'agent', 'Hello! How can I help you today?', 2),
        msg('user:seq-5', 'user', '', 5),
        msg('snapshot:agent:6', 'agent', 'It looks like your message came through empty.', 6),
        msg('turn:t1', 'user', 'PINEAPPLE', 10),
        msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11)
      ],
      11
    )
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-greet')
    const messages = useAcpStore.getState().messages['s-greet']
    expect(messages.map((m) => m.id)).toEqual(['snapshot:agent:2', 'turn:t1', 'snapshot:agent:11'])
    expect(messages.every((m) => !m.streaming)).toBe(true)
    expect(useAcpStore.getState().sessions['s-greet'].status).toBe('active')
  })

  it('normalizes a framed user_prompt record to chip tokens on reopen (resume chip parity)', async () => {
    // The durable user_prompt stores the WIRE text (path-framed skills); the
    // installed transcript must render chips like the live chat did.
    const wire = `# Agent Skills\n\nbmad-build: E:\\skills\\bmad-build\\SKILL.md\n\n---\n\n(bmad-build)`
    seedServerPayload(
      's-wire',
      [msg('turn:t1', 'user', wire, 10), msg('snapshot:agent:11', 'agent', 'ran it', 11)],
      11
    )
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-wire')
    const messages = useAcpStore.getState().messages['s-wire']
    expect(messages[0].blocks[0]).toEqual({ type: 'text', text: skillToken('bmad-build') })
    // Agent prose is untouched even when it echoes the framing.
    expect(messages[1].blocks[0]).toEqual({ type: 'text', text: 'ran it' })
  })

  it('normalizes command-prefixed wire text to a command token + skill token', async () => {
    const wire = `/compact # Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n(git-worktree) and then`
    seedServerPayload('s-cmd', [msg('turn:t1', 'user', wire, 10)], 10)
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-cmd')
    const messages = useAcpStore.getState().messages['s-cmd']
    expect(messages[0].blocks[0]).toEqual({
      type: 'text',
      text: `${commandToken('compact')} ${skillToken('git-worktree')} and then`
    })
  })

  it('passes plain persisted user text through verbatim (no framing)', async () => {
    seedServerPayload(
      's-plain',
      [
        msg('turn:t1', 'user', 'hello (not a chip)', 10),
        msg('snapshot:agent:11', 'agent', 'hi', 11)
      ],
      11
    )
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-plain')
    const messages = useAcpStore.getState().messages['s-plain']
    expect(messages[0].blocks[0]).toEqual({ type: 'text', text: 'hello (not a chip)' })
  })

  it('normalizes the user_prompt echo appended live when no optimistic message dedups it', async () => {
    // The WS `user_prompt` echo carries wire blocks; when the turn id does
    // not match an optimistic message (e.g. a second client sent it), the
    // appended bubble must still render chips.
    seedSession('s-echo', 'agent-1', false)
    const wire = `# Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n(git-worktree) hi`
    useAcpStore.getState()._onUserPrompt(
      {
        agentId: 'agent-1',
        sessionId: 's-echo',
        turnId: 't-echo-2',
        content: [{ type: 'text', text: wire }]
      } as never,
      undefined
    )
    const messages = useAcpStore.getState().messages['s-echo']
    const appended = messages.find((m) => m.id === 'turn:t-echo-2')
    expect(appended?.blocks).toEqual([{ type: 'text', text: `${skillToken('git-worktree')} hi` }])
  })

  it('normalizes a replayed user-role chunk run at stream end (split across chunks)', async () => {
    // Desktop session/load: the agent re-streams the accepted prompt as
    // UserMessageChunk events carrying the wire text, split across chunks.
    // While streaming, the bubble keeps the RAW wire text (a partial framing
    // must not be parsed); finalizeStreaming normalizes the completed run.
    seedSession('s-chunk', 'agent-1', false)
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, 's-chunk': { ...s.sessions['s-chunk'], replaying: 'streaming' } }
    }))
    useAcpStore.getState()._onMessageChunk(
      {
        agentId: 'agent-1',
        sessionId: 's-chunk',
        role: 'user',
        content: {
          type: 'text',
          text: `# Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n`
        }
      } as never,
      undefined
    )
    // Mid-stream: raw wire form (no partial-parse rewrite).
    let messages = useAcpStore.getState().messages['s-chunk']
    expect(messages[0].blocks[0]).toEqual({
      type: 'text',
      text: `# Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n`
    })
    useAcpStore.getState()._onMessageChunk(
      {
        agentId: 'agent-1',
        sessionId: 's-chunk',
        role: 'user',
        content: { type: 'text', text: '(git-worktree) hi' }
      } as never,
      undefined
    )
    _flushCoalescedForTesting()
    // Stream end: drive the same reducer the store uses when a stream closes
    // (agent crash path runs flushCoalescedSync + finalizeStreaming).
    useAcpStore.getState()._onAgentCrashed({
      agentId: 'agent-1',
      sessionId: 's-chunk',
      message: 'boom'
    } as never)
    messages = useAcpStore.getState().messages['s-chunk']
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks[0]).toEqual({
      type: 'text',
      text: `${skillToken('git-worktree')} hi`
    })
  })

  it('normalizes backfilled older user messages loaded by scroll-up', async () => {
    // Live window holds the tail; scroll-up pulls the persisted head whose
    // user bubbles carry wire text.
    const wire = `# Agent Skills\n\nbmad-build: E:\\skills\\bmad-build\\SKILL.md\n\n---\n\n(bmad-build)`
    seedServerPayload(
      's-old',
      [
        msg('turn:old-1', 'user', wire, 1),
        msg('snapshot:agent:2', 'agent', 'ok', 2),
        msg('turn:old-2', 'user', 'later', 3)
      ],
      3
    )
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-old')
    // Install a trimmed live window that drops the head turn.
    useAcpStore.setState((s) => ({
      messages: { ...s.messages, 's-old': s.messages['s-old'].slice(1) }
    }))
    await useAcpStore.getState().loadOlderMessages('s-old', 5)
    const messages = useAcpStore.getState().messages['s-old']
    const old = messages.find((m) => m.id === 'turn:old-1')
    expect(old?.blocks[0]).toEqual({ type: 'text', text: skillToken('bmad-build') })
  })

  it('renders a greeting-only session', async () => {
    // A session that starts with agent text has no user bubble yet. Those
    // rows stay visible.
    seedServerPayload(
      's-greet-only',
      [
        msg('snapshot:agent:2', 'agent', 'Hello!', 2),
        msg('snapshot:agent:3', 'agent', 'It looks like your message came through empty.', 3)
      ],
      3
    )
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-greet-only')
    expect(useAcpStore.getState().messages['s-greet-only'].map((m) => m.id)).toEqual([
      'snapshot:agent:2',
      'snapshot:agent:3'
    ])
  })

  it('drops subscribe-replayed events the payload already covers (duplicate blocks)', async () => {
    seedServerPayload(
      's-dup',
      [
        msg('user:seq-5', 'user', 'first question', 5),
        msg('snapshot:agent:6', 'agent', 'first answer', 6),
        msg('turn:t2', 'user', 'PINEAPPLE', 10),
        msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11)
      ],
      13
    )
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-dup')
    const before = useAcpStore.getState().messages['s-dup']

    // The subscribe replay redelivers the persisted log (seqs <= lastSeq=13).
    // An EARLIER user turn is not caught by the trailing-user content dedup —
    // only the watermark seq-dedupe drops it.
    useAcpStore.getState()._onUserPrompt(
      {
        agentId: 'agent-1',
        sessionId: 's-dup',
        content: [{ type: 'text', text: 'first question' }]
      },
      5
    )
    // A replayed chunk of the first answer must not splice into the trailing
    // visible reply (the QA "PINEAPPLEIt looks like…" splice).
    useAcpStore.getState()._onMessageChunk(
      {
        agentId: 'agent-1',
        sessionId: 's-dup',
        role: 'agent',
        content: { type: 'text', text: 'first answer' }
      },
      6
    )
    // A replayed turn-end must not re-stamp a stop-reason note as lastError.
    useAcpStore
      .getState()
      ._onPromptComplete({ agentId: 'agent-1', sessionId: 's-dup', stopReason: 'max_tokens' }, 13)
    _flushCoalescedForTesting()
    expect(useAcpStore.getState().messages['s-dup']).toEqual(before)
    expect(useAcpStore.getState().sessions['s-dup'].lastError).toBeNull()
  })

  it('keeps restored tool cards authoritative against replayed card state', async () => {
    setCachedSessionPayload('s-cards', {
      metadata: {
        id: 's-cards',
        agentId: 'agent-1',
        title: 'Chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        lastSeq: 12,
        status: 'closed'
      },
      messages: [
        msg('turn:t1', 'user', 'run it', 5) as never,
        msg('snapshot:agent:11', 'agent', 'done', 11) as never
      ],
      toolCalls: [
        {
          toolCallId: 'tc-1',
          title: 'Run',
          kind: 'execute',
          status: 'completed',
          timestamp: 8,
          seq: 8
        }
      ] as never
    })
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-cards')
    expect(useAcpStore.getState().toolCalls['s-cards']).toHaveLength(1)
    // Replayed tool_call carries the stale in-flight state; without the
    // watermark drop the upsert would regress the card to in_progress.
    useAcpStore.getState()._onToolCall(
      {
        agentId: 'agent-1',
        sessionId: 's-cards',
        toolCall: {
          toolCallId: 'tc-1',
          title: 'Run',
          kind: 'execute',
          status: 'in_progress'
        }
      },
      7
    )
    useAcpStore.getState()._onToolCallUpdate(
      {
        agentId: 'agent-1',
        sessionId: 's-cards',
        update: { toolCallId: 'tc-1', status: 'in_progress' }
      },
      9
    )
    _flushCoalescedForTesting()
    expect(useAcpStore.getState().toolCalls['s-cards']).toHaveLength(1)
    expect(useAcpStore.getState().toolCalls['s-cards'][0].status).toBe('completed')
  })

  it('never splices a replay-window chunk into a restored bubble (chunk splice)', async () => {
    seedServerPayload(
      's-splice',
      [
        msg('turn:t1', 'user', 'PINEAPPLE', 10),
        msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11)
      ],
      11
    )
    // A genuinely new chunk (seq > watermark) lands while the load IPC is in
    // flight (replay window open): it must open its own bubble, never merge
    // into the restored reply.
    seedServerTransport(() => {
      useAcpStore.getState()._onMessageChunk(
        {
          agentId: 'agent-1',
          sessionId: 's-splice',
          role: 'agent',
          content: { type: 'text', text: 'late addition' }
        },
        12
      )
    })
    await useAcpStore.getState().openHistorySession('s-splice')
    const messages = useAcpStore.getState().messages['s-splice']
    expect(messages).toHaveLength(3)
    expect(messages[1].blocks).toEqual([{ type: 'text', text: 'Got it: PINEAPPLE' }])
    expect(messages[2].blocks).toEqual([{ type: 'text', text: 'late addition' }])
    expect(messages[2].role).toBe('agent')
  })

  it('leaves no streaming cursor stuck after the replay window closes (stuck cursor)', async () => {
    seedServerPayload(
      's-cursor',
      [
        msg('turn:t1', 'user', 'PINEAPPLE', 10),
        msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11)
      ],
      11
    )
    seedServerTransport(() => {
      useAcpStore.getState()._onMessageChunk(
        {
          agentId: 'agent-1',
          sessionId: 's-cursor',
          role: 'agent',
          content: { type: 'text', text: 'late addition' }
        },
        12
      )
    })
    await useAcpStore.getState().openHistorySession('s-cursor')
    await flushTurnEnd()
    const state = useAcpStore.getState()
    expect(state.sessions['s-cursor'].replaying).toBeNull()
    expect(state.messages['s-cursor'].every((m) => !m.streaming)).toBe(true)
  })

  it('renders genuinely new live events after reconnect (seq > watermark)', async () => {
    seedServerPayload(
      's-live',
      [
        msg('turn:t1', 'user', 'PINEAPPLE', 10),
        msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11)
      ],
      11
    )
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-live')
    useAcpStore.getState()._onUserPrompt(
      {
        agentId: 'agent-1',
        sessionId: 's-live',
        content: [{ type: 'text', text: 'again' }],
        turnId: 't2'
      },
      12
    )
    useAcpStore.getState()._onMessageChunk(
      {
        agentId: 'agent-1',
        sessionId: 's-live',
        role: 'agent',
        content: { type: 'text', text: 'new answer' }
      },
      13
    )
    _flushCoalescedForTesting()
    const messages = useAcpStore.getState().messages['s-live']
    expect(messages).toHaveLength(4)
    expect(messages.slice(0, 3).map((m) => m.id)).toEqual([
      'turn:t1',
      'snapshot:agent:11',
      'turn:t2'
    ])
    expect(messages[3].role).toBe('agent')
    expect(messages[3].blocks).toEqual([{ type: 'text', text: 'new answer' }])
  })

  it('folds a recovery snapshot into bubbles and keeps the leading agent row (recovery)', async () => {
    seedSession('s-rec', 'agent-1', false)
    await _installTransportRecoveryForTesting({
      sessionId: 's-rec',
      watermark: 20,
      events: [
        // Leading agent text stays. The empty synthetic prompt and its reply
        // stay hidden.
        {
          sid: 's-rec',
          seq: 2,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'Hello! ' } }
        },
        {
          sid: 's-rec',
          seq: 3,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'How can I help?' } }
        },
        { sid: 's-rec', seq: 5, type: 'user_prompt', payload: { turnId: 'g', content: [] } },
        {
          sid: 's-rec',
          seq: 6,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'It looks empty' } }
        },
        // Visible turn: two chunks of one run fold into a single bubble.
        {
          sid: 's-rec',
          seq: 10,
          type: 'user_prompt',
          payload: { turnId: 't1', content: [{ type: 'text', text: 'PINEAPPLE' }] }
        },
        {
          sid: 's-rec',
          seq: 11,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'Got' } }
        },
        {
          sid: 's-rec',
          seq: 12,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: ' it' } }
        },
        // prompt_complete splits the run: the next chunk opens a fresh bubble.
        { sid: 's-rec', seq: 13, type: 'prompt_complete', payload: { stopReason: 'end_turn' } },
        {
          sid: 's-rec',
          seq: 14,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'Next run' } }
        }
      ]
    })
    const messages = useAcpStore.getState().messages['s-rec']
    expect(messages.map((m) => m.id)).toEqual([
      'snapshot:agent:2',
      'turn:t1',
      'snapshot:agent:11',
      'snapshot:agent:14'
    ])
    expect(messages[2].blocks).toEqual([{ type: 'text', text: 'Got it' }])
    expect(messages.every((m) => !m.streaming)).toBe(true)
    // The snapshot watermark seq-dedupes the live stream that follows.
    useAcpStore.getState()._onMessageChunk(
      {
        agentId: 'agent-1',
        sessionId: 's-rec',
        role: 'agent',
        content: { type: 'text', text: 'stale replay' }
      },
      15
    )
    _flushCoalescedForTesting()
    expect(useAcpStore.getState().messages['s-rec']).toEqual(messages)
  })

  it('normalizes wire user_prompt + user-role chunks in the recovery fold (chip parity)', async () => {
    seedSession('s-rec-wire', 'agent-1', false)
    const wire = `# Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n(git-worktree) hi`
    await _installTransportRecoveryForTesting({
      sessionId: 's-rec-wire',
      watermark: 20,
      events: [
        {
          sid: 's-rec-wire',
          seq: 10,
          type: 'user_prompt',
          payload: { turnId: 't1', content: [{ type: 'text', text: wire }] }
        },
        // The agent re-streamed the SAME prompt as split user-role chunks
        // (header half + marker half) — coalesce-then-normalize must rebuild
        // the token string, and neither half may be dropped.
        {
          sid: 's-rec-wire',
          seq: 11,
          type: 'message_chunk',
          payload: {
            role: 'user',
            content: {
              type: 'text',
              text: `# Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n`
            }
          }
        },
        {
          sid: 's-rec-wire',
          seq: 12,
          type: 'message_chunk',
          payload: { role: 'user', content: { type: 'text', text: '(git-worktree) hi' } }
        },
        {
          sid: 's-rec-wire',
          seq: 13,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'done' } }
        }
      ]
    })
    const messages = useAcpStore.getState().messages['s-rec-wire']
    expect(messages.map((m) => m.id)).toEqual(['turn:t1', 'snapshot:user:11', 'snapshot:agent:13'])
    expect(messages[0].blocks).toEqual([{ type: 'text', text: `${skillToken('git-worktree')} hi` }])
    expect(messages[1].blocks).toEqual([{ type: 'text', text: `${skillToken('git-worktree')} hi` }])
  })

  it('strips the handoff preamble from framed user_prompt records in the recovery fold', async () => {
    // spec-agent-switch-separator-redesign: pre-fix switch turns persisted
    // `summary + --- + draft` as the user bubble; replay must show the draft.
    seedSession('s-rec-ho', 'agent-1', false)
    const framed =
      '# Conversation handoff\n\nYou are taking over a conversation previously handled by OMP.\n\nUser: hi\n\n---\n\ncontinue the work'
    await _installTransportRecoveryForTesting({
      sessionId: 's-rec-ho',
      watermark: 20,
      events: [
        {
          sid: 's-rec-ho',
          seq: 10,
          type: 'user_prompt',
          payload: { turnId: 't1', content: [{ type: 'text', text: framed }] }
        },
        {
          sid: 's-rec-ho',
          seq: 11,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'on it' } }
        }
      ]
    })
    const messages = useAcpStore.getState().messages['s-rec-ho']
    expect(messages.map((m) => m.id)).toEqual(['turn:t1', 'snapshot:agent:11'])
    expect(messages[0].blocks).toEqual([{ type: 'text', text: 'continue the work' }])
  })

  it('drops a summary-only framed user_prompt row entirely in the recovery fold', async () => {
    // Summary-only switch: the record IS the preamble — no user bubble, and
    // the handoff turn's reply still folds (the row was visible, not hidden).
    seedSession('s-rec-hosum', 'agent-1', false)
    await _installTransportRecoveryForTesting({
      sessionId: 's-rec-hosum',
      watermark: 20,
      events: [
        {
          sid: 's-rec-hosum',
          seq: 10,
          type: 'user_prompt',
          payload: {
            turnId: 'h1',
            content: [
              {
                type: 'text',
                text: '# Conversation handoff\n\nYou are taking over a conversation previously handled by OMP.'
              }
            ]
          }
        },
        {
          sid: 's-rec-hosum',
          seq: 11,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'summary ack' } }
        }
      ]
    })
    const messages = useAcpStore.getState().messages['s-rec-hosum']
    expect(messages.map((m) => m.role)).toEqual(['agent'])
    expect(messages[0].blocks).toEqual([{ type: 'text', text: 'summary ack' }])
  })

  it('strips the handoff preamble from user-role message_chunks in the recovery fold', async () => {
    // The agent re-streaming the accepted prompt produces user-role chunks
    // carrying the SAME wire framing; the post-fold normalize pass strips it.
    seedSession('s-rec-hochunk', 'agent-1', false)
    await _installTransportRecoveryForTesting({
      sessionId: 's-rec-hochunk',
      watermark: 20,
      events: [
        {
          sid: 's-rec-hochunk',
          seq: 10,
          type: 'message_chunk',
          payload: {
            role: 'user',
            content: {
              type: 'text',
              text: '# Conversation handoff\n\nYou are taking over.\n\n---\n\npicked up the draft'
            }
          }
        },
        {
          sid: 's-rec-hochunk',
          seq: 11,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'ok' } }
        }
      ]
    })
    const messages = useAcpStore.getState().messages['s-rec-hochunk']
    expect(messages.map((m) => m.role)).toEqual(['user', 'agent'])
    expect(messages[0].blocks).toEqual([{ type: 'text', text: 'picked up the draft' }])
  })

  it('leaves user prompts that merely begin with the header text untouched', async () => {
    // Exact-prefix gate: `# Conversation handoff!` is user-authored text, not
    // the producer's framing — it must replay verbatim, never be dropped.
    seedSession('s-rec-hofp', 'agent-1', false)
    await _installTransportRecoveryForTesting({
      sessionId: 's-rec-hofp',
      watermark: 20,
      events: [
        {
          sid: 's-rec-hofp',
          seq: 10,
          type: 'user_prompt',
          payload: {
            turnId: 'fp1',
            content: [{ type: 'text', text: '# Conversation handoff! — my notes on the feature' }]
          }
        }
      ]
    })
    const messages = useAcpStore.getState().messages['s-rec-hofp']
    expect(messages.map((m) => m.id)).toEqual(['turn:fp1'])
    expect(messages[0].blocks).toEqual([
      { type: 'text', text: '# Conversation handoff! — my notes on the feature' }
    ])
  })

  it('survives a null-content message_chunk record in the recovery fold', async () => {
    // The host persists null-content chunks as a documented transparent
    // shape; the fold must skip them, never dereference and crash.
    seedSession('s-rec-null', 'agent-1', false)
    await _installTransportRecoveryForTesting({
      sessionId: 's-rec-null',
      watermark: 20,
      events: [
        {
          sid: 's-rec-null',
          seq: 10,
          type: 'user_prompt',
          payload: { turnId: 't1', content: [{ type: 'text', text: 'hello' }] }
        },
        {
          sid: 's-rec-null',
          seq: 11,
          type: 'message_chunk',
          payload: { role: 'agent', content: null }
        },
        {
          sid: 's-rec-null',
          seq: 12,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'recovered' } }
        }
      ]
    })
    const messages = useAcpStore.getState().messages['s-rec-null']
    expect(messages.map((m) => m.id)).toEqual(['turn:t1', 'snapshot:agent:12'])
    expect(messages[1].blocks).toEqual([{ type: 'text', text: 'recovered' }])
  })

  it('dedups a no-turnId user_prompt echo against a normalized trailing user message', async () => {
    // The echo carries WIRE blocks; the trailing optimistic message carries
    // display (token) blocks. The dedup must compare display-to-display or a
    // re-delivered echo appends a duplicate bubble.
    seedSession('s-echo-dedup', 'agent-1', false)
    const wire = `# Agent Skills\n\ngit-worktree: /home/u/.agents/skills/git-worktree/SKILL.md\n\n---\n\n(git-worktree) hi`
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        's-echo-dedup': [
          {
            id: 'msg-1',
            role: 'user',
            blocks: [{ type: 'text', text: `${skillToken('git-worktree')} hi` }],
            streaming: false,
            timestamp: 1,
            seq: 1
          }
        ]
      }
    }))
    useAcpStore.getState()._onUserPrompt(
      {
        agentId: 'agent-1',
        sessionId: 's-echo-dedup',
        turnId: null,
        content: [{ type: 'text', text: wire }]
      } as never,
      undefined
    )
    const messages = useAcpStore.getState().messages['s-echo-dedup']
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([{ type: 'text', text: `${skillToken('git-worktree')} hi` }])
  })

  it('recovers tool cards from snapshot tool_call/tool_call_update events (recovery)', async () => {
    seedSession('s-rec-tc', 'agent-1', false)
    await _installTransportRecoveryForTesting({
      sessionId: 's-rec-tc',
      watermark: 20,
      events: [
        // Leading agent text and its tool card stay visible.
        {
          sid: 's-rec-tc',
          seq: 2,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'Hello!' } }
        },
        {
          sid: 's-rec-tc',
          seq: 3,
          type: 'tool_call',
          payload: {
            toolCall: {
              toolCallId: 'tc-hidden',
              title: 'Greeting tool',
              kind: 'read',
              status: 'completed'
            }
          }
        },
        {
          sid: 's-rec-tc',
          seq: 10,
          type: 'user_prompt',
          payload: { turnId: 't1', content: [{ type: 'text', text: 'PINEAPPLE' }] }
        },
        // Visible turn: a tool card recovered in-flight, then its update.
        {
          sid: 's-rec-tc',
          seq: 11,
          type: 'tool_call',
          payload: {
            toolCall: {
              toolCallId: 'tc-1',
              title: 'Run',
              kind: 'execute',
              status: 'in_progress'
            }
          }
        },
        {
          sid: 's-rec-tc',
          seq: 12,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'working' } }
        },
        {
          sid: 's-rec-tc',
          seq: 13,
          type: 'tool_call_update',
          payload: { update: { toolCallId: 'tc-1', status: 'completed' } }
        }
      ]
    })
    const cards = useAcpStore.getState().toolCalls['s-rec-tc']
    expect(cards.map((c) => c.toolCallId)).toEqual(['tc-hidden', 'tc-1'])
    expect(cards[1].status).toBe('completed')
    // Envelope seq stamps the card so it interleaves with the bubbles.
    expect(cards[1].seq).toBe(11)
  })

  it('keeps a greeting-era tool card now that the leading agent row is visible', async () => {
    setCachedSessionPayload('s-gc', {
      metadata: {
        id: 's-gc',
        agentId: 'agent-1',
        title: 'Chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        lastSeq: 11,
        status: 'closed'
      },
      messages: [
        msg('snapshot:agent:2', 'agent', 'Hello!', 2) as never,
        msg('turn:t1', 'user', 'PINEAPPLE', 10) as never,
        msg('snapshot:agent:11', 'agent', 'Got it', 11) as never
      ],
      toolCalls: [
        {
          toolCallId: 'tc-greet',
          title: 'Greeting tool',
          kind: 'read',
          status: 'completed',
          timestamp: 3,
          seq: 3
        },
        {
          toolCallId: 'tc-real',
          title: 'Real tool',
          kind: 'read',
          status: 'completed',
          timestamp: 10,
          seq: 10
        }
      ] as never
    })
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-gc')
    const cards = useAcpStore.getState().toolCalls['s-gc']
    expect(cards.map((c) => c.toolCallId)).toEqual(['tc-greet', 'tc-real'])
  })

  it('drops tool cards of a mid-conversation hidden turn, keeps visible-turn cards', async () => {
    // dropHiddenToolCalls: hidden turns are seq intervals — a synthetic empty
    // prompt turn mid-transcript hides its cards too, not only the prefix.
    setCachedSessionPayload('s-mid', {
      metadata: {
        id: 's-mid',
        agentId: 'agent-1',
        title: 'Chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 6,
        lastSeq: 21,
        status: 'closed'
      },
      messages: [
        msg('turn:t1', 'user', 'first', 5) as never,
        msg('snapshot:agent:6', 'agent', 'one', 6) as never,
        msg('user:seq-10', 'user', '', 10) as never,
        msg('snapshot:agent:11', 'agent', 'empty reply', 11) as never,
        msg('turn:t2', 'user', 'second', 20) as never,
        msg('snapshot:agent:21', 'agent', 'two', 21) as never
      ],
      toolCalls: [
        {
          toolCallId: 'tc-visible-1',
          title: 'A',
          kind: 'read',
          status: 'completed',
          timestamp: 7,
          seq: 7
        },
        {
          toolCallId: 'tc-hidden',
          title: 'B',
          kind: 'read',
          status: 'completed',
          timestamp: 12,
          seq: 12
        },
        {
          toolCallId: 'tc-visible-2',
          title: 'C',
          kind: 'read',
          status: 'completed',
          timestamp: 21,
          seq: 21
        }
      ] as never
    })
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-mid')
    const cards = useAcpStore.getState().toolCalls['s-mid']
    expect(cards.map((c) => c.toolCallId)).toEqual(['tc-visible-1', 'tc-visible-2'])
  })

  it('keeps the leading agent row on the tail-fetch path when the window holds the whole conversation', async () => {
    const { loadSessionPayloadTail } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayloadTail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-tail',
        agentId: 'agent-1',
        title: 'Chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 3,
        lastSeq: 11,
        status: 'closed'
      },
      messages: [
        msg('snapshot:agent:2', 'agent', 'Hello!', 2) as never,
        msg('turn:t1', 'user', 'PINEAPPLE', 10) as never,
        msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11) as never
      ]
    })
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-tail')
    expect(useAcpStore.getState().messages['s-tail'].map((m) => m.id)).toEqual([
      'snapshot:agent:2',
      'turn:t1',
      'snapshot:agent:11'
    ])
  })

  it('never truncates a windowed tail that opens mid-turn', async () => {
    // A tail window at the limit is an arbitrary, turn-unaware cut: when it
    // opens on an agent bubble (its user prompt lies outside the window), the
    // hidden-turn filter must NOT classify it as the greeting prefix.
    const { HISTORY_TAIL_MESSAGE_LIMIT } = await import('@/lib/acp-history-persistence')
    const tailMessages: TestMessage[] = [msg('snapshot:agent:200', 'agent', 'reply tail', 200)]
    for (let i = 1; i < HISTORY_TAIL_MESSAGE_LIMIT; i += 2) {
      const seq = 200 + i
      tailMessages.push(msg(`turn:t${i}`, 'user', `question ${i}`, seq))
      if (i + 1 < HISTORY_TAIL_MESSAGE_LIMIT) {
        tailMessages.push(msg(`snapshot:agent:${seq + 1}`, 'agent', `answer ${i}`, seq + 1))
      }
    }
    expect(tailMessages).toHaveLength(HISTORY_TAIL_MESSAGE_LIMIT)
    const { loadSessionPayloadTail } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayloadTail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-window',
        agentId: 'agent-1',
        title: 'Chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: tailMessages.length,
        lastSeq: 200 + HISTORY_TAIL_MESSAGE_LIMIT,
        status: 'closed'
      },
      messages: tailMessages as never
    })
    seedServerTransport()
    await useAcpStore.getState().openHistorySession('s-window')
    const installed = useAcpStore.getState().messages['s-window']
    expect(installed).toHaveLength(HISTORY_TAIL_MESSAGE_LIMIT)
    expect(installed[0].id).toBe('snapshot:agent:200')
  })

  it('restores the hidden-filtered transcript when session/load fails', async () => {
    seedServerPayload(
      's-load-fails',
      [
        msg('snapshot:agent:2', 'agent', 'Hello!', 2),
        msg('turn:t1', 'user', 'PINEAPPLE', 10),
        msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11)
      ],
      11
    )
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession: vi.fn(async () => {
        throw new AcpTransportError('closed', 'boom')
      }),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    await expect(useAcpStore.getState().openHistorySession('s-load-fails')).rejects.toThrow()
    const messages = useAcpStore.getState().messages['s-load-fails']
    expect(messages.map((m) => m.id)).toEqual(['snapshot:agent:2', 'turn:t1', 'snapshot:agent:11'])
    expect(useAcpStore.getState().sessions['s-load-fails'].lastError).toContain('Resume failed')
  })

  it('resumeLiveSession filters hidden turns and finalizes the resume window', async () => {
    seedServerPayload(
      's-resume',
      [
        msg('snapshot:agent:2', 'agent', 'Hello!', 2),
        msg('turn:t1', 'user', 'PINEAPPLE', 10),
        msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11)
      ],
      11
    )
    _setAcpTransportForTests({
      historyMode: () => 'server',
      resumeSession: vi.fn(async () => {
        // A genuinely new chunk (seq > watermark) lands mid-resume: it must
        // open its own bubble (never splice into the restored reply) and its
        // streaming marker must clear when the window closes.
        useAcpStore.getState()._onMessageChunk(
          {
            agentId: 'agent-1',
            sessionId: 's-resume',
            role: 'agent',
            content: { type: 'text', text: 'post-reload note' }
          },
          12
        )
        return {}
      }),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    await useAcpStore.getState().resumeLiveSession('s-resume', 'agent-1', '/w')
    const state = useAcpStore.getState()
    const messages = state.messages['s-resume']
    expect(messages.map((m) => m.id)).toEqual([
      'snapshot:agent:2',
      'turn:t1',
      'snapshot:agent:11',
      messages[3].id
    ])
    expect(messages[2].blocks).toEqual([{ type: 'text', text: 'Got it: PINEAPPLE' }])
    expect(messages[3].blocks).toEqual([{ type: 'text', text: 'post-reload note' }])
    expect(state.sessions['s-resume'].replaying).toBeNull()
    expect(state.sessions['s-resume'].status).toBe('active')
    expect(messages.every((m) => !m.streaming)).toBe(true)
  })

  it('loadOlderMessages restores the leading agent greeting', async () => {
    const hidden = msg('snapshot:agent:2', 'agent', 'Hello!', 2)
    const user = msg('turn:t1', 'user', 'PINEAPPLE', 10)
    const reply = msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11)
    setCachedSessionPayload('s-backfill', {
      metadata: {
        id: 's-backfill',
        agentId: 'agent-1',
        title: 'Chat',
        cwd: '/w',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 3,
        lastSeq: 11,
        status: 'closed'
      },
      messages: [hidden, user, reply] as never
    })
    seedSession('s-backfill', 'agent-1', false)
    useAcpStore.setState((s) => ({
      messages: { ...s.messages, 's-backfill': [user, reply] as never }
    }))
    await useAcpStore.getState().loadOlderMessages('s-backfill', 10)
    expect(useAcpStore.getState().messages['s-backfill'].map((m) => m.id)).toEqual([
      'snapshot:agent:2',
      'turn:t1',
      'snapshot:agent:11'
    ])
  })

  it('delivers envelope seqs through the wired listeners into the store', async () => {
    // Covers the wiring seam: reverting the initAcpEventListeners lambdas to
    // drop `eventSeq` must fail this test even when every handler-level test
    // passes seqs explicitly.
    const listeners = new Map<string, (payload: unknown, eventSeq?: number) => void>()
    _setAcpTransportForTests({
      historyMode: () => 'server',
      loadSession: vi.fn(async () => ({})),
      onEvent: vi.fn((name: string, cb: (payload: unknown, eventSeq?: number) => void) => {
        listeners.set(name, cb)
        return () => {}
      }),
      setReconnectListener: vi.fn(),
      setRecoveryHandler: vi.fn(),
      setReconnectPriorityProvider: vi.fn(),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    seedServerPayload(
      's-wired',
      [
        msg('turn:t1', 'user', 'PINEAPPLE', 10),
        msg('snapshot:agent:11', 'agent', 'Got it: PINEAPPLE', 11)
      ],
      11
    )
    const teardown = initAcpEventListeners()
    try {
      await useAcpStore.getState().openHistorySession('s-wired')
      const before = useAcpStore.getState().messages['s-wired']
      const onChunk = listeners.get('acp:message_chunk')
      expect(onChunk).toBeDefined()
      onChunk!(
        {
          agentId: 'agent-1',
          sessionId: 's-wired',
          role: 'agent',
          content: { type: 'text', text: 'stale replay' }
        },
        6
      )
      _flushCoalescedForTesting()
      expect(useAcpStore.getState().messages['s-wired']).toEqual(before)
      onChunk!(
        {
          agentId: 'agent-1',
          sessionId: 's-wired',
          role: 'agent',
          content: { type: 'text', text: 'fresh' }
        },
        12
      )
      _flushCoalescedForTesting()
      const after = useAcpStore.getState().messages['s-wired']
      expect(JSON.stringify(after[after.length - 1].blocks)).toContain('fresh')
    } finally {
      teardown()
    }
  })
  it('rejects a late recovery snapshot for a session closed mid-recovery (reopen generation)', async () => {
    // Round-2 race: the transport captured generation 0 (session never
    // reopened) before the snapshot round-trip; the close invalidates it
    // while the snapshot is in flight.
    seedSession('s-gone', 'agent-1', false)
    await useAcpStore.getState().closeSession('s-gone')
    await _installTransportRecoveryForTesting(
      {
        sessionId: 's-gone',
        watermark: 20,
        events: [
          {
            sid: 's-gone',
            seq: 10,
            type: 'user_prompt',
            payload: { turnId: 't1', content: [{ type: 'text', text: 'PINEAPPLE' }] }
          },
          {
            sid: 's-gone',
            seq: 11,
            type: 'message_chunk',
            payload: { role: 'agent', content: { type: 'text', text: 'Got it' } }
          },
          {
            sid: 's-gone',
            seq: 12,
            type: 'tool_call',
            payload: {
              toolCall: {
                toolCallId: 'tc-1',
                title: 'Run',
                kind: 'execute',
                status: 'completed'
              }
            }
          }
        ]
      },
      0
    )
    const state = useAcpStore.getState()
    // No resurrection: transcript maps stay empty, the closed session keeps
    // its status and never gets its error state touched by the stale install.
    expect(state.messages['s-gone']).toBeUndefined()
    expect(state.toolCalls['s-gone']).toBeUndefined()
    expect(state.sessions['s-gone'].status).toBe('closed')
    expect(state.sessions['s-gone'].lastError).toBeNull()
  })

  it('rejects a stale recovery snapshot after the session was replaced by a reopen', async () => {
    seedServerPayload(
      's-replaced',
      [msg('turn:t1', 'user', 'PINEAPPLE', 10), msg('snapshot:agent:11', 'agent', 'Got it', 11)],
      11
    )
    seedServerTransport()
    // The reopen bumps the session's generation to 1 and installs watermark 11.
    await useAcpStore.getState().openHistorySession('s-replaced')
    const before = useAcpStore.getState().messages['s-replaced']
    // A recovery captured BEFORE the reopen (generation 0) lands late.
    await _installTransportRecoveryForTesting(
      {
        sessionId: 's-replaced',
        watermark: 20,
        events: [
          {
            sid: 's-replaced',
            seq: 10,
            type: 'user_prompt',
            payload: { turnId: 't9', content: [{ type: 'text', text: 'STALE' }] }
          },
          {
            sid: 's-replaced',
            seq: 11,
            type: 'message_chunk',
            payload: { role: 'agent', content: { type: 'text', text: 'stale answer' } }
          }
        ]
      },
      0
    )
    expect(useAcpStore.getState().messages['s-replaced']).toEqual(before)
    // The stale watermark (20) must NOT be installed: a live event at seq 15
    // (above the real watermark 11, below the stale 20) still renders.
    useAcpStore.getState()._onMessageChunk(
      {
        agentId: 'agent-1',
        sessionId: 's-replaced',
        role: 'agent',
        content: { type: 'text', text: 'live answer' }
      },
      15
    )
    _flushCoalescedForTesting()
    const after = useAcpStore.getState().messages['s-replaced']
    // Same-role trailing chunks merge into the trailing bubble; the point
    // is the event RENDERED — a stale watermark 20 would have dropped it.
    expect(after).toHaveLength(before.length)
    expect(JSON.stringify(after[after.length - 1].blocks)).toContain('live answer')
  })

  it('installs a recovery snapshot when the captured generation still matches', async () => {
    // Positive control: generation 0 with no reopen/close since the capture.
    seedSession('s-current', 'agent-1', false)
    await _installTransportRecoveryForTesting(
      {
        sessionId: 's-current',
        watermark: 20,
        events: [
          {
            sid: 's-current',
            seq: 10,
            type: 'user_prompt',
            payload: { turnId: 't1', content: [{ type: 'text', text: 'PINEAPPLE' }] }
          },
          {
            sid: 's-current',
            seq: 11,
            type: 'message_chunk',
            payload: { role: 'agent', content: { type: 'text', text: 'Got it' } }
          }
        ]
      },
      0
    )
    const messages = useAcpStore.getState().messages['s-current']
    expect(messages.map((m) => m.id)).toEqual(['turn:t1', 'snapshot:agent:11'])
    // The watermark installed: covered live events (seq <= 20) still drop.
    useAcpStore.getState()._onMessageChunk(
      {
        agentId: 'agent-1',
        sessionId: 's-current',
        role: 'agent',
        content: { type: 'text', text: 'stale replay' }
      },
      15
    )
    _flushCoalescedForTesting()
    expect(useAcpStore.getState().messages['s-current']).toEqual(messages)
  })

  it('rejects a late degraded recovery for a session closed mid-recovery', async () => {
    seedSession('s-deg', 'agent-1', false)
    await useAcpStore.getState().closeSession('s-deg')
    await _installTransportRecoveryForTesting({ sessionId: 's-deg', degraded: true }, 0)
    const state = useAcpStore.getState()
    expect(state.degradedRecoverySessions['s-deg']).toBeUndefined()
    expect(state.sessions['s-deg'].lastError).toBeNull()
  })
})
