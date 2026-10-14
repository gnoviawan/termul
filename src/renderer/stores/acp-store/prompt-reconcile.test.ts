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
    // Keep the REAL full loader: in server-history mode it reads through the
    // fake transport's `getSessionPayload` (the "host-owned" durable record).
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
  getAllTreeRoots: () => [],
  findPaneContainingTab: () => null,
  useWorkspaceStore: {
    getState: () => ({ addAgentChatTab: vi.fn(), root: null })
  }
}))

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))

const { mockPersistenceApi } = vi.hoisted(() => ({
  mockPersistenceApi: {
    read: vi.fn(async () => ({ success: false })),
    write: vi.fn(),
    writeDebounced: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true }))
  }
}))
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: mockPersistenceApi
  }
})

import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport,
  AcpTransportError
} from '@/lib/acp-transport'
import { __detachedCommandCountForTesting, COMMAND_RESEND_DELAYS_MS } from '@/lib/command-engine'
import { listUnresolvedCommands } from '@/lib/command-journal'
import { logFrontendError } from '@/lib/log-api'
import {
  _flushCoalescedForTesting,
  _installTransportRecoveryForTesting,
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetPromptReconcileForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  initAcpEventListeners,
  useAcpStore
} from '@/stores/acp-store'
import {
  activeWirePromptTurns,
  echoedWirePromptTurns,
  historySeqWatermarks,
  inFlightPromotions
} from './shared-state'
import { resendPendingPrompts } from './slices/prompt-reconcile'
import { FRESH, flushTurnEnd, seedSession } from './testkit'

type SendPromptFn = (
  agentId: string,
  sessionId: string,
  text: string,
  turnId?: string
) => Promise<unknown>

function installTransport(sendPrompt: SendPromptFn): ReturnType<typeof vi.fn> {
  const spy = vi.fn(sendPrompt)
  _setAcpTransportForTests({
    sendPrompt: spy,
    sendPromptBlocks: spy,
    cancelPrompt: vi.fn(async () => {}),
    dispose: () => {}
  } as unknown as AcpTransport)
  return spy
}

const drop = (): AcpTransportError => new AcpTransportError('closed', 'WebSocket closed')

/** Wire turn id the store minted for the dispatch (3rd arg of sendPrompt). */
function sentTurnIds(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map((call) => String(call[3]))
}

