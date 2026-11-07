import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/web-auth-gate', () => ({
  flagWebAuthUnauthorized: vi.fn(),
  getWebAuthGateState: () => ({ status: 'ok', submitting: false })
}))
vi.mock('@/lib/web-protocol-reload', () => ({
  handleProtocolVersionMismatch: vi.fn(),
  clearProtocolMismatchLatch: vi.fn()
}))

import type {
  AskUserQuestionEvent,
  ElicitationRequestEvent,
  PermissionRequestEvent
} from '@/lib/acp-api'
import {
  PendingPromptCoverage,
  type PendingPrompts,
  readPendingPrompts
} from './pending-permissions'
import { WsAcpTransport } from './ws-transport'

const SID = 's1'

function request(requestId: string, sessionId = SID): PermissionRequestEvent {
  return {
    agentId: 'a1',
    sessionId,
    requestId,
    toolCall: { toolCallId: `tc-${requestId}` } as PermissionRequestEvent['toolCall'],
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
  }
}

function question(questionId: string, sessionId = SID): AskUserQuestionEvent {
  return {
    agentId: 'a1',
    sessionId,
    questionId,
    question: 'Which branch?',
    options: [{ value: 'main', label: 'main' }],
    allowFreeText: true
  }
}

function elicitation(requestId: string, sessionId = SID): ElicitationRequestEvent {
  return {
    agentId: 'a1',
    sessionId,
    requestId,
    mode: 'form',
    message: 'Pick a plan',
    fields: [{ name: 'plan', kind: 'string', required: true, title: 'Plan', options: [] }]
  }
}

const NO_LISTS: PendingPrompts = { permissions: null, questions: null, elicitations: null }

describe('readPendingPrompts', () => {
  it('reads every absent list as null', () => {
    expect(readPendingPrompts(SID, { headSeq: 3 })).toEqual(NO_LISTS)
    expect(readPendingPrompts(SID, undefined)).toEqual(NO_LISTS)
  })

  it('keeps well-formed requests of the session per kind and skips the rest', () => {
    const reply = {
      pendingPermissions: [request('perm-1'), request('perm-2', 'other'), { requestId: 'x' }, null],
      pendingQuestions: [question('q-1'), question('q-2', 'other'), { questionId: 'q-3' }],
      pendingElicitations: [
        elicitation('el-1'),
        elicitation('el-2', 'other'),
        { requestId: 'el-3' }
      ]
    }
    expect(readPendingPrompts(SID, reply)).toEqual({
      permissions: [request('perm-1')],
      questions: [question('q-1')],
      elicitations: [elicitation('el-1')]
    })
  })

  it('reads an empty list as authoritative and an absent one as no list', () => {
    expect(readPendingPrompts(SID, { pendingPermissions: [], pendingElicitations: [] })).toEqual({
      permissions: [],
      questions: null,
      elicitations: []
    })
  })
})

describe('PendingPromptCoverage', () => {
  const at = (type: string, seq: number, requestId = 'perm-1') => ({
    type,
    seq,
    payload: { requestId }
  })

  it('covers agent approvals at or below the head of a reply that carried a list', () => {
    const coverage = new PendingPromptCoverage()
    expect(coverage.covers(SID, at('permission_request', 3))).toBe(false)
    coverage.note(SID, 5, { ...NO_LISTS, permissions: [] })
    expect(coverage.covers(SID, at('permission_request', 5))).toBe(true)
    expect(
      coverage.covers(SID, at('permission_request', 6)),
      'live approvals are never covered'
    ).toBe(false)
    expect(coverage.covers(SID, { type: 'tool_call', seq: 2 })).toBe(false)
    expect(
      coverage.covers(SID, at('permission_request', 2, 'host:1')),
      'host tickets are never listed'
    ).toBe(false)
    coverage.note(SID, 9, NO_LISTS)
    expect(
      coverage.covers(SID, at('permission_request', 3)),
      'a reply without a list covers nothing'
    ).toBe(false)
  })

  it('covers each prompt kind only when its own list came', () => {
    const coverage = new PendingPromptCoverage()
    coverage.note(SID, 5, { ...NO_LISTS, elicitations: [] })
    expect(coverage.covers(SID, at('elicitation_request', 4, 'el-1'))).toBe(true)
    expect(coverage.covers(SID, at('question_request', 4, 'q-1'))).toBe(false)
    expect(coverage.covers(SID, at('permission_request', 4))).toBe(false)
    coverage.note(SID, 5, { permissions: [], questions: [], elicitations: [] })
    expect(coverage.covers(SID, at('question_request', 4, 'q-1'))).toBe(true)
    expect(coverage.covers(SID, at('elicitation_request', 6, 'el-1'))).toBe(false)
  })

  it('covers an answered question or elicitation but lets a still-listed one replay', () => {
    const coverage = new PendingPromptCoverage()
    coverage.note(SID, 5, {
      permissions: [request('perm-1')],
      questions: [question('q-live')],
      elicitations: [elicitation('el-live')]
    })
    const replay = (type: string, payload: unknown) => ({ type, seq: 4, payload })
    expect(coverage.covers(SID, replay('question_request', question('q-live')))).toBe(false)
    expect(coverage.covers(SID, replay('question_request', question('q-done')))).toBe(true)
    expect(coverage.covers(SID, replay('elicitation_request', elicitation('el-live')))).toBe(false)
    expect(coverage.covers(SID, replay('elicitation_request', elicitation('el-done')))).toBe(true)
    expect(
      coverage.covers(SID, replay('permission_request', request('perm-1'))),
      'a listed approval is restored by the list, never by replay'
    ).toBe(true)
  })
})

