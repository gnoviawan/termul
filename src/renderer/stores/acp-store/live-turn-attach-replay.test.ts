/**
 * Reopening a chat whose turn is still running (web, subscribe/replay attach):
 * the host payload only summarizes the open turn's tool calls, so the attach
 * subscribes from just before that turn's prompt and lets the relay's full
 * replay restore the cards. Replayed prompts and chunks the payload already
 * shows stay deduped by the history watermark.
 *
 * Same harness as dead-turn-reopen.test.ts: `isTauriContext() → false` and a
 * fake web transport whose `subscribeSession` plays the relay replay into the
 * store handlers with real envelope seqs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => false),
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
    loadSessionPayload: actual.loadSessionPayload,
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
vi.mock('@/stores/workspace-store', () => ({
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  getAllLeafPanes: () => [],
  findPaneContainingTab: () => null,
  useWorkspaceStore: {
    getState: () => ({ addAgentChatTab: vi.fn(), root: null })
  }
}))
vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: {
      read: vi.fn(async () => ({ success: false })),
      write: vi.fn(),
      writeDebounced: vi.fn(async () => ({ success: true })),
      delete: vi.fn(async () => ({ success: true }))
    }
  }
})

import { buildTimeline } from '@/components/chat/chat-timeline'
import type { AcpTransport } from '@/lib/acp-transport'
import { _resetAcpTransportForTests, _setAcpTransportForTests } from '@/lib/acp-transport'
import { isTauriContext } from '@/lib/tauri-runtime'
import {
  _flushCoalescedForTesting,
  _resetAcpAuthForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, flushTurnEnd } from './testkit'

const CONFIG_ID = 'acp-registry:claude-acp'
const AGENT = 'agent-owner'

type FakeTransport = AcpTransport & {
  subscribeSession: ReturnType<typeof vi.fn>
  seedSessionCursor: ReturnType<typeof vi.fn>
}

function fakeWebTransport(sessionId: string, payload: Record<string, unknown>): FakeTransport {
  return {
    listAgentDetails: async () => [
      {
        id: AGENT,
        name: 'Claude',
        configId: CONFIG_ID,
        capabilities: { loadSession: true },
        ownsSession: [sessionId]
      }
    ],
    spawnAgent: vi.fn(async () => ({
      agentId: 'agent-fresh',
      capabilities: { loadSession: true }
    })),
    loadSession: vi.fn(async () => ({})),
    resumeSession: vi.fn(async () => ({})),
    sendPrompt: vi.fn(async () => 'end_turn'),
    sendPromptBlocks: vi.fn(async () => 'end_turn'),
    getSessionPayload: async (id: string) => (id === sessionId ? payload : null),
    getSessionPayloadTail: async () => null,
    subscribeSession: vi.fn(async () => {}),
    seedSessionCursor: vi.fn(),
    connect: async () => {},
    dispose: () => {},
    historyMode: () => 'server' as const
  } as unknown as FakeTransport
}

function msg(id: string, role: 'user' | 'agent', text: string, seq: number) {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    streaming: false,
    timestamp: seq,
    seq
  }
}

function livePayload(
  id: string,
  messages: Array<ReturnType<typeof msg>>,
  toolCalls: Array<Record<string, unknown>> = []
): Record<string, unknown> {
  return {
    metadata: {
      id,
      agentId: AGENT,
      agentConfigId: CONFIG_ID,
      title: 'Chat',
      cwd: '/w',
      projectId: 'p1',
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: messages.length,
      lastSeq: 12,
      status: 'active',
      turnActive: true
    },
    messages,
    toolCalls
  }
}

const EDIT_SUMMARY = {
  toolCallId: 'fake-edit-1',
  kind: 'edit',
  locations: [{ path: 'src/auth.ts' }],
  diffStat: { added: 10, removed: 0 },
  seq: 7,
  timestamp: 7,
  restoredSummary: true
}

/** The relay replay of the open turn (seqs 5..9), as the store handlers receive it. */
function replayOpenTurn(sessionId: string): void {
  const store = useAcpStore.getState()
  store._onUserPrompt(
    { agentId: AGENT, sessionId, turnId: 't1', content: [{ type: 'text', text: 'edit auth' }] },
    5
  )
  store._onToolCall(
    {
      agentId: AGENT,
      sessionId,
      toolCall: {
        toolCallId: 'read-1',
        title: 'Read src/auth.ts',
        kind: 'read',
        status: 'completed'
      }
    },
    6
  )
  store._onToolCall(
    {
      agentId: AGENT,
      sessionId,
      toolCall: {
        toolCallId: 'fake-edit-1',
        title: 'Edit src/auth.ts',
        kind: 'edit',
        status: 'in_progress',
        locations: [{ path: 'src/auth.ts' }],
        content: [{ type: 'diff', path: 'src/auth.ts', oldText: null, newText: 'auth1' }]
      }
    },
    7
  )
  store._onMessageChunk(
    { agentId: AGENT, sessionId, role: 'agent', content: { type: 'text', text: 'Working on it' } },
    8
  )
  store._onToolCallUpdate(
    { agentId: AGENT, sessionId, update: { toolCallId: 'fake-edit-1', status: 'completed' } },
    9
  )
}

