import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  AcpTransportError,
  createAcpTransport,
  resolveWsUrl,
  toTauriEventName,
  toWsEventType,
  WsAcpTransport
} from './acp-transport'

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3

  readyState = FakeWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  sent: string[] = []
  authFail = false
  /** When set, `respond_permission` replies with this err (default: not_implemented). */
  respondPermissionErr: { code: string; message: string } | null = null
  /** When true, `send_prompt` emits streaming message_chunk + prompt_complete
   * events (echoing the client turnId) — used by the AC3 chat-flow test. */
  streamOnSendPrompt = false
  /** When true, do not auto-reply to `send_prompt` (for timeout tests). */
  holdSendPrompt = false
  /** Live agent ids for spawn_agent / list_agents / kill_agent stubs. */
  liveAgents = new Set<string>()
  reopenOutcome: unknown = {
    modes: {
      currentModeId: 'ask',
      availableModes: [{ id: 'ask', name: 'Ask' }]
    },
    models: {
      currentModelId: 'model-a',
      availableModels: [{ modelId: 'model-a', name: 'Model A' }]
    },
    configOptions: []
  }

  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.(new Event('open'))
      // Server emits auth_required first.
      this.emit({ sid: null, seq: 0, type: 'auth_required', payload: {} })
    })
  }

  send(data: string): void {
    this.sent.push(data)
    const req = JSON.parse(data) as { id: string; type: string; payload: unknown }
    if (req.type === 'authenticate') {
      if (this.authFail) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'unauthorized', message: 'bad token' }
        })
        return
      }
      this.emitReply({ id: req.id, ok: true, payload: {} })
      return
    }
    if (req.type === 'subscribe') {
      const payload = req.payload as { sessionId: string; lastSeq?: number }
      if (payload.lastSeq === 99) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'stale', message: 'cursor stale' }
        })
        return
      }
      this.emitReply({
        id: req.id,
        ok: true,
        payload: { sessionId: payload.sessionId, replayed: 0 }
      })
      return
    }
    if (req.type === 'create_session') {
      // Story 1.8 AC3 chat-flow test: reply with a NewSessionOutcome + echo the
      // client-subscribed session id. Tests assert the transport resolves the
      // promise with the session id.
      const payload = req.payload as { agentId: string; cwd: string }
      const sessionId = 'sess-chatflow'
      this.emitReply({
        id: req.id,
        ok: true,
        payload: { sessionId, modes: null, models: null, configOptions: null }
      })
      void payload
      return
    }
    if (req.type === 'load_session' || req.type === 'resume_session') {
      this.emitReply({ id: req.id, ok: true, payload: this.reopenOutcome })
      return
    }
    if (req.type === 'send_prompt') {
      if (this.holdSendPrompt) return
      // Story 1.8 AC3 chat-flow test: stream message_chunk events + a
      // prompt_complete (echoing the client turnId) so the transport's event
      // subscribers + seenTurnIds dedup are exercised end-to-end.
      const payload = req.payload as { sessionId: string; turnId?: string }
      this.emitReply({ id: req.id, ok: true, payload: 'end_turn' })
      if (this.streamOnSendPrompt) {
        this.emit({
          sid: payload.sessionId,
          seq: 1,
          type: 'message_chunk',
          payload: { role: 'agent', content: { text: 'Hello' }, i: 1 }
        })
        this.emit({
          sid: payload.sessionId,
          seq: 2,
          type: 'message_chunk',
          payload: { role: 'agent', content: { text: ' world' }, i: 2 }
        })
        this.emit({
          sid: payload.sessionId,
          seq: 3,
          type: 'prompt_complete',
          payload: { stopReason: 'end_turn', turnId: payload.turnId }
        })
      }
      return
    }
    if (req.type === 'respond_permission') {
      // Story 1.7 T8.3: by default reject as not_implemented; tests set
      // `respondPermissionErr` to exercise the stale/duplicate → AcpTransportError mapping.
      const err = this.respondPermissionErr ?? { code: 'not_implemented', message: 'stub' }
      this.emitReply({ id: req.id, ok: false, err })
      return
    }
    if (req.type === 'spawn_agent') {
      const payload = req.payload as { config?: { command?: string } }
      if (!payload.config?.command?.trim()) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'unsupported', message: 'malformed spawn_agent' }
        })
        return
      }
      if (payload.config.command === '__fail__') {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'not_implemented', message: 'agent failed to start: not found' }
        })
        return
      }
      const agentId = 'agent-spawned-1'
      this.liveAgents.add(agentId)
      this.emitReply({ id: req.id, ok: true, payload: agentId })
      return
    }
    if (req.type === 'list_agents') {
      this.emitReply({ id: req.id, ok: true, payload: [...this.liveAgents] })
      return
    }
    if (req.type === 'kill_agent') {
      const payload = req.payload as { agentId?: string }
      if (!payload.agentId) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'unsupported', message: 'malformed kill_agent' }
        })
        return
      }
      this.liveAgents.delete(payload.agentId)
      this.emitReply({ id: req.id, ok: true, payload: {} })
      return
    }
    this.emitReply({
      id: req.id,
      ok: false,
      err: { code: 'not_implemented', message: `${req.type} stub` }
    })
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  emit(obj: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(obj) }))
  }

  emitReply(obj: unknown): void {
    queueMicrotask(() => this.emit(obj))
  }
}