/** A minimal `/ws` host: answers the handshake, subscribe and snapshot requests. */
class PendingHost {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static last: PendingHost | null = null
  /** The `pendingPermissions` each reply carries (`undefined` → no field). */
  static pending: unknown[] | undefined = undefined
  /** Extra pending-list fields each reply carries (`pendingQuestions`, `pendingElicitations`). */
  static pendingPrompts: Record<string, unknown[]> = {}
  static headSeq = 5
  /** Cursors the host refuses `stale` (forces a snapshot). */
  static staleCursor = false
  /** Runs when a `subscribe` arrives, before its reply. */
  static onSubscribe: (() => void) | null = null

  readyState = PendingHost.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  sent: Array<{ id: string; type: string; payload: Record<string, unknown> }> = []

  constructor(public url: string) {
    PendingHost.last = this
    queueMicrotask(() => {
      this.readyState = PendingHost.OPEN
      this.onopen?.(new Event('open'))
      this.emit({ sid: null, seq: 0, type: 'auth_required', payload: {} })
    })
  }

  send(data: string): void {
    const req = JSON.parse(data) as { id: string; type: string; payload: Record<string, unknown> }
    this.sent.push(req)
    const pending = {
      ...(PendingHost.pending === undefined ? {} : { pendingPermissions: PendingHost.pending }),
      ...PendingHost.pendingPrompts
    }
    if (req.type === 'authenticate') {
      this.reply(req.id, { historyMode: 'server', runtimePolicy: {} })
    } else if (req.type === 'subscribe') {
      PendingHost.onSubscribe?.()
      if (PendingHost.staleCursor && req.payload.lastSeq !== undefined) {
        queueMicrotask(() =>
          this.emit({ id: req.id, ok: false, err: { code: 'stale', message: 'stale' } })
        )
        return
      }
      this.reply(req.id, {
        sessionId: req.payload.sessionId,
        replayed: 0,
        logEpoch: 'epoch-A',
        headSeq: PendingHost.headSeq,
        ...pending
      })
    } else if (req.type === 'recover_session_snapshot') {
      this.reply(req.id, {
        sessionId: req.payload.sessionId,
        watermark: PendingHost.headSeq,
        headSeq: PendingHost.headSeq,
        logEpoch: 'epoch-A',
        events: [],
        ...pending
      })
    } else {
      this.reply(req.id, {})
    }
  }

  close(): void {
    this.readyState = PendingHost.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  emit(obj: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(obj) }))
  }

  private reply(id: string, payload: unknown): void {
    queueMicrotask(() => this.emit({ id, ok: true, payload }))
  }
}

const flush = (transport: WsAcpTransport) =>
  (transport as unknown as { eventTail: Promise<void> }).eventTail

