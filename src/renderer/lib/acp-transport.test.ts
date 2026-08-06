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
  switchProjectReply: unknown = null
  /** CAP-6 / Story 8: when set, `list_acp_catalog` replies with this catalog
   * payload; unset → falls through to the `not_implemented` fallback (so
   * `probeRuntime`/`fetchRegistrySnapshot` degrade gracefully). */
  catalogReply: unknown = null
  historyMode: 'server' | 'live_only' = 'server'
  runtimePolicy = {
    turnTimeoutMs: 3_600_000,
    promptInactivityTimeoutMs: 3_600_000,
    permissionReconnectGraceMs: 15_000,
    pingIntervalMs: 20_000,
    pongTimeoutMs: 75_000
  }
  snapshotEvents: unknown[] = []
  /** Session payloads served by `get_session_payload`; unknown ids → not_found. */
  sessionPayloads: Record<string, unknown> = {}
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
      this.emitReply({
        id: req.id,
        ok: true,
        payload: { historyMode: this.historyMode, runtimePolicy: this.runtimePolicy }
      })
      return
    }
    if (req.type === 'ping') {
      // Heartbeat handler: round-trip an ok reply so the client's request
      // promise resolves (a healthy ping resets the failure counter).
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
    if (req.type === 'recover_session_snapshot') {
      const payload = req.payload as { sessionId: string }
      this.emitReply({
        id: req.id,
        ok: true,
        payload: { sessionId: payload.sessionId, watermark: 42, events: this.snapshotEvents }
      })
      return
    }
    if (req.type === 'switch_project' && this.switchProjectReply) {
      this.emitReply({ id: req.id, ok: true, payload: this.switchProjectReply })
      return
    }
    // CAP-6 / Story 8: the WS transport resolves the ACP catalog through
    // `list_acp_catalog` (the host's OS/arch/runtime + per-agent status). When
    // `catalogReply` is set, reply with it; otherwise fall through to the
    // `not_implemented` stub so `probeRuntime`/`fetchRegistrySnapshot` degrade.
    if (req.type === 'list_acp_catalog' && this.catalogReply) {
      this.emitReply({ id: req.id, ok: true, payload: this.catalogReply })
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
    if (req.type === 'dispose_ephemeral_session') {
      this.emitReply({ id: req.id, ok: true, payload: {} })
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
      // CAP-4: the spawn response carries the full authoritative metadata
      // (capabilities + authMethods + stableNamespace), not just the agentId.
      this.emitReply({
        id: req.id,
        ok: true,
        payload: {
          agentId,
          capabilities: { loadSession: true },
          authMethods: [],
          stableNamespace: 'config:test'
        }
      })
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
    if (req.type === 'get_session_payload') {
      // Standalone history: serve the registered renderer-shaped payload, or
      // the server's `not_found` reply for absent ids.
      const payload = req.payload as { sessionId?: string }
      const stored = payload.sessionId ? this.sessionPayloads[payload.sessionId] : undefined
      if (stored) {
        this.emitReply({ id: req.id, ok: true, payload: stored })
      } else {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'not_found', message: 'session payload not found' }
        })
      }
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

    const spawnResult = await transport.spawnAgent({
      name: 'test',
      command: 'npx',
      args: ['-y', '@example/agent'],
      env: {},
      allowTerminal: false
    })
    // CAP-4: the WS spawn response carries the full authoritative payload
    // (agentId + capabilities + authMethods + stableNamespace), matching the
    // desktop Tauri command's return type — one contract for both transports.
    expect(spawnResult.agentId).toBe('agent-spawned-1')
    expect(spawnResult.capabilities).toEqual({ loadSession: true })
    expect(spawnResult.authMethods).toEqual([])
    expect(spawnResult.stableNamespace).toBe('config:test')
    expect(await transport.listAgents()).toEqual(['agent-spawned-1'])

    await transport.killAgent(spawnResult.agentId)
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

  // CAP-6 / Story 8: the fake `probeRuntime`/`fetchRegistrySnapshot` stubs
  // (hardcoded `{npx:true,uvx:true}` / `{agents:[]}`) are replaced by a real
  // `list_acp_catalog` WS request — the host probes npx/uvx/node/bun/python3
  // and returns the resolved catalog. These tests pin the request shape + the
  // reply mapping + the graceful degradation when the host is unavailable.
  it('probeRuntime sends list_acp_catalog and maps host.runtimes', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.catalogReply = {
      host: {
        os: 'linux',
        arch: 'x86_64',
        runtimes: { npx: true, uvx: false, node: true, bun: false, python3: true }
      },
      agents: []
    }

    const runtime = await transport.probeRuntime()
    expect(runtime).toEqual({ npx: true, uvx: false })

    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string; payload: unknown })
    expect(sent.some((r) => r.type === 'list_acp_catalog')).toBe(true)
    transport.dispose()
  })

  it('fetchRegistrySnapshot sends list_acp_catalog and maps agents', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.catalogReply = {
      host: { os: 'linux', arch: 'x86_64', runtimes: {} },
      agents: [{ id: 'a', name: 'A', source: 'bundled', distribution: {} }]
    }

    const snapshot = await transport.fetchRegistrySnapshot()
    expect(snapshot.agents).toHaveLength(1)
    expect(snapshot.source).toBe('network')

    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string })
    expect(sent.some((r) => r.type === 'list_acp_catalog')).toBe(true)
    transport.dispose()
  })

  it('probeRuntime degrades to no-runtimes when the catalog is unavailable', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    // catalogReply unset → `list_acp_catalog` hits the not_implemented fallback;
    // the transport catches and degrades gracefully.
    const runtime = await transport.probeRuntime()
    expect(runtime).toEqual({ npx: false, uvx: false })
    transport.dispose()
  })

  it('switchProject maps completed replies and subscribes the new session', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    sock.switchProjectReply = {
      status: 'completed',
      projectId: 'p-2',
      sessionId: 's-new',
      cwd: '/work/p2',
      mcpServerCount: 2
    }
    await expect(transport.switchProject('p-2')).resolves.toEqual(sock.switchProjectReply)

    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string; payload: unknown })
    const switchReq = sent.find((r) => r.type === 'switch_project')
    expect(switchReq).toBeTruthy()
    expect(switchReq?.payload).toEqual({ projectId: 'p-2' })
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'subscribe', payload: { sessionId: 's-new' } })
    )

    transport.dispose()
  })

  it('switchProject passes through selected (cold-tab) replies without subscribing', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    sock.switchProjectReply = {
      status: 'selected',
      projectId: 'p-2',
      cwd: '/work/p2'
    }
    await expect(transport.switchProject('p-2')).resolves.toEqual(sock.switchProjectReply)

    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string; payload: unknown })
    const switchReq = sent.find((r) => r.type === 'switch_project')
    expect(switchReq).toBeTruthy()
    expect(switchReq?.payload).toEqual({ projectId: 'p-2' })
    // Cold tab: no session, so the client must NOT subscribe early.
    expect(sent).not.toContainEqual(expect.objectContaining({ type: 'subscribe' }))

    transport.dispose()
  })

  it('switchProject maps queued replies without subscribing early', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.switchProjectReply = {
      status: 'queued',
      projectId: 'p-2',
      currentSessionId: 's-old'
    }

    await expect(transport.switchProject('p-2')).resolves.toEqual(sock.switchProjectReply)
    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string; payload: unknown })
    expect(sent.filter((frame) => frame.type === 'subscribe')).toHaveLength(0)
    transport.dispose()
  })

  it('subscribes before emitting queued project switch completion', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const completed: unknown[] = []
    transport.onEvent('project_switch_completed', (payload) => completed.push(payload))
    const payload = {
      status: 'completed',
      requestId: 'r-switch',
      projectId: 'p-2',
      previousSessionId: 's-old',
      sessionId: 's-new',
      cwd: '/work/p2',
      mcpServerCount: 1
    }

    sock.emit({ sid: 's-old', seq: 0, type: 'project_switch_completed', payload })
    await vi.waitFor(() => expect(completed).toEqual([payload]))
    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string; payload: unknown })
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'subscribe', payload: { sessionId: 's-new' } })
    )
    transport.dispose()
  })

  it('delivers correlated queued project switch failure without subscribing', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const failed: unknown[] = []
    transport.onEvent('project_switch_failed', (payload) => failed.push(payload))
    const payload = {
      requestId: 'r-switch',
      projectId: 'p-2',
      previousSessionId: 's-old',
      message: 'target project became unavailable before commit'
    }

    sock.emit({ sid: 's-old', seq: 0, type: 'project_switch_failed', payload })
    await vi.waitFor(() => expect(failed).toEqual([payload]))
    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string })
    expect(sent.filter((frame) => frame.type === 'subscribe')).toHaveLength(0)
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

  it('forwards a caller-supplied turnId on send_prompt (no fresh mint)', async () => {
    // The store mints the turn-id and passes it through so the optimistic
    // user message can share the same `turn:<turnId>` id as the server echo.
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    await transport.sendPrompt('a1', 's1', 'hello', 'my-turn-id')
    const sendPromptFrame = sock.sent
      .map((s) => JSON.parse(s) as { type: string; payload?: { turnId?: string } })
      .find((f) => f.type === 'send_prompt')
    expect(sendPromptFrame?.payload?.turnId).toBe('my-turn-id')
    transport.dispose()
  })

  it('sends a ping heartbeat on the interval to refresh the server watchdog', async () => {
    // Proxies that strip WS-level Ping/Pong (Cloudflare tunnels) let the
    // server's ~75s watchdog false-positive drop a focused tab; a periodic
    // `ping` text request refreshes `last_activity` through any proxy.
    vi.useFakeTimers()
    try {
      const transport = new WsAcpTransport({
        url: 'ws://test/ws',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
      })
      await transport.connect()
      const sock = (transport as unknown as { socket: FakeWebSocket }).socket
      const pingsBefore = sock.sent.filter((s) => JSON.parse(s).type === 'ping').length
      // HEARTBEAT_INTERVAL_MS = 30s; advance past one tick.
      await vi.advanceTimersByTimeAsync(31_000)
      const pingsAfter = sock.sent.filter((s) => JSON.parse(s).type === 'ping').length
      expect(pingsAfter).toBeGreaterThan(pingsBefore)
      expect(pingsAfter).toBeGreaterThanOrEqual(1)
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers reliable events on arrival across a seq gap (no reorder-recovery)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const calls: unknown[] = []
    transport.onEvent('acp:tool_call', (p) => calls.push(p))

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const lastSeq = (transport as unknown as { lastSeq: Map<string, number> }).lastSeq
    // seq 1 (session_created) was emitted before the client subscribed, so the
    // cursor stays 0 — a permanent gap. A reliable tool_call at seq 3 lands in
    // the gap: deliver immediately (not held behind the unfillable hole) and
    // advance the cursor to 3.
    sock.emit({ sid: 's1', seq: 3, type: 'tool_call', payload: { n: 3 } })
    expect(calls).toEqual([{ n: 3 }])
    expect(lastSeq.get('s1')).toBe(3)
    // A subsequent contiguous event (seq 4) flows without duplication.
    sock.emit({ sid: 's1', seq: 4, type: 'tool_call', payload: { n: 4 } })
    expect(calls).toEqual([{ n: 3 }, { n: 4 }])
    expect(lastSeq.get('s1')).toBe(4)
    transport.dispose()
  })

  it('delivers lossy events in a gap and advances the cursor', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const chunks: unknown[] = []
    transport.onEvent('acp:message_chunk', (p) => chunks.push(p))

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const lastSeq = (transport as unknown as { lastSeq: Map<string, number> }).lastSeq
    // seq 1 was missed; a lossy message_chunk at seq 2 lands in a gap: it is
    // delivered (lossy events still render) AND the cursor advances to 2.
    sock.emit({ sid: 's1', seq: 2, type: 'message_chunk', payload: { n: 2 } })
    expect(chunks).toEqual([{ n: 2 }])
    expect(lastSeq.get('s1')).toBe(2)
    // A reordered-earlier seq cannot arrive on a single FIFO WebSocket, but if
    // one did it is dropped as `seq <= last` — the cursor never regresses.
    // Documents the intentional removal of reorder-recovery (see spec Design Notes).
    sock.emit({ sid: 's1', seq: 1, type: 'message_chunk', payload: { n: 1 } })
    expect(chunks).toEqual([{ n: 2 }])
    expect(lastSeq.get('s1')).toBe(2)
    transport.dispose()
  })

  it('drops reconnect-replay duplicates (seq <= lastSeq)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const calls: unknown[] = []
    transport.onEvent('acp:tool_call', (p) => calls.push(p))

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    // Live delivery at seq 3 (seq 1 was missed) advances the cursor to 3.
    sock.emit({ sid: 's1', seq: 3, type: 'tool_call', payload: { n: 3 } })
    expect(calls).toEqual([{ n: 3 }])
    // A reconnect replay re-emits the same seq (or a lower one already passed) —
    // the transport drops it as `seq <= last`, never re-delivering.
    sock.emit({ sid: 's1', seq: 3, type: 'tool_call', payload: { n: 3 } })
    sock.emit({ sid: 's1', seq: 2, type: 'tool_call', payload: { n: 2 } })
    expect(calls).toEqual([{ n: 3 }])
    transport.dispose()
  })

  it('on stale subscribe installs an atomic server-history snapshot', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    const recoveries: unknown[] = []
    transport.setRecoveryHandler(async (recovery) => {
      recoveries.push(recovery)
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.snapshotEvents = [
      { sid: 's1', seq: 42, type: 'message_chunk', payload: { content: { text: 'snapshot' } } }
    ]

    await transport.subscribeSession('s1', 99)

    expect(recoveries).toEqual([{ sessionId: 's1', watermark: 42, events: sock.snapshotEvents }])
    expect(transport.getSessionCursor('s1')).toBe(42)
    const types = sock.sent.map((frame) => (JSON.parse(frame) as { type: string }).type)
    expect(types).toContain('recover_session_snapshot')
    transport.dispose()
  })

  it('reports degraded recovery in live-only mode instead of silent success', async () => {
    class LiveOnlySocket extends FakeWebSocket {
      constructor(url: string) {
        super(url)
        this.historyMode = 'live_only'
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: LiveOnlySocket as unknown as typeof WebSocket
    })
    const recoveries: unknown[] = []
    transport.setRecoveryHandler(async (recovery) => recoveries.push(recovery))
    await transport.connect()
    await transport.subscribeSession('s1', 99)
    expect(recoveries).toEqual([{ sessionId: 's1', degraded: true }])
    transport.dispose()
  })

  it('getSessionPayload passes through the materialized SessionPayload', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    // The standalone host materializes this renderer-shaped payload from its
    // durable JSONL records (user bubble + agent run, deterministic ids/seqs).
    const stored = {
      metadata: {
        id: 's-1',
        agentId: 'runtime-1',
        agentConfigId: 'claude',
        title: 'Chat title',
        cwd: '/work/project',
        projectId: 'project-1',
        createdAt: 100,
        lastActivityAt: 900,
        messageCount: 2,
        lastSeq: 5,
        status: 'active'
      },
      messages: [
        {
          id: 'turn:turn-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          streaming: false,
          timestamp: 101,
          seq: 1
        },
        {
          id: 'snapshot:agent:2',
          role: 'agent',
          blocks: [{ type: 'text', text: 'world' }],
          streaming: false,
          timestamp: 102,
          seq: 2
        }
      ]
    }
    sock.sessionPayloads['s-1'] = stored

    await expect(transport.getSessionPayload('s-1')).resolves.toEqual(stored)
    const sent = sock.sent.map((frame) => JSON.parse(frame) as { type: string; payload: unknown })
    const request = sent.find((frame) => frame.type === 'get_session_payload')
    expect(request?.payload).toEqual({ sessionId: 's-1' })
    transport.dispose()
  })

  it('getSessionPayload maps not_found to null (chat unavailable)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()

    await expect(transport.getSessionPayload('missing')).resolves.toBeNull()
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
            type: 'ping'
          }
        >
      }
    ).pending
    const hung = new Promise<unknown>((_resolve, reject) => {
      pendingMap.set('hung-rpc', {
        resolve: () => undefined,
        reject,
        timer: setTimeout(() => undefined, 60_000),
        type: 'ping'
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

  it('loadSession and resumeSession force subscriptions with explicit replay boundaries', async () => {
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
    const subscriptions = sock.sent
      .map((frame) => JSON.parse(frame) as { type: string; payload: { lastSeq?: number } })
      .filter((frame) => frame.type === 'subscribe')
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions.every((frame) => frame.payload.lastSeq === 0)).toBe(true)
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

  it('forwards ephemeral creation and disposal over WS', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    await transport.newSession('a1', '/work', undefined, { ephemeral: true })
    await transport.disposeEphemeralSession('a1', 'sess-chatflow')

    const frames = sock.sent.map((raw) => JSON.parse(raw) as { type: string; payload: unknown })
    expect(frames).toContainEqual({
      id: expect.any(String),
      type: 'create_session',
      payload: { agentId: 'a1', cwd: '/work', ephemeral: true }
    })
    expect(frames).toContainEqual({
      id: expect.any(String),
      type: 'dispose_ephemeral_session',
      payload: { agentId: 'a1', sessionId: 'sess-chatflow' }
    })
    expect(frames.some((frame) => frame.type === 'subscribe')).toBe(false)
    expect(transport.getSessionCursor('sess-chatflow')).toBeNull()
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

  it('keeps send_prompt pending past the former 610s deadline and uses negotiated policy', async () => {
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

    await vi.advanceTimersByTimeAsync(550_000) // total 610s — former client deadline
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(2_999_999) // total 3,609,999ms
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1) // negotiated 3600s inactivity + 10s grace
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

  it('refreshes send_prompt inactivity only for matching-session sequenced events', async () => {
    vi.useFakeTimers()
    class ShortInactivitySocket extends FakeWebSocket {
      constructor(url: string) {
        super(url)
        this.runtimePolicy = {
          ...this.runtimePolicy,
          promptInactivityTimeoutMs: 1_000
        }
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: ShortInactivitySocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: ShortInactivitySocket }).socket
    sock.holdSendPrompt = true

    const pending = transport.sendPrompt('a1', 's1', 'long turn')
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(900)
    sock.emit({ sid: 'other', seq: 1, type: 'message_chunk', payload: {} })
    await vi.advanceTimersByTimeAsync(200)
    expect(settled).toBe(false)
    sock.emit({ sid: 's1', seq: 1, type: 'message_chunk', payload: {} })
    await vi.advanceTimersByTimeAsync(900)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10_200)
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
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

// Web/remote ACP session persistence across mobile idle/background: a
// visibility/focus-triggered proactive reconnect so the existing cursor-replay
// machinery actually engages when a backgrounded mobile tab returns to the
// foreground (the browser delivers `onclose` late or never after suspension,
// leaving a half-open socket the client trusts and never re-establishes).
type TransportInternals = {
  socket: FakeWebSocket
  lastHiddenAt: number | null
  visibilityHandler: (() => void) | null
  focusHandler: (() => void) | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  lastSeq: Map<string, number>
  subscribed: Set<string>
}

/** Override `document.visibilityState` + dispatch `visibilitychange` (jsdom's
 * default is not reliable for the hidden/visible transitions under test). */
function dispatchVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Restore an own `visibilityState = 'visible'` so later suites read visible. */
function restoreVisibility(): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible'
  })
}

/** Find the LAST sent request frame of a given type on a FakeWebSocket. */
function findSentRequest(
  sock: FakeWebSocket,
  type: string
): { id: string; type: string; payload: Record<string, unknown> } | undefined {
  for (const raw of [...sock.sent].reverse()) {
    const parsed = JSON.parse(raw) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    if (parsed.type === type) return parsed
  }
  return undefined
}

describe('WsAcpTransport visibility-triggered reconnect (web idle persist)', () => {
  afterEach(() => {
    restoreVisibility()
    _resetAcpTransportForTests(null)
    vi.useRealTimers()
  })

  it('reconnects + re-subscribes with cursor after a long hide (> threshold)', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const states: boolean[] = []
    transport.setReconnectListener((r) => states.push(r))
    // Subscribe + deliver one sequenced event so the cursor (`lastSeq`) is set.
    await transport.subscribeSession('sess-A')
    const internals = transport as unknown as TransportInternals
    const oldSocket = internals.socket
    oldSocket.emit({
      sid: 'sess-A',
      seq: 1,
      type: 'message_chunk',
      payload: { role: 'agent', content: { text: 'hi' } }
    })
    await Promise.resolve() // flush onMessage
    expect(internals.lastSeq.get('sess-A')).toBe(1)

    // Long hide (> 30s threshold) → return → proactive reconnect.
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    // forceReconnect → scheduleReconnect fires `true` immediately.
    expect(states[0]).toBe(true)

    // Advance past the 500ms backoff → reconnect re-opens + re-subscribes.
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()

    expect(internals.socket).not.toBe(oldSocket) // new socket opened
    expect(states[states.length - 1]).toBe(false) // overlay cleared
    const sub = findSentRequest(internals.socket, 'subscribe')
    expect(sub).toBeDefined()
    expect(sub?.payload.sessionId).toBe('sess-A')
    expect(sub?.payload.lastSeq).toBe(1) // cursor carried → gap replay path

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
  })

  it('does NOT reconnect after a brief hide (< threshold) with a healthy OPEN socket', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const states: boolean[] = []
    transport.setReconnectListener((r) => states.push(r))
    await transport.subscribeSession('sess-A')
    const internals = transport as unknown as TransportInternals
    const socketBefore = internals.socket

    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5_000) // well under the 30s threshold
    dispatchVisibility('visible')
    await Promise.resolve()

    expect(states).toEqual([]) // no reconnect transition
    expect(internals.socket).toBe(socketBefore) // same socket, not torn down
    expect(internals.lastHiddenAt).toBeNull() // consumed

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
  })

  it('force-reconnects a half-open (still-OPEN) socket on return, detaching old handlers', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const states: boolean[] = []
    transport.setReconnectListener((r) => states.push(r))
    await transport.subscribeSession('sess-A')
    const internals = transport as unknown as TransportInternals
    const oldSocket = internals.socket
    // The socket is OPEN (half-open: server gave up, client doesn't know yet).
    expect(oldSocket.readyState).toBe(FakeWebSocket.OPEN)

    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    expect(states[0]).toBe(true)

    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()

    // The still-OPEN socket was forcibly torn down despite `readyState === OPEN`
    // (the connect() short-circuit must NOT have engaged) and replaced.
    expect(internals.socket).not.toBe(oldSocket)
    expect(oldSocket.readyState).toBe(FakeWebSocket.CLOSED) // forceReconnect closed it
    expect(oldSocket.onclose).toBeNull() // handlers detached → no double fire
    expect(states.filter((s) => s)).toHaveLength(1) // exactly one `true`
    expect(states.filter((s) => !s)).toHaveLength(1) // exactly one `false`

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
  })

  it('coalesces: a `focus` following `visibilitychange` does not double-reconnect', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const states: boolean[] = []
    transport.setReconnectListener((r) => states.push(r))
    await transport.subscribeSession('sess-A')

    // Long hide → visible triggers forceReconnect (consumes lastHiddenAt).
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    expect(states[0]).toBe(true)

    // A `focus` right after (the fallback path) must NOT trigger a 2nd reconnect
    // — lastHiddenAt was consumed. Dispatched on `window` (focus is a
    // window-level event that does not bubble to `document`).
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(states.filter((s) => s)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()
    expect(states.filter((s) => !s)).toHaveLength(1) // one reconnect, one `false`

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
  })

  it('dispose() detaches the visibility/focus listeners', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const internals = transport as unknown as TransportInternals
    expect(internals.visibilityHandler).not.toBeNull()
    expect(internals.focusHandler).not.toBeNull()

    transport.dispose()
    expect(internals.visibilityHandler).toBeNull()
    expect(internals.focusHandler).toBeNull()
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
      installAcpAgent: vi.fn(),
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