describe('acp-transport helpers', () => {
  it('resolveWsUrl maps http→ws and https→wss', () => {
    expect(resolveWsUrl({ protocol: 'http:', host: '127.0.0.1:8080' })).toBe(
      'ws://127.0.0.1:8080/ws'
    )
    expect(resolveWsUrl({ protocol: 'https:', host: 'example.com' })).toBe('wss://example.com/ws')
  })

  it('translates acp:* ↔ prefix-dropped event names', () => {
    expect(toWsEventType('acp:message_chunk')).toBe('message_chunk')
    expect(toTauriEventName('message_chunk')).toBe('acp:message_chunk')
  })
})

describe('WsAcpTransport', () => {
  afterEach(() => {
    _resetAcpTransportForTests(null)
  })

  it('spawnAgent / listAgents / killAgent mirror desktop lifecycle over WS', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()

    expect(await transport.listAgents()).toEqual([])

    const agentId = await transport.spawnAgent({
      name: 'test',
      command: 'npx',
      args: ['-y', '@example/agent'],
      env: {},
      allowTerminal: false
    })
    expect(agentId).toBe('agent-spawned-1')
    expect(await transport.listAgents()).toEqual(['agent-spawned-1'])

    await transport.killAgent(agentId)
    expect(await transport.listAgents()).toEqual([])

    await expect(
      transport.spawnAgent({
        name: 'bad',
        command: '__fail__',
        args: [],
        env: {},
        allowTerminal: false
      })
    ).rejects.toBeInstanceOf(AcpTransportError)

    transport.dispose()
  })

  it('switchProject sends a switch_project request with { projectId }', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    // FakeWebSocket replies `not_implemented` for unknown request types — the
    // point here is the request frame shape (type + payload), not the reply.
    await expect(transport.switchProject('p-2')).rejects.toBeInstanceOf(AcpTransportError)

    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string; payload: unknown })
    const switchReq = sent.find((r) => r.type === 'switch_project')
    expect(switchReq).toBeTruthy()
    expect(switchReq?.payload).toEqual({ projectId: 'p-2' })

    transport.dispose()
  })

  it('authenticates on auth_required and correlates request/reply by id', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const reason = await transport.sendPrompt('a1', 's1', 'hello')
    expect(reason).toBe('end_turn')
    transport.dispose()
  })

  it('skips subscribe before sendPrompt when already subscribed', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.subscribeSession('s1')
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const before = sock.sent.filter((s) => JSON.parse(s).type === 'subscribe').length
    await transport.sendPrompt('a1', 's1', 'hello')
    const after = sock.sent.filter((s) => JSON.parse(s).type === 'subscribe').length
    expect(after).toBe(before)
    transport.dispose()
  })

  it('gap-fills contiguous reliable events', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const calls: unknown[] = []
    transport.onEvent('acp:tool_call', (p) => calls.push(p))

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.emit({
      sid: 's1',
      seq: 2,
      type: 'tool_call',
      payload: { n: 2 }
    })
    sock.emit({
      sid: 's1',
      seq: 1,
      type: 'tool_call',
      payload: { n: 1 }
    })
    expect(calls).toEqual([{ n: 1 }, { n: 2 }])
    transport.dispose()
  })

  it('emits lossy events without advancing cursor over a gap', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const chunks: unknown[] = []
    transport.onEvent('acp:message_chunk', (p) => chunks.push(p))

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.emit({
      sid: 's1',
      seq: 2,
      type: 'message_chunk',
      payload: { n: 2 }
    })
    expect(chunks).toEqual([{ n: 2 }])
    const lastSeq = (transport as unknown as { lastSeq: Map<string, number> }).lastSeq
    expect(lastSeq.get('s1')).toBeUndefined()

    sock.emit({
      sid: 's1',
      seq: 1,
      type: 'message_chunk',
      payload: { n: 1 }
    })
    expect(chunks).toEqual([{ n: 2 }, { n: 1 }])
    expect(lastSeq.get('s1')).toBe(1)
    transport.dispose()
  })

  it('on stale subscribe clears buffers and resubscribes live-only', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.subscribeSession('s1', 99)
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const subscribeFrames = sock.sent
      .map((s) => JSON.parse(s) as { type: string; payload: { lastSeq?: number } })
      .filter((f) => f.type === 'subscribe')
    expect(subscribeFrames.length).toBeGreaterThanOrEqual(2)
    const retry = subscribeFrames[subscribeFrames.length - 1]
    expect(retry.payload.lastSeq).toBeUndefined()
    transport.dispose()
  })

  it('rejects pending RPCs when the socket closes', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const pendingMap = (
      transport as unknown as {
        pending: Map<
          string,
          {
            resolve: (v: unknown) => void
            reject: (e: unknown) => void
            timer: ReturnType<typeof setTimeout>
          }
        >
      }
    ).pending
    const hung = new Promise<unknown>((_resolve, reject) => {
      pendingMap.set('hung-rpc', {
        resolve: () => undefined,
        reject,
        timer: setTimeout(() => undefined, 60_000)
      })
    })
    sock.close()
    await expect(hung).rejects.toMatchObject({ code: 'closed' })
    transport.dispose()
  })

  it('fails connect when authenticate is rejected', async () => {
    class AuthFailSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url)
        this.authFail = true
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: AuthFailSocket as unknown as typeof WebSocket
    })
    await expect(transport.connect()).rejects.toBeInstanceOf(AcpTransportError)
    transport.dispose()
  })

  it('dedups prompt_complete by turnId without stalling seq', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const completes: unknown[] = []
    const tools: unknown[] = []
    transport.onEvent('acp:prompt_complete', (p) => completes.push(p))
    transport.onEvent('acp:tool_call', (p) => tools.push(p))
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const lastSeq = (transport as unknown as { lastSeq: Map<string, number> }).lastSeq

    sock.emit({
      sid: 's1',
      seq: 1,
      type: 'prompt_complete',
      payload: { turnId: 't1', stopReason: 'end_turn' }
    })
    sock.emit({
      sid: 's1',
      seq: 1,
      type: 'prompt_complete',
      payload: { turnId: 't1', stopReason: 'end_turn' }
    })
    expect(completes).toHaveLength(1)
    expect(lastSeq.get('s1')).toBe(1)

    sock.emit({
      sid: 's1',
      seq: 2,
      type: 'prompt_complete',
      payload: { turnId: 't1', stopReason: 'end_turn' }
    })
    // Duplicate turn id: not re-emitted, but cursor advances.
    expect(completes).toHaveLength(1)
    expect(lastSeq.get('s1')).toBe(2)

    sock.emit({
      sid: 's1',
      seq: 3,
      type: 'tool_call',
      payload: { n: 3 }
    })
    expect(tools).toEqual([{ n: 3 }])
    expect(lastSeq.get('s1')).toBe(3)
    transport.dispose()
  })

  it('loadSession and resumeSession return the reopen snapshot before subscribing', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    const loaded = await transport.loadSession('a1', 's-load', '/work')
    const resumed = await transport.resumeSession('a1', 's-resume', '/work')

    expect(loaded).toEqual(sock.reopenOutcome)
    expect(resumed).toEqual(sock.reopenOutcome)
    const types = sock.sent.map((frame) => (JSON.parse(frame) as { type: string }).type)
    expect(types).toContain('load_session')
    expect(types).toContain('resume_session')
    expect(types.filter((type) => type === 'subscribe')).toHaveLength(2)
    transport.dispose()
  })

  it('sendPrompt generates + sends a client turnId (Story 1.8 T3.1)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    await transport.sendPrompt('a1', 's1', 'hello')
    // The send_prompt frame's payload MUST include a `turnId` (a uuid) so the
    // server echoes it on prompt_complete → our seenTurnIds dedup fires.
    const frame = JSON.parse(sock.sent.at(-1)!) as {
      type: string
      payload: { agentId: string; sessionId: string; text: string; turnId?: string }
    }
    expect(frame.type).toBe('send_prompt')
    expect(frame.payload.agentId).toBe('a1')
    expect(frame.payload.sessionId).toBe('s1')
    expect(frame.payload.text).toBe('hello')
    expect(frame.payload.turnId).toEqual(expect.any(String))
    expect(frame.payload.turnId!.length).toBeGreaterThan(0)
    transport.dispose()
  })

  it('sendPromptBlocks also sends a client turnId (Story 1.8 T3.1)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    await transport.sendPromptBlocks('a1', 's1', [{ type: 'text', text: 'hi' } as never])
    const frame = JSON.parse(sock.sent.at(-1)!) as {
      type: string
      payload: { content: unknown[]; turnId?: string }
    }
    expect(frame.type).toBe('send_prompt')
    expect(frame.payload.turnId).toEqual(expect.any(String))
    transport.dispose()
  })

  // Story 1.8 AC3: the full chat flow via the mocked WS seam — start a session,
  // stream a turn (message_chunk → prompt_complete), and approve a permission.
  it('streams a turn + dedups a replayed prompt_complete by turnId (AC3 chat flow)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.streamOnSendPrompt = true

    const chunks: unknown[] = []
    const completes: unknown[] = []
    transport.onEvent('acp:message_chunk', (p) => chunks.push(p))
    transport.onEvent('acp:prompt_complete', (p) => completes.push(p))

    // Start a session via the WS seam.
    const outcome = await transport.newSession('a1', '/work')
    expect(outcome.sessionId).toBe('sess-chatflow')

    // Send a prompt — the fake streams message_chunk + prompt_complete.
    const stopReason = await transport.sendPrompt('a1', outcome.sessionId, 'hello')
    expect(stopReason).toBe('end_turn')
    // Both message_chunk events delivered in order.
    expect(chunks).toHaveLength(2)
    expect((chunks[0] as { i: number }).i).toBe(1)
    expect((chunks[1] as { i: number }).i).toBe(2)
    // prompt_complete delivered once.
    expect(completes).toHaveLength(1)

    // Reconnect-style replay: re-emit the same prompt_complete (same turnId) —
    // the transport's seenTurnIds dedup drops it (no second delivery).
    const replayed = (
      await new Promise<{ turnId?: string }>((resolve) => {
        const sentFrame = sock.sent.find((s) => JSON.parse(s).type === 'send_prompt')
        const turnId = sentFrame ? (JSON.parse(sentFrame).payload.turnId as string) : undefined
        resolve({ turnId })
      })
    ).turnId
    sock.emit({
      sid: outcome.sessionId,
      seq: 4,
      type: 'prompt_complete',
      payload: { stopReason: 'end_turn', turnId: replayed }
    })
    expect(completes).toHaveLength(1) // deduped — no duplicate completion
    transport.dispose()
  })

  // Story 1.8 AC3: approve a permission via the WS seam — the browser sends
  // `respond_permission` and the transport resolves on `ok`.
  it('approves a permission over the WS seam (AC3 permission flow)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    // A permission_request arrives from the server mid-turn.
    const permEvents: unknown[] = []
    transport.onEvent('acp:permission_request', (p) => permEvents.push(p))
    sock.emit({
      sid: 'sess-perm',
      seq: 1,
      type: 'permission_request',
      payload: {
        agentId: 'a1',
        sessionId: 'sess-perm',
        requestId: 'perm-1',
        options: [{ optionId: 'allow' }]
      }
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(permEvents).toHaveLength(1)
    // The browser approves → `respond_permission` request with optionId.
    // The fake defaults to `not_implemented`; override to `ok` for this test.
    sock.respondPermissionErr = null
    // Monkeypatch the fake's respond_permission handler inline to reply ok.
    const origSend = sock.send.bind(sock)
    sock.send = (data: string) => {
      const req = JSON.parse(data) as { id: string; type: string }
      if (req.type === 'respond_permission') {
        sock.emitReply({ id: req.id, ok: true, payload: {} })
        sock.send = origSend // restore
        return
      }
      origSend(data)
    }
    await expect(transport.respondPermission('a1', 'perm-1', 'allow')).resolves.toBeUndefined()
    transport.dispose()
  })

  it('throws AcpTransportError with code from WS err', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await expect(transport.setMode('a1', 's1', 'm')).rejects.toBeInstanceOf(AcpTransportError)
    transport.dispose()
  })

  it('maps respond_permission stale/duplicate replies to AcpTransportError.code (Story 1.7 T8.3)', async () => {
    for (const code of ['stale', 'duplicate', 'permission_denied'] as const) {
      const transport = new WsAcpTransport({
        url: 'ws://test/ws',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
      })
      await transport.connect()
      const live = (transport as unknown as { socket: FakeWebSocket }).socket
      live.respondPermissionErr = { code, message: `${code} from rendezvous` }
      await expect(transport.respondPermission('a1', 'perm-1', 'allow')).rejects.toMatchObject({
        code,
        message: expect.any(String)
      })
      await expect(transport.respondPermission('a1', 'perm-1', 'allow')).rejects.toBeInstanceOf(
        AcpTransportError
      )
      transport.dispose()
    }
  })

  it('_setAcpTransportForTests disposes the previous singleton', () => {
    const first = { dispose: vi.fn() }
    const second = { dispose: vi.fn() }
    _setAcpTransportForTests(first as never)
    _setAcpTransportForTests(second as never)
    expect(first.dispose).toHaveBeenCalledOnce()
    _resetAcpTransportForTests(null)
    expect(second.dispose).toHaveBeenCalledOnce()
  })

  it('keeps send_prompt pending past the 60s default (matches server turn budget)', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.holdSendPrompt = true

    const pending = transport.sendPrompt('a1', 's1', 'long turn')
    let settled: unknown
    void pending.then(
      (v) => {
        settled = { ok: v }
      },
      (err) => {
        settled = { err }
      }
    )

    // Still well under the 10-minute turn budget — must not time out at 60s.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(540_000) // total 600s — server turn budget elapsed
    // Client budget = server budget + grace, so the generic timeout must NOT
    // fire yet (the server's typed `turn timeout` reply should win the race).
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(10_000) // total 610s — client grace fires
    await Promise.resolve()
    expect(settled).toMatchObject({
      err: expect.objectContaining({
        name: 'AcpTransportError',
        code: 'timeout',
        message: 'Request send_prompt timed out'
      })
    })
    transport.dispose()
    vi.useRealTimers()
  })

  it('still times out quick commands at 60s', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const origSend = sock.send.bind(sock)
    sock.send = (data: string) => {
      const req = JSON.parse(data) as { type: string }
      if (req.type === 'set_mode') return // hold — no reply
      origSend(data)
    }

    try {
      const pending = transport.setMode('a1', 's1', 'agent')
      let settled: unknown
      void pending.then(
        (v) => {
          settled = { ok: v }
        },
        (err) => {
          settled = { err }
        }
      )

      await vi.advanceTimersByTimeAsync(59_999)
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(settled).toMatchObject({
        err: expect.objectContaining({
          code: 'timeout',
          message: 'Request set_mode timed out'
        })
      })
    } finally {
      sock.send = origSend // restore the monkeypatched socket method
    }
    transport.dispose()
    vi.useRealTimers()
  })
})