async function connected(): Promise<{
  transport: WsAcpTransport
  installed: Array<{ sessionId: string; requests: PermissionRequestEvent[] | null }>
  prompts: Array<{ sessionId: string; prompts: PendingPrompts }>
  delivered: Array<{ requestId: string; seq?: number }>
}> {
  const transport = new WsAcpTransport({
    url: 'ws://test/ws',
    WebSocketImpl: PendingHost as unknown as typeof WebSocket
  })
  const installed: Array<{ sessionId: string; requests: PermissionRequestEvent[] | null }> = []
  const prompts: Array<{ sessionId: string; prompts: PendingPrompts }> = []
  transport.setPendingPromptsHandler((sessionId, lists) => {
    installed.push({ sessionId, requests: lists.permissions })
    prompts.push({ sessionId, prompts: lists })
  })
  transport.setRecoveryHandler(async () => {})
  const delivered: Array<{ requestId: string; seq?: number }> = []
  transport.onEvent<PermissionRequestEvent>('acp:permission_request', (e, seq) =>
    delivered.push({ requestId: e.requestId, seq })
  )
  transport.onEvent<AskUserQuestionEvent>('acp:question_request', (e, seq) =>
    delivered.push({ requestId: e.questionId, seq })
  )
  transport.onEvent<ElicitationRequestEvent>('acp:elicitation_request', (e, seq) =>
    delivered.push({ requestId: e.requestId, seq })
  )
  await transport.connect()
  return { transport, installed, prompts, delivered }
}