function timelineKeys(sessionId: string): string[] {
  const state = useAcpStore.getState()
  return buildTimeline(state.messages[sessionId], state.toolCalls[sessionId]).map((item) =>
    item.kind === 'message' ? `${item.message.role}:${item.key}` : `${item.kind}:${item.key}`
  )
}

describe('acp-store: live-turn attach replays the open turn (reopen tool cards)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauriContext).mockReturnValue(false)
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetAcpAuthForTesting()
    _resetInFlightPreparedForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetLiveSwitchSourcesForTesting()
    useAcpStore.setState(FRESH)
    useAcpStore.setState({
      agentConfigs: [
        {
          id: CONFIG_ID,
          name: 'Claude',
          command: 'claude',
          args: [],
          env: {},
          templateId: 'claude-acp'
        }
      ]
    })
  })

  it('subscribes from before the open prompt and restores its tool cards at their seq positions', async () => {
    const id = 's-reopen-cards'
    const transport = fakeWebTransport(
      id,
      livePayload(
        id,
        [
          msg('turn:t0', 'user', 'earlier question', 1),
          msg('snapshot:agent:2', 'agent', 'earlier answer', 2),
          msg('turn:t1', 'user', 'edit auth', 5),
          msg('snapshot:agent:8', 'agent', 'Working on it', 8)
        ],
        [EDIT_SUMMARY]
      )
    )
    transport.subscribeSession.mockImplementation(async () => replayOpenTurn(id))
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession(id)

    expect(transport.seedSessionCursor).toHaveBeenCalledWith(id, { lastSeq: 4, logEpoch: null })
    expect(transport.subscribeSession).toHaveBeenCalledWith(id, 4, true)
    expect(timelineKeys(id)).toEqual([
      'user:turn:t0',
      'agent:snapshot:agent:2',
      'user:turn:t1',
      'tool:read-1',
      'tool:fake-edit-1',
      'agent:snapshot:agent:8'
    ])
    const edit = useAcpStore.getState().toolCalls[id].find((t) => t.toolCallId === 'fake-edit-1')
    expect(edit).toMatchObject({
      title: 'Edit src/auth.ts',
      status: 'completed',
      seq: 7,
      restoredSummary: undefined
    })

    // The turn keeps streaming: a card past the watermark lands below.
    await flushTurnEnd()
    useAcpStore.getState()._onToolCall(
      {
        agentId: AGENT,
        sessionId: id,
        toolCall: {
          toolCallId: 'run-1',
          title: 'Run tests',
          kind: 'execute',
          status: 'in_progress'
        }
      },
      13
    )
    _flushCoalescedForTesting()
    expect(timelineKeys(id).at(-1)).toBe('tool:run-1')
  })

  it('a window cut off from the open prompt keeps the watermark cursor and drops covered cards', async () => {
    const id = 's-reopen-cut'
    const transport = fakeWebTransport(
      id,
      livePayload(id, [msg('snapshot:agent:8', 'agent', 'Working on it', 8)], [EDIT_SUMMARY])
    )
    transport.subscribeSession.mockImplementation(async () => replayOpenTurn(id))
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession(id)

    expect(transport.subscribeSession).toHaveBeenCalledWith(id, 12, true)
    expect(timelineKeys(id)).toEqual(['agent:snapshot:agent:8'])
  })

  it('a hidden trailing turn keeps the watermark cursor so its cards never render', async () => {
    const id = 's-reopen-hidden'
    const transport = fakeWebTransport(
      id,
      livePayload(id, [
        msg('turn:t0', 'user', 'earlier question', 1),
        msg('snapshot:agent:2', 'agent', 'earlier answer', 2),
        msg('turn:hidden', 'user', '', 5)
      ])
    )
    transport.subscribeSession.mockImplementation(async () => replayOpenTurn(id))
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession(id)

    expect(transport.subscribeSession).toHaveBeenCalledWith(id, 12, true)
    expect(timelineKeys(id)).toEqual(['user:turn:t0', 'agent:snapshot:agent:2'])
  })
})