// Story 5.3 (AC3, T6) — transport-level reconnect listener.
// Verifies the `setReconnectListener` callback fires `true` on
// `scheduleReconnect` (WS drop) and `false` on `reconnect` success.
describe('WsAcpTransport reconnect listener (Story 5.3)', () => {
  afterEach(() => {
    _resetAcpTransportForTests(null)
  })

  it('fires onReconnectStateChange(true) when the socket closes (drop detected)', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const states: boolean[] = []
    transport.setReconnectListener((reconnecting) => states.push(reconnecting))

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.close()

    // `scheduleReconnect` runs synchronously inside `ws.onclose` — the
    // listener should fire `true` immediately.
    expect(states).toContain(true)

    // Cleanup: clear the reconnect timer so it doesn't fire after the test.
    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
    vi.useRealTimers()
  })

  it('fires onReconnectStateChange(false) after a successful reconnect', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const states: boolean[] = []
    transport.setReconnectListener((reconnecting) => states.push(reconnecting))

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.close()
    // Drop detected → true
    expect(states[0]).toBe(true)

    // Advance past the reconnect backoff (RECONNECT_BASE_MS=500, first
    // attempt: 500ms). The `reconnect()` method re-opens the socket and
    // re-subscribes sessions; on success it fires `false`.
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve() // flush microtasks (reconnect's await chain)

    // Reconnect succeeded → false fired. The FakeWebSocket auto-opens on
    // construction, so `connect()` resolves immediately.
    expect(states).toContain(false)
    expect(states[states.length - 1]).toBe(false)

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
    vi.useRealTimers()
  })

  it('does not fire the listener on the initial connect()', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    const states: boolean[] = []
    transport.setReconnectListener((reconnecting) => states.push(reconnecting))
    await transport.connect()
    // Initial connect must NOT fire the listener — only reconnect transitions.
    expect(states).toEqual([])
    transport.dispose()
  })
})