describe('prompt pending-reconcile (AD-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    _resetAcpTransportForTests(null)
    _resetAcpAuthForTesting()
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetPromptReconcileForTesting()
    useAcpStore.setState(FRESH)
  })

  it('a dropped reply is pending-reconcile, not failed: turn stays open, no error, no throw', async () => {
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    await flushTurnEnd()
    const state = useAcpStore.getState()
    expect(state.sessions.s1.activeTurn).toBe(true)
    expect(state.sessions.s1.openTurnId).toBeTruthy()
    expect(state.sessions.s1.lastError).toBeNull()
    expect(state.promptCommandStates.s1?.phase).toBe('pending-reconcile')
    // The optimistic user message stays; nothing was re-queued for a new intent.
    expect(state.messages.s1).toHaveLength(1)
    expect(state.promptQueues.s1).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('resends the SAME turn id on recovery; an in_progress receipt keeps the turn open', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    const send = installTransport(async () => {
      calls += 1
      if (calls === 1) throw drop()
      return { receipt: 'in_progress' }
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    resendPendingPrompts()
    await flushTurnEnd()
    const ids = sentTurnIds(send)
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    const state = useAcpStore.getState()
    // A receipt resolves the command only — never the turn.
    expect(state.sessions.s1.activeTurn).toBe(true)
    expect(state.sessions.s1.lastError).toBeNull()
    expect(state.promptCommandStates.s1).toBeUndefined()
    // The durable terminator closes it (live or replayed).
    state._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn',
      turnId: ids[0]
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
  })

  it('an accepted receipt (turn already finished) never ends the turn view itself', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    installTransport(async () => {
      calls += 1
      if (calls === 1) throw drop()
      return { receipt: 'accepted' }
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    resendPendingPrompts()
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
  })

  it('a stop reason from the resend resolves the command only; the turn ends from its durable prompt_complete', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    installTransport(async () => {
      calls += 1
      if (calls === 1) throw drop()
      return 'end_turn'
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    resendPendingPrompts()
    // The resend settles in microtasks; its deferred turn end is one macrotask later.
    await flushTurnEnd()
    await flushTurnEnd()
    // The reply resolved the COMMAND; the turn view waits for the log.
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn',
      turnId: activeWirePromptTurns.get('s1')
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
  })

  it('a definite server rejection of the resend fails the turn (Retry = new intent)', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    installTransport(async () => {
      calls += 1
      if (calls === 1) throw drop()
      throw new AcpTransportError('invalid_request', 'prompt rejected')
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    resendPendingPrompts()
    await flushTurnEnd()
    const state = useAcpStore.getState()
    expect(state.sessions.s1.activeTurn).toBe(false)
    expect(state.sessions.s1.lastError).toContain('prompt rejected')
    expect(state.promptCommandStates.s1).toBeUndefined()
  })

  it('a definite rejection on the FIRST dispatch is still failed and thrown', async () => {
    seedSession('s1', 'agent-1', false)
    installTransport(async () => {
      throw new AcpTransportError('invalid_request', 'bad prompt')
    })
    await expect(useAcpStore.getState().sendPrompt('s1', 'x')).rejects.toThrow('bad prompt')
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
  })

  it('dedupes resends: one in flight at a time', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    let resendGate!: (v: unknown) => void
    let calls = 0
    const send = installTransport(() => {
      calls += 1
      if (calls === 1) return Promise.reject(drop())
      return new Promise((resolve) => {
        resendGate = resolve
      })
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    resendPendingPrompts()
    resendPendingPrompts()
    resendPendingPrompts('s1')
    expect(send).toHaveBeenCalledTimes(2) // first dispatch + ONE resend
    resendGate({ receipt: 'in_progress' })
    await vi.advanceTimersByTimeAsync(0)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    vi.useRealTimers()
  })

  it('timer-driven retries back off, then settle into a slow capped cadence while pending', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    const ladder = COMMAND_RESEND_DELAYS_MS
    const slow = ladder[ladder.length - 1]
    for (const delay of ladder) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(send).toHaveBeenCalledTimes(1 + ladder.length)
    // Ladder spent: the slow cap keeps retrying — one resend per slow interval.
    await vi.advanceTimersByTimeAsync(slow * 3)
    expect(send).toHaveBeenCalledTimes(1 + ladder.length + 3)
    expect(useAcpStore.getState().promptCommandStates.s1?.phase).toBe('pending-reconcile')
    expect(useAcpStore.getState().sessions.s1.lastError).toBeNull()
    // Recovery events still resend at once; every call carries the one turn id.
    resendPendingPrompts()
    expect(send).toHaveBeenCalledTimes(2 + ladder.length + 3)
    expect(new Set(sentTurnIds(send)).size).toBe(1)
    vi.useRealTimers()
  })

  it('the slow retry stops once the turn ends (terminator) — no resend after', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    const ladder = COMMAND_RESEND_DELAYS_MS
    for (const delay of ladder) await vi.advanceTimersByTimeAsync(delay)
    const before = send.mock.calls.length
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn',
      turnId: sentTurnIds(send)[0]
    })
    await vi.advanceTimersByTimeAsync(10 * ladder[ladder.length - 1])
    expect(send).toHaveBeenCalledTimes(before)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    vi.useRealTimers()
  })

  it('the slow retry stops when the session is removed', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    const ladder = COMMAND_RESEND_DELAYS_MS
    for (const delay of ladder) await vi.advanceTimersByTimeAsync(delay)
    const before = send.mock.calls.length
    useAcpStore.setState({ sessions: {} })
    await vi.advanceTimersByTimeAsync(3 * ladder[ladder.length - 1])
    expect(send).toHaveBeenCalledTimes(before)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    vi.useRealTimers()
  })

  it('a locally raised failure of the resend (token halt / dropped socket) keeps the command pending', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    installTransport(async () => {
      calls += 1
      if (calls === 1) throw drop()
      if (calls === 2) throw new AcpTransportError('unauthorized', 'web auth token rejected')
      return { receipt: 'in_progress' }
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    resendPendingPrompts()
    await flushTurnEnd()
    const halted = useAcpStore.getState()
    expect(halted.sessions.s1.activeTurn).toBe(true)
    expect(halted.sessions.s1.lastError).toBeNull()
    expect(halted.promptCommandStates.s1?.phase).toBe('pending-reconcile')
    // Still resendable: the next recovery resolves it with the receipt.
    resendPendingPrompts()
    await flushTurnEnd()
    expect(calls).toBe(3)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
  })

  it('a reconnect cycle that ends WITHOUT recovery (token halt) does not resend; a real recovery does', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    let reconnectListener: ((reconnecting: boolean, recovered?: boolean) => void) | undefined
    const sendPrompt = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw drop()
      return { receipt: 'in_progress' }
    })
    _setAcpTransportForTests({
      setReconnectListener: (listener: typeof reconnectListener) => {
        reconnectListener = listener
      },
      setReconnectPriorityProvider: vi.fn(),
      setRecoveryHandler: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      sendPrompt,
      sendPromptBlocks: sendPrompt,
      cancelPrompt: vi.fn(async () => {}),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    const teardown = initAcpEventListeners()
    try {
      await useAcpStore.getState().sendPrompt('s1', 'deploy')
      reconnectListener?.(true)
      reconnectListener?.(false, false)
      await flushTurnEnd()
      expect(sendPrompt).toHaveBeenCalledTimes(1)
      expect(useAcpStore.getState().promptCommandStates.s1?.phase).toBe('pending-reconcile')
      reconnectListener?.(true)
      reconnectListener?.(false, true)
      await flushTurnEnd()
      expect(sendPrompt).toHaveBeenCalledTimes(2)
      expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    } finally {
      teardown()
    }
  })

  it('a dropped reply for a turn that already ended is not reconciled (nothing to confirm)', async () => {
    seedSession('s1', 'agent-1', false)
    let reject!: (e: unknown) => void
    const send = installTransport(
      () =>
        new Promise((_, rej) => {
          reject = rej
        })
    )
    const running = useAcpStore.getState().sendPrompt('s1', 'deploy')
    await flushTurnEnd()
    const turnId = sentTurnIds(send)[0]
    // The terminator lands while the command reply is still outstanding…
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn',
      turnId
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
    // …then the socket drops and the reply is lost.
    reject(drop())
    await running
    await flushTurnEnd()
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    resendPendingPrompts()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a dropped reply after a newer turn took over is not reconciled against it', async () => {
    seedSession('s1', 'agent-1', false)
    let reject!: (e: unknown) => void
    const send = installTransport(
      () =>
        new Promise((_, rej) => {
          reject = rej
        })
    )
    const running = useAcpStore.getState().sendPrompt('s1', 'first')
    await flushTurnEnd()
    // The first turn ends and a second one opens before the first reply drops.
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: { ...s.sessions.s1, activeTurn: true, openTurnId: 'second-turn' }
      }
    }))
    activeWirePromptTurns.set('s1', 'second-wire')
    reject(drop())
    await running
    await flushTurnEnd()
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the user_prompt echo for the turn resolves the command (accepted) without a resend', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    const turnId = sentTurnIds(send)[0]
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's1',
      turnId,
      content: [{ type: 'text', text: 'deploy' }]
    })
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledTimes(1)
    // …and the turn is still open until its terminator.
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    vi.useRealTimers()
  })

  it('echo seen, socket dies: the lost reply settles accepted — no pending-reconcile, turn stays open', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    let reject!: (e: unknown) => void
    const send = installTransport(
      () =>
        new Promise((_, rej) => {
          reject = rej
        })
    )
    const running = useAcpStore.getState().sendPrompt('s1', 'deploy')
    await vi.advanceTimersByTimeAsync(0)
    const turnId = sentTurnIds(send)[0]
    // The host accepted the turn: its echo lands while the reply is outstanding…
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's1',
      turnId,
      content: [{ type: 'text', text: 'deploy' }]
    })
    expect(echoedWirePromptTurns.get('s1')).toBe(turnId)
    // …then the socket dies and the reply is lost.
    reject(drop())
    await running
    const state = useAcpStore.getState()
    expect(state.promptCommandStates.s1).toBeUndefined()
    expect(__detachedCommandCountForTesting()).toBe(0)
    // Settled accepted on the echo-proof path (ids only in the log).
    expect(
      vi
        .mocked(logFrontendError)
        .mock.calls.some(
          ([entry]) =>
            entry.source === 'acp-store.promptReceipt' &&
            entry.message.includes(turnId) &&
            entry.message.includes('after its user_prompt echo')
        )
    ).toBe(true)
    expect(state.sessions.s1.activeTurn).toBe(true)
    expect(state.sessions.s1.lastError).toBeNull()
    // Nothing is resent on recovery or by the retry timer.
    resendPendingPrompts()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    // The turn view ends only from its durable prompt_complete, which also
    // frees the echo record.
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn',
      turnId
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
    expect(echoedWirePromptTurns.has('s1')).toBe(false)
    vi.useRealTimers()
  })

  it('echo seen, socket dies mid-stream: the resubscribe replay renders every chunk once, in order', async () => {
    seedSession('s1', 'agent-1', false)
    const reply = Promise.withResolvers<unknown>()
    const send = vi.fn(
      (_agentId: string, _sessionId: string, _text: string, _turnId?: string) => reply.promise
    )
    // The web client: the host owns the history, events carry host seqs.
    _setAcpTransportForTests({
      historyMode: () => 'server',
      sendPrompt: send,
      sendPromptBlocks: send,
      cancelPrompt: vi.fn(async () => {}),
      dispose: () => {}
    } as unknown as AcpTransport)
    const chunk = (n: number, seq: number): void =>
      useAcpStore.getState()._onMessageChunk(
        {
          agentId: 'agent-1',
          sessionId: 's1',
          role: 'agent',
          content: { type: 'text', text: `chunk-${n} ` }
        },
        seq
      )
    const running = useAcpStore.getState().sendPrompt('s1', 'long stream')
    await flushTurnEnd()
    const turnId = sentTurnIds(send)[0]
    useAcpStore.getState()._onUserPrompt(
      {
        agentId: 'agent-1',
        sessionId: 's1',
        turnId,
        content: [{ type: 'text', text: 'long stream' }]
      },
      1
    )
    // Live chunks up to seq 4, then the socket dies with the reply outstanding.
    for (let n = 1; n <= 3; n++) chunk(n, n + 1)
    _flushCoalescedForTesting()
    reply.reject(drop())
    await running
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    // Back on a new socket: nothing is resent, and the resubscribe replays the
    // missed range (seq 5..10) before the turn's durable end.
    resendPendingPrompts()
    for (let n = 4; n <= 9; n++) chunk(n, n + 1)
    _flushCoalescedForTesting()
    useAcpStore
      .getState()
      ._onPromptComplete(
        { agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn', turnId },
        11
      )
    await flushTurnEnd()
    const state = useAcpStore.getState()
    expect(send).toHaveBeenCalledTimes(1)
    expect(state.sessions.s1.activeTurn).toBe(false)
    const agent = state.messages.s1.filter((m) => m.role === 'agent')
    expect(agent).toHaveLength(1)
    expect(agent[0].blocks).toEqual([
      { type: 'text', text: Array.from({ length: 9 }, (_, i) => `chunk-${i + 1} `).join('') }
    ])
  })

  it('a history-covered echo still proves acceptance for a lost reply', async () => {
    seedSession('s1', 'agent-1', false)
    let reject!: (e: unknown) => void
    const send = installTransport(
      () =>
        new Promise((_, rej) => {
          reject = rej
        })
    )
    const running = useAcpStore.getState().sendPrompt('s1', 'deploy')
    await flushTurnEnd()
    const turnId = sentTurnIds(send)[0]
    // A replayed echo at or below the installed history watermark is dropped
    // for rendering, but still records acceptance.
    historySeqWatermarks.set('s1', 10)
    useAcpStore.getState()._onUserPrompt(
      {
        agentId: 'agent-1',
        sessionId: 's1',
        turnId,
        content: [{ type: 'text', text: 'deploy' }]
      },
      5
    )
    expect(echoedWirePromptTurns.get('s1')).toBe(turnId)
    reject(drop())
    await running
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
  })

  it('a history-covered echo landing after pending-reconcile began resolves it without a resend', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    const turnId = sentTurnIds(send)[0]
    expect(useAcpStore.getState().promptCommandStates.s1?.phase).toBe('pending-reconcile')
    historySeqWatermarks.set('s1', 10)
    useAcpStore.getState()._onUserPrompt(
      {
        agentId: 'agent-1',
        sessionId: 's1',
        turnId,
        content: [{ type: 'text', text: 'deploy' }]
      },
      5
    )
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    resendPendingPrompts()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    vi.useRealTimers()
  })

  it('echo not seen, socket dies: pending-reconcile as before, resent on recovery', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    const send = installTransport(async () => {
      calls += 1
      if (calls === 1) throw drop()
      return { receipt: 'in_progress' }
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    await flushTurnEnd()
    expect(echoedWirePromptTurns.has('s1')).toBe(false)
    expect(useAcpStore.getState().promptCommandStates.s1?.phase).toBe('pending-reconcile')
    resendPendingPrompts()
    await flushTurnEnd()
    const ids = sentTurnIds(send)
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
  })

  it('echo of an older turn: a lost reply for the newer turn still enters pending-reconcile', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    let rejectSecond!: (e: unknown) => void
    const send = installTransport(
      () =>
        new Promise((resolve, rej) => {
          calls += 1
          if (calls === 1) resolve({ receipt: 'accepted' })
          else rejectSecond = rej
        })
    )
    // Turn T0: echoed, then completed.
    await useAcpStore.getState().sendPrompt('s1', 'first')
    await flushTurnEnd()
    const t0 = sentTurnIds(send)[0]
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's1',
      turnId: t0,
      content: [{ type: 'text', text: 'first' }]
    })
    expect(echoedWirePromptTurns.get('s1')).toBe(t0)
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn',
      turnId: t0
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
    // Turn T1: an echo citing the OLD turn (a replay) proves nothing for T1.
    const running = useAcpStore.getState().sendPrompt('s1', 'second')
    await flushTurnEnd()
    const t1 = sentTurnIds(send)[1]
    expect(t1).not.toBe(t0)
    useAcpStore.getState()._onUserPrompt({
      agentId: 'agent-1',
      sessionId: 's1',
      turnId: t0,
      content: [{ type: 'text', text: 'first' }]
    })
    expect(echoedWirePromptTurns.get('s1')).toBeUndefined()
    rejectSecond(drop())
    await running
    await flushTurnEnd()
    const state = useAcpStore.getState()
    expect(state.promptCommandStates.s1?.phase).toBe('pending-reconcile')
    expect(state.sessions.s1.activeTurn).toBe(true)
  })

  it('a stale echo left over for the same session does not leak into the next turn', async () => {
    seedSession('s1', 'agent-1', false)
    installTransport(async () => {
      throw drop()
    })
    // A leftover record for an unrelated turn id must not short-circuit.
    echoedWirePromptTurns.set('s1', 'some-older-turn')
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    await flushTurnEnd()
    expect(useAcpStore.getState().promptCommandStates.s1?.phase).toBe('pending-reconcile')
  })

  it('Stop abandons an unconfirmed prompt: no later resend, the turn view ends', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    await useAcpStore.getState().cancelPrompt('s1')
    await vi.advanceTimersByTimeAsync(0)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    resendPendingPrompts()
    expect(send).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('Stop while a resend is in flight cancels again once that resend settles; the cancelled command never re-dispatches', async () => {
    seedSession('s1', 'agent-1', false)
    let resolveResend!: (v: unknown) => void
    let calls = 0
    const cancel = vi.fn(async () => {})
    const send = vi.fn(() => {
      calls += 1
      if (calls === 1) return Promise.reject(drop())
      return new Promise((resolve) => {
        resolveResend = resolve
      })
    })
    _setAcpTransportForTests({
      sendPrompt: send,
      sendPromptBlocks: send,
      cancelPrompt: cancel,
      dispose: () => {}
    } as unknown as AcpTransport)
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    resendPendingPrompts() // resend now in flight
    expect(send).toHaveBeenCalledTimes(2)
    await useAcpStore.getState().cancelPrompt('s1')
    expect(cancel).toHaveBeenCalledTimes(1)
    // The host may still start the turn from the in-flight resend: cancel again.
    resolveResend('end_turn')
    await flushTurnEnd()
    expect(cancel).toHaveBeenCalledTimes(2)
    // Cancelled: no recovery event can dispatch it again.
    resendPendingPrompts()
    expect(send).toHaveBeenCalledTimes(2)
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
  })

  it('a late prompt_complete for the turn Stop abandoned is stale: it cannot end a newer open turn', async () => {
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    const abandoned = sentTurnIds(send)[0]
    await useAcpStore.getState().cancelPrompt('s1')
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
    // A newer turn is open (its wire id is not tracked yet) …
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: { ...s.sessions.s1, activeTurn: true, openTurnId: 'newer', lastError: null }
      }
    }))
    // … when the host's terminator for the abandoned turn arrives late.
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn',
      turnId: abandoned
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    expect(useAcpStore.getState().sessions.s1.openTurnId).toBe('newer')
  })

  it('a replayed prompt_complete for the previous turn cannot close a new turn awaiting its warm-pool promotion', async () => {
    seedSession('s1', 'agent-1', false)
    let release!: () => void
    inFlightPromotions.set(
      's1',
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const send = installTransport(async () => ({ receipt: 'in_progress' }))
    const running = useAcpStore.getState().sendPrompt('s1', 'first prompt')
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    expect(send).not.toHaveBeenCalled() // still holding for the promotion
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn',
      turnId: 'previous-turn'
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    release()
    await running
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the late prompt_complete for a turn Stop abandoned still flushes a prompt queued behind the idle session, without ending the new turn', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    const send = installTransport(async () => {
      calls += 1
      if (calls === 1) throw drop()
      return { receipt: 'in_progress' }
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    const abandoned = sentTurnIds(send)[0]
    await useAcpStore.getState().cancelPrompt('s1')
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
    // A prompt is waiting in the queue behind the (now idle) session.
    useAcpStore.setState((s) => ({
      promptQueues: {
        ...s.promptQueues,
        s1: [{ id: 'q1', blocks: [{ type: 'text', text: 'next' }], createdAt: 1 }]
      }
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'cancelled',
      turnId: abandoned
    })
    await flushTurnEnd()
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentTurnIds(send)[1]).not.toBe(abandoned)
    expect(useAcpStore.getState().promptQueues.s1 ?? []).toHaveLength(0)
    // The queued prompt's turn is open and the stale terminator did not end it.
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
  })

  it('closing a session with a pending prompt frees its reconcile state and timer', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    expect(__detachedCommandCountForTesting()).toBe(1)
    expect(activeWirePromptTurns.size).toBe(1)
    useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId: 's1' } as never)
    expect(__detachedCommandCountForTesting()).toBe(0)
    expect(activeWirePromptTurns.size).toBe(0)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(send).toHaveBeenCalledTimes(1) // the cancelled timer never resends
    vi.useRealTimers()
  })

  it('snapshot recovery resolves it: the recovered terminator ends the turn', async () => {
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    const turnId = sentTurnIds(send)[0]
    await _installTransportRecoveryForTesting({
      sessionId: 's1',
      watermark: 9,
      events: [
        { sid: 's1', seq: 5, type: 'user_prompt', payload: { turnId, content: [] } },
        { sid: 's1', seq: 8, type: 'prompt_complete', payload: { turnId, stopReason: 'end_turn' } }
      ]
    } as never)
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
  })

  it('snapshot recovery without a terminator resends the same turn id at once', async () => {
    seedSession('s1', 'agent-1', false)
    let calls = 0
    const send = installTransport(async () => {
      calls += 1
      if (calls === 1) throw drop()
      return { receipt: 'in_progress' }
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    await _installTransportRecoveryForTesting({
      sessionId: 's1',
      watermark: 3,
      events: []
    } as never)
    await flushTurnEnd()
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentTurnIds(send)[1]).toBe(sentTurnIds(send)[0])
  })

  it.each([
    ['_onAgentError' as const],
    ['_onAgentCrashed' as const]
  ])('%s without a sessionId ends tracking for EVERY session of the agent (no zombie resend)', async (handler) => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s2: { ...s.sessions.s1, id: 's2' } },
      messages: { ...s.messages, s2: [] }
    }))
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'one')
    await useAcpStore.getState().sendPrompt('s2', 'two')
    expect(Object.keys(useAcpStore.getState().promptCommandStates).sort()).toEqual(['s1', 's2'])
    expect(activeWirePromptTurns.size).toBe(2)
    const calls = send.mock.calls.length
    useAcpStore.getState()[handler]({ agentId: 'agent-1', message: 'boom' } as never)
    expect(useAcpStore.getState().promptCommandStates).toEqual({})
    expect(activeWirePromptTurns.size).toBe(0)
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
    expect(useAcpStore.getState().sessions.s2.activeTurn).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    resendPendingPrompts()
    expect(send).toHaveBeenCalledTimes(calls)
    vi.useRealTimers()
  })

  it('never logs prompt content', async () => {
    seedSession('s1', 'agent-1', false)
    installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'SECRET-PROMPT-BODY')
    for (const [entry] of vi.mocked(logFrontendError).mock.calls) {
      expect(JSON.stringify(entry)).not.toContain('SECRET-PROMPT-BODY')
    }
  })
})