describe('WsAcpTransport pending approvals (issue #1595)', () => {
  afterEach(() => {
    PendingHost.pending = undefined
    PendingHost.pendingPrompts = {}
    PendingHost.headSeq = 5
    PendingHost.staleCursor = false
    PendingHost.onSubscribe = null
  })

  it('hands a reconnecting subscription the approvals the host still holds', async () => {
    PendingHost.pending = [request('perm-1')]
    const { transport, installed } = await connected()
    // The cursor is already past the approval: nothing replays it.
    transport.seedSessionCursor(SID, { lastSeq: 5, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    expect(installed).toEqual([{ sessionId: SID, requests: [request('perm-1')] }])
    transport.dispose()
  })

  it('hands a snapshot recovery the approvals the snapshot cannot hold', async () => {
    PendingHost.pending = [request('perm-1')]
    PendingHost.staleCursor = true
    const { transport, installed } = await connected()
    transport.seedSessionCursor(SID, { lastSeq: 3, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    const types = PendingHost.last?.sent.map((req) => req.type)
    expect(types).toContain('recover_session_snapshot')
    expect(installed.at(-1)).toEqual({ sessionId: SID, requests: [request('perm-1')] })
    transport.dispose()
  })

  it('does not restore approvals from a snapshot that a close/reopen made stale', async () => {
    PendingHost.pending = [request('perm-1')]
    PendingHost.staleCursor = true
    const { transport, installed } = await connected()
    let generation = 1
    transport.setRecoveryGenerationProvider(() => generation)
    // The session is closed and reopened while the snapshot is in flight.
    transport.setRecoveryHandler(async () => {
      generation = 2
    })
    transport.seedSessionCursor(SID, { lastSeq: 3, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    expect(PendingHost.last?.sent.map((req) => req.type)).toContain('recover_session_snapshot')
    expect(installed).toEqual([])

    // The same snapshot for an unchanged generation still restores them.
    transport.setRecoveryHandler(async () => {})
    transport.seedSessionCursor(SID, { lastSeq: 3, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID, undefined, true)
    expect(installed).toEqual([{ sessionId: SID, requests: [request('perm-1')] }])
    transport.dispose()
  })

  it('does not restore approvals from a subscribe reply that a close/reopen made stale', async () => {
    PendingHost.pending = [request('perm-1')]
    const { transport, installed } = await connected()
    let generation = 1
    transport.setRecoveryGenerationProvider(() => generation)
    // The session is closed and reopened while the subscribe is in flight.
    PendingHost.onSubscribe = () => {
      generation = 2
    }
    transport.seedSessionCursor(SID, { lastSeq: 5, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    expect(installed).toEqual([])

    // The same reply for an unchanged generation still restores them.
    PendingHost.onSubscribe = null
    await transport.subscribeSession(SID, undefined, true)
    expect(installed).toEqual([{ sessionId: SID, requests: [request('perm-1')] }])
    transport.dispose()
  })

  it('does not replay an answered approval the list settled, but delivers live ones', async () => {
    PendingHost.pending = []
    const { transport, installed, delivered } = await connected()
    transport.seedSessionCursor(SID, { lastSeq: 2, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    expect(installed).toEqual([{ sessionId: SID, requests: [] }])
    const host = PendingHost.last as PendingHost
    // seq 3 is replay of an approval answered while this client was away.
    host.emit({ sid: SID, seq: 3, type: 'permission_request', payload: request('perm-old') })
    host.emit({ sid: SID, seq: 6, type: 'permission_request', payload: request('perm-new') })
    await flush(transport)
    expect(delivered).toEqual([{ requestId: 'perm-new', seq: 6 }])
    transport.dispose()
  })

  it('keeps the old replay behaviour when the host sends no list', async () => {
    const { transport, installed, delivered } = await connected()
    transport.seedSessionCursor(SID, { lastSeq: 2, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    expect(installed).toEqual([])
    const host = PendingHost.last as PendingHost
    host.emit({ sid: SID, seq: 3, type: 'permission_request', payload: request('perm-1') })
    await flush(transport)
    expect(delivered).toEqual([{ requestId: 'perm-1', seq: 3 }])
    transport.dispose()
  })

  it('hands a reopening subscription the questions and elicitations the host still holds', async () => {
    PendingHost.pending = []
    PendingHost.pendingPrompts = {
      pendingQuestions: [question('q-1')],
      pendingElicitations: [elicitation('el-1')]
    }
    const { transport, prompts } = await connected()
    transport.seedSessionCursor(SID, { lastSeq: 5, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    expect(prompts).toEqual([
      {
        sessionId: SID,
        prompts: {
          permissions: [],
          questions: [question('q-1')],
          elicitations: [elicitation('el-1')]
        }
      }
    ])
    transport.dispose()
  })

  it('hands a snapshot recovery the questions and elicitations the host still holds', async () => {
    PendingHost.pendingPrompts = {
      pendingQuestions: [],
      pendingElicitations: [elicitation('el-1')]
    }
    PendingHost.staleCursor = true
    const { transport, prompts } = await connected()
    transport.seedSessionCursor(SID, { lastSeq: 3, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    expect(PendingHost.last?.sent.map((req) => req.type)).toContain('recover_session_snapshot')
    expect(prompts.at(-1)).toEqual({
      sessionId: SID,
      prompts: { permissions: null, questions: [], elicitations: [elicitation('el-1')] }
    })
    transport.dispose()
  })

  it('drops replayed answered questions and elicitations, but delivers listed and live ones', async () => {
    PendingHost.headSeq = 6
    PendingHost.pendingPrompts = {
      pendingQuestions: [question('q-pending')],
      pendingElicitations: [elicitation('el-pending')]
    }
    const { transport, delivered } = await connected()
    transport.seedSessionCursor(SID, { lastSeq: 2, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    const host = PendingHost.last as PendingHost
    // seqs 3 and 4 are replay of prompts answered while this client was away.
    host.emit({ sid: SID, seq: 3, type: 'question_request', payload: question('q-old') })
    host.emit({ sid: SID, seq: 4, type: 'elicitation_request', payload: elicitation('el-old') })
    // seqs 5 and 6 replay prompts raised while the socket was down and still pending.
    host.emit({ sid: SID, seq: 5, type: 'question_request', payload: question('q-pending') })
    host.emit({ sid: SID, seq: 6, type: 'elicitation_request', payload: elicitation('el-pending') })
    host.emit({ sid: SID, seq: 7, type: 'question_request', payload: question('q-new') })
    host.emit({ sid: SID, seq: 8, type: 'elicitation_request', payload: elicitation('el-new') })
    await flush(transport)
    expect(delivered).toEqual([
      { requestId: 'q-pending', seq: 5 },
      { requestId: 'el-pending', seq: 6 },
      { requestId: 'q-new', seq: 7 },
      { requestId: 'el-new', seq: 8 }
    ])
    transport.dispose()
  })

  it('keeps replaying questions and elicitations when the host sends no lists for them', async () => {
    PendingHost.pending = []
    const { transport, prompts, delivered } = await connected()
    transport.seedSessionCursor(SID, { lastSeq: 2, logEpoch: 'epoch-A' })
    await transport.subscribeSession(SID)
    expect(prompts).toEqual([
      { sessionId: SID, prompts: { permissions: [], questions: null, elicitations: null } }
    ])
    const host = PendingHost.last as PendingHost
    host.emit({ sid: SID, seq: 3, type: 'question_request', payload: question('q-1') })
    host.emit({ sid: SID, seq: 4, type: 'elicitation_request', payload: elicitation('el-1') })
    await flush(transport)
    expect(delivered).toEqual([
      { requestId: 'q-1', seq: 3 },
      { requestId: 'el-1', seq: 4 }
    ])
    transport.dispose()
  })
})