describe('createAcpTransport selection', () => {
  beforeEach(() => {
    _resetAcpTransportForTests(null)
  })

  it('desktop load/resume return the typed Tauri invoke outcome', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const outcome = { configOptions: [] }
    vi.mocked(invoke).mockResolvedValue(outcome)
    const transport = createAcpTransport({ force: 'tauri' })

    await expect(transport.loadSession('a1', 's1', '/work')).resolves.toEqual(outcome)
    expect(invoke).toHaveBeenCalledWith('acp_load_session', {
      agentId: 'a1',
      sessionId: 's1',
      cwd: '/work'
    })
    await expect(transport.resumeSession('a1', 's1', '/work')).resolves.toEqual(outcome)
    expect(invoke).toHaveBeenCalledWith('acp_resume_session', {
      agentId: 'a1',
      sessionId: 's1',
      cwd: '/work'
    })
    transport.dispose()
  })

  it('accepts an injected transport via test helper', async () => {
    const mock = {
      installRegistryBinary: vi.fn(),
      probeRuntime: vi.fn().mockResolvedValue({ npx: true, uvx: true }),
      fetchRegistrySnapshot: vi.fn(),
      spawnAgent: vi.fn(),
      killAgent: vi.fn(),
      listAgents: vi.fn(),
      newSession: vi.fn(),
      loadSession: vi.fn(),
      resumeSession: vi.fn(),
      closeSession: vi.fn(),
      listSessions: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue('end_turn'),
      sendPromptBlocks: vi.fn(),
      cancelPrompt: vi.fn(),
      setConfigOption: vi.fn(),
      setMode: vi.fn(),
      setModel: vi.fn(),
      respondPermission: vi.fn(),
      authenticate: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      connect: vi.fn(),
      dispose: vi.fn()
    }
    _setAcpTransportForTests(mock as never)
    const { getAcpTransport } = await import('./acp-transport')
    expect(getAcpTransport()).toBe(mock)
  })
})

describe('Biome @tauri-apps ban (AC8)', () => {
  it('restricts @tauri-apps imports outside renderer/lib', () => {
    const biomePath = resolve(process.cwd(), 'biome.json')
    const biome = JSON.parse(readFileSync(biomePath, 'utf8')) as {
      linter: {
        rules: {
          style: { noRestrictedImports: { level: string; options: { patterns: unknown[] } } }
        }
      }
      overrides?: Array<{ includes?: string[]; linter?: { rules?: Record<string, unknown> } }>
    }
    expect(biome.linter.rules.style.noRestrictedImports.level).toBe('error')
    const patterns = JSON.stringify(biome.linter.rules.style.noRestrictedImports.options.patterns)
    expect(patterns).toContain('@tauri-apps')
    const libOverride = biome.overrides?.find((o) =>
      o.includes?.some((i) => i.includes('renderer/lib'))
    )
    expect(libOverride).toBeTruthy()
  })
})