describe('turn terminators (AD-5): error / timeout / crashed', () => {
  beforeEach(() => {
    vi.useRealTimers()
    _resetCoalesceForTesting()
    _resetPromptReconcileForTesting()
    useAcpStore.setState(FRESH)
  })

  it.each([
    'error',
    'timeout',
    'crashed'
  ])('%s ends the turn with an error-ish presentation and never leaves the UI busy', async (stopReason) => {
    seedSession('s1', 'agent-1', true)
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason,
      turnId: 't1'
    })
    await flushTurnEnd()
    const session = useAcpStore.getState().sessions.s1
    expect(session.activeTurn).toBe(false)
    expect(session.openTurnId).toBeNull()
    expect(session.lastError).toBeTruthy()
  })

  it('keeps the specific agent_error message instead of the generic terminator note', async () => {
    seedSession('s1', 'agent-1', true)
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s1: { ...s.sessions.s1, lastError: 'rate limit exceeded' } }
    }))
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'error',
      turnId: 't1'
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.lastError).toBe('rate limit exceeded')
  })

  it('a stale terminator for an earlier turn cannot end the turn this client has open', async () => {
    seedSession('s1', 'agent-1', false)
    let release!: (v: unknown) => void
    installTransport(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const running = useAcpStore.getState().sendPrompt('s1', 'second turn')
    await flushTurnEnd()
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'timeout',
      turnId: 'earlier-turn'
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    const turnId = activeWirePromptTurns.get('s1')
    release('end_turn')
    await running
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'end_turn',
      turnId
    })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)
  })

  it('is idempotent by turn id: a duplicate terminator cannot end the next turn', async () => {
    seedSession('s1', 'agent-1', true)
    const complete = (turnId: string): void =>
      useAcpStore.getState()._onPromptComplete({
        agentId: 'agent-1',
        sessionId: 's1',
        stopReason: 'error',
        turnId
      })
    complete('t1')
    await flushTurnEnd()
    // A new turn opens, then the duplicate (replay) of t1's terminator arrives.
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: { ...s.sessions.s1, activeTurn: true, openTurnId: 'next', lastError: null }
      }
    }))
    complete('t1')
    await flushTurnEnd()
    const session = useAcpStore.getState().sessions.s1
    expect(session.activeTurn).toBe(true)
    expect(session.lastError).toBeNull()
  })
})

describe('command state surfaced to the chat (AD-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    _resetAcpTransportForTests(null)
    _resetAcpAuthForTesting()
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetPromptReconcileForTesting()
    useAcpStore.setState(FRESH)
  })

  it('outcome_unknown on a resend holds the command ("outcome unknown — check"); a manual re-check resends the SAME turn id', async () => {
    vi.useFakeTimers()
    seedSession('s1', 'agent-1', false)
    let calls = 0
    const send = installTransport(async () => {
      calls += 1
      if (calls === 1) throw drop()
      if (calls === 2) throw new AcpTransportError('outcome_unknown', 'no longer known')
      return { receipt: 'accepted' }
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[0])
    expect(send).toHaveBeenCalledTimes(2)
    expect(useAcpStore.getState().promptCommandStates.s1).toMatchObject({
      phase: 'pending-reconcile',
      outcomeUnknown: true
    })
    // Not a failure, and nothing is resent on its own — not on the timer, not on recovery.
    expect(useAcpStore.getState().sessions.s1.lastError).toBeNull()
    await vi.advanceTimersByTimeAsync(10 * COMMAND_RESEND_DELAYS_MS[3])
    resendPendingPrompts()
    expect(send).toHaveBeenCalledTimes(2)

    useAcpStore.getState().recheckPromptCommand('s1')
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(3)
    expect(new Set(sentTurnIds(send)).size).toBe(1)
    expect(useAcpStore.getState().promptCommandStates.s1).toBeUndefined()
    // Still open: the receipt resolved the command, the log ends the turn.
    expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(true)
    vi.useRealTimers()
  })

  it('a prompt turn id is never persisted: a reload cannot reuse it for another prompt, so nothing lingers', async () => {
    seedSession('s1', 'agent-1', false)
    const send = installTransport(async () => {
      throw drop()
    })
    await useAcpStore.getState().sendPrompt('s1', 'deploy')
    expect(sentTurnIds(send)).toHaveLength(1)
    // Even while the command waits to be confirmed, the journal holds nothing.
    expect(listUnresolvedCommands()).toHaveLength(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('an ephemeral (warm-pool) create answered by lookup fails clearly instead of opening from history', async () => {
    vi.useFakeTimers()
    useAcpStore.setState({
      agents: { 'agent-1': { id: 'agent-1', capabilities: {} } },
      agentStatus: { 'agent-1': 'connected' }
    })
    let attempt = 0
    _setAcpTransportForTests({
      newSession: vi.fn(async () => {
        attempt += 1
        if (attempt === 1) throw drop()
        return { sessionId: 's-ghost' }
      }),
      dispose: () => {}
    } as unknown as AcpTransport)
    const openHistorySession = vi.fn(async () => {})
    useAcpStore.setState({ openHistorySession })
    const creating = useAcpStore
      .getState()
      .createSession('agent-1', '/work', [], 'p1', { ephemeral: true, backendEphemeral: true })
    const outcome = creating.then(
      () => 'resolved',
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(String(await outcome)).toMatch(/temporary session could not be confirmed/)
    expect(openHistorySession).not.toHaveBeenCalled()
    expect(useAcpStore.getState().sessions['s-ghost']).toBeUndefined()
    vi.useRealTimers()
  })

  it('a reply-lost session create resent by the host lookup opens from history instead of building from the reply', async () => {
    vi.useFakeTimers()
    useAcpStore.setState({
      agents: { 'agent-1': { id: 'agent-1', capabilities: {} } },
      agentStatus: { 'agent-1': 'connected' }
    })
    const optionsSeen: Array<{ commandId?: string } | undefined> = []
    let attempt = 0
    _setAcpTransportForTests({
      newSession: vi.fn(async (...args: unknown[]) => {
        optionsSeen.push(args[3] as { commandId?: string })
        attempt += 1
        if (attempt === 1) throw drop()
        return { sessionId: 's-late' }
      }),
      dispose: () => {}
    } as unknown as AcpTransport)
    const openHistorySession = vi.fn(async () => {})
    useAcpStore.setState({ openHistorySession })
    const creating = useAcpStore.getState().createSession('agent-1', '/work', [], 'p1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await creating).toBe('s-late')
    expect(optionsSeen[1]?.commandId).toBe(optionsSeen[0]?.commandId)
    expect(openHistorySession).toHaveBeenCalledWith('s-late')
    expect(useAcpStore.getState().sessions['s-late']).toBeUndefined()
    vi.useRealTimers()
  })
})
