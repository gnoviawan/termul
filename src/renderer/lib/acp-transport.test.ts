import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gateStatusRef = vi.hoisted(() => ({ current: 'ok' as string }))
vi.mock('@/lib/web-auth-gate', () => ({
  flagWebAuthUnauthorized: vi.fn(),
  getWebAuthGateState: () => ({ status: gateStatusRef.current, submitting: false })
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))
const protocolReloadRef = vi.hoisted(() => ({
  handle: vi.fn(),
  clear: vi.fn()
}))
vi.mock('@/lib/web-protocol-reload', () => ({
  handleProtocolVersionMismatch: protocolReloadRef.handle,
  clearProtocolMismatchLatch: protocolReloadRef.clear
}))

// Static import of the globally mocked (vitest.setup.ts) Tauri IPC surface —
// the desktop-path tests assert the exact command names + payloads.
import { MAX_CLIENT_ID_LEN, WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import { invoke } from '@tauri-apps/api/core'
import { logFrontendError } from '@/lib/log-api'
import { flagWebAuthUnauthorized } from '@/lib/web-auth-gate'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  AcpTransportError,
  createAcpTransport,
  isTransientAcpTransportError,
  resolveWsUrl,
  toTauriEventName,
  toWsEventType,
  WsAcpTransport
} from './acp-transport'
import { classifySetupError } from './agents/acp-spawn-errors'

// Reconnect backoff carries ±25 % jitter; pin it to the neutral factor so the
// nominal 500ms/1s/2s delays are exact. Jitter bounds have their own cases.
beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.mocked(Math.random).mockRestore()
})

/**
 * Host-side handshake validation mirroring the Rust `/ws` `authenticate` arm:
 * version first, then identity. Returns the `err.code` or null when valid.
 */
function validateHandshake(payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>
  if (p.protocolVersion !== WS_PROTOCOL_VERSION) return 'protocol_version_mismatch'
  for (const key of ['deviceId', 'clientInstanceId']) {
    const value = p[key]
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      new TextEncoder().encode(value).length > MAX_CLIENT_ID_LEN
    ) {
      return 'invalid_client_identity'
    }
  }
  return null
}

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static autoOpen = true
  /** projectId → err.code the host answers `watch_project` with (all sockets). */
  static watchProjectRefusals: Record<string, string> = {}

  readyState = FakeWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  sent: string[] = []
  authFail = false
  /** When set, `authenticate` is refused with this `err.code` (AD-15). */
  authRefusalCode: string | null = null
  /** When set, `respond_permission` replies with this err (default: not_implemented). */
  respondPermissionErr: { code: string; message: string } | null = null
  /** When set, `authenticate_agent` replies with this err (default: ok). */
  authenticateAgentErr: { code: string; message: string } | null = null
  /** When set, `acp_deliver_auth_redirect` replies with this payload/err.
   * `null` → default ok `{ status: 200 }`. */
  deliverAuthRedirectReply: {
    ok: boolean
    payload?: unknown
    err?: { code: string; message: string }
  } | null = null
  /** When set, `create_session` replies with this err (default: ok chat-flow stub). */
  createSessionErr: { code: string; message: string } | null = null
  setConfigOptionReply: unknown = []
  /** When true, `send_prompt` emits streaming message_chunk + prompt_complete
   * events (echoing the client turnId) — used by the AC3 chat-flow test. */
  streamOnSendPrompt = false
  /** When true, do not auto-reply to `send_prompt` (for timeout tests). */
  holdSendPrompt = false
  /** When true, application pings remain unanswered (stale OPEN socket). */
  holdPing = false
  /** When true, `subscribe` requests stay unanswered (stale OPEN socket). */
  holdSubscribe = false
  /** Session ids whose subscribe request fails. */
  failSubscribeSessions = new Set<string>()
  /** Per-session subscribe failures used to distinguish transient/permanent recovery. */
  subscribeFailureCodes = new Map<string, string>()
  /** Static: per-session TRANSIENT subscribe failure codes applied only to
   * the NEXT constructed socket (a reconnect creates a fresh socket — this
   * lets a test make the reconnect attempt's resubscribe fail). */
  static transientSubscribeFailuresOnNextSocket: Record<string, string> = {}
  /** Live agent summaries for spawn_agent / list_agents / kill_agent stubs
   * (CAP-11: `list_agents` replies with identity-rich summary objects). */
  liveAgents = new Map<
    string,
    { id: string; name: string; configId?: string; namespace?: string; capabilities: unknown }
  >()
  /** Session ids deleted through the `delete_session` stub (CAP-11). */
  deletedSessions: string[] = []
  /** CAP-11: when true, the `delete_session` stub replies `not_found`. */
  deleteSessionNotFound = false
  /** CAP-11 compat: when true, `list_agents` replies with bare id strings
   * (the pre-CAP-11 server shape) instead of summary objects. */
  listAgentsAsStrings = false
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
  snapshotFailureCodes = new Map<string, string>()
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
  /** When set, `load_session`/`resume_session` reply with this err (default: ok
   * with `reopenOutcome`) — used by the reopen admission-failure parity test. */
  reopenFailure: { code: string; message: string } | null = null

  constructor(public url: string) {
    this.subscribeFailureCodes = new Map(
      Object.entries(FakeWebSocket.transientSubscribeFailuresOnNextSocket)
    )
    FakeWebSocket.transientSubscribeFailuresOnNextSocket = {}
    if (!(this.constructor as typeof FakeWebSocket).autoOpen) return
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
      const refusal = this.authRefusalCode ?? validateHandshake(req.payload)
      if (refusal) {
        this.emitReply({ id: req.id, ok: false, err: { code: refusal, message: refusal } })
        return
      }
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
      if (!this.holdPing) this.emitReply({ id: req.id, ok: true, payload: {} })
      return
    }
    if (req.type === 'subscribe') {
      if (this.holdSubscribe) return
      const payload = req.payload as { sessionId: string; lastSeq?: number }
      const failureCode = this.subscribeFailureCodes.get(payload.sessionId)
      if (this.failSubscribeSessions.has(payload.sessionId) || failureCode) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: failureCode ?? 'not_found', message: 'subscription failed' }
        })
        return
      }
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
      const failureCode = this.snapshotFailureCodes.get(payload.sessionId)
      if (failureCode) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: failureCode, message: 'snapshot recovery failed' }
        })
        return
      }
      this.emitReply({
        id: req.id,
        ok: true,
        payload: { sessionId: payload.sessionId, watermark: 42, events: this.snapshotEvents }
      })
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
      if (this.createSessionErr) {
        this.emitReply({ id: req.id, ok: false, err: this.createSessionErr })
        return
      }
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
    if (req.type === 'promote_session') {
      // Story 8: the host promotes the warm-pool session to durable — ok.
      this.emitReply({ id: req.id, ok: true, payload: {} })
      return
    }
    if (req.type === 'load_session' || req.type === 'resume_session') {
      if (this.reopenFailure) {
        this.emitReply({ id: req.id, ok: false, err: this.reopenFailure })
        return
      }
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
    if (req.type === 'record_agent_switch') {
      // CAP-2: ok with an empty payload (the durable write happened
      // server-side before the reply).
      this.emitReply({ id: req.id, ok: true, payload: {} })
      return
    }
    if (req.type === 'register_discovered_session') {
      const payload = req.payload as {
        sessionId: string
        agentId: string
        cwd: string
        title?: string | null
        updatedAt?: number
      }
      this.emitReply({
        id: req.id,
        ok: true,
        payload: {
          storageKey: 'promoted-key',
          sessionId: payload.sessionId,
          stableAgentNamespace: 'config:test',
          runtimeAgentId: payload.agentId,
          cwd: payload.cwd,
          title: payload.title ?? null,
          createdAt: payload.updatedAt ?? 1,
          lastActivityAt: payload.updatedAt ?? 1,
          status: 'active',
          messageCount: 0,
          toolCount: 0,
          lastSeq: 0,
          resumeEligible: true
        }
      })
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
      // CAP-11: record the identity-rich summary the real server captures
      // from the spawn-time AgentConfig (`configId` omitted when absent).
      this.liveAgents.set(agentId, {
        id: agentId,
        name: (payload.config as { name?: string } | undefined)?.name ?? 'agent',
        configId: (payload.config as { configId?: string } | undefined)?.configId,
        namespace: 'config:test',
        capabilities: { loadSession: true }
      })
      // CAP-4: the spawn response carries the full authoritative metadata
      // (capabilities + authMethods + host-auth readiness + stableNamespace),
      // not just the agentId.
      this.emitReply({
        id: req.id,
        ok: true,
        payload: {
          agentId,
          capabilities: { loadSession: true },
          authMethods: [],
          hostAuthReady: true,
          stableNamespace: 'config:test'
        }
      })
      return
    }
    if (req.type === 'list_agents') {
      this.emitReply({
        id: req.id,
        ok: true,
        payload: this.listAgentsAsStrings
          ? [...this.liveAgents.keys()]
          : [...this.liveAgents.values()]
      })
      return
    }
    // CAP-11: host-owned session delete — ok `{}` for known ids;
    // `deleteSessionNotFound` flips the stub to the unknown-id `not_found`.
    if (req.type === 'delete_session') {
      const payload = req.payload as { sessionId?: string }
      if (!payload.sessionId) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'unsupported', message: 'malformed delete_session' }
        })
        return
      }
      if (this.deleteSessionNotFound) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'not_found', message: 'persisted session not found' }
        })
        return
      }
      this.deletedSessions.push(payload.sessionId)
      this.emitReply({ id: req.id, ok: true, payload: {} })
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
    // CAP: ACP agent `authenticate` method (agent-advertised auth, e.g.
    // `pi_terminal_login`). Reply ok by default; tests set `authenticateAgentErr`
    // to simulate a provider auth failure. Distinct from the `authenticate`
    // token-gate handshake.
    if (req.type === 'authenticate_agent') {
      const payload = req.payload as { agentId?: string; methodId?: string }
      if (!payload.agentId || !payload.methodId) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'unsupported', message: 'malformed authenticate_agent' }
        })
        return
      }
      if (this.authenticateAgentErr) {
        this.emitReply({ id: req.id, ok: false, err: this.authenticateAgentErr })
        return
      }
      this.emitReply({ id: req.id, ok: true, payload: {} })
      return
    }
    // Headless ACP auth paste-back (spec-acp-terminal-auth): the renderer
    // hands the pasted loopback redirect to the host, which replays it to the
    // agent's callback listener and reports the HTTP status.
    if (req.type === 'acp_deliver_auth_redirect') {
      const payload = req.payload as { agentId?: string; url?: string }
      if (!payload.agentId || !payload.url) {
        this.emitReply({
          id: req.id,
          ok: false,
          err: { code: 'unsupported', message: 'malformed acp_deliver_auth_redirect' }
        })
        return
      }
      if (this.deliverAuthRedirectReply) {
        this.emitReply({ id: req.id, ...this.deliverAuthRedirectReply })
        return
      }
      this.emitReply({ id: req.id, ok: true, payload: { status: 200 } })
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
    if (req.type === 'set_config_option') {
      this.emitReply({ id: req.id, ok: true, payload: this.setConfigOptionReply })
      return
    }
    if (req.type === 'watch_project' || req.type === 'unwatch_project') {
      const projectId = (req.payload as { projectId?: string }).projectId ?? ''
      const refusal =
        req.type === 'watch_project' ? FakeWebSocket.watchProjectRefusals[projectId] : undefined
      if (refusal) {
        this.emitReply({ id: req.id, ok: false, err: { code: refusal, message: 'refused' } })
        return
      }
      this.emitReply({ id: req.id, ok: true, payload: req.payload })
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
/**
 * Drain the transport's `eventTail` queue: event frames dispatch through a
 * serialized promise chain, so a synchronous `sock.emit()` followed by an
 * immediate assert would race the queued `handleEvent`. Awaiting the tail
 * resolves once every currently-queued event (and any `await` inside its
 * handler, e.g. `subscribeSession`) has settled — deterministic, unlike a
 * guessed tick count.
 */
// Tests reach into `eventTail` the same way they already reach `socket` /
// `lastSeq` — a known-internal private; a named cast for the one-off read.
interface EventTailProbe {
  eventTail: Promise<void>
}
const flushEvents = (transport: WsAcpTransport) =>
  (transport as unknown as EventTailProbe).eventTail

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
    // (agentId + capabilities + authMethods + host-auth readiness +
    // stableNamespace), matching the desktop Tauri command's return type.
    expect(spawnResult.agentId).toBe('agent-spawned-1')
    expect(spawnResult.capabilities).toEqual({ loadSession: true })
    expect(spawnResult.authMethods).toEqual([])
    expect(spawnResult.hostAuthReady).toBe(true)
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

  it('listAgents maps identity-rich summaries to ids; listAgentDetails returns them', async () => {
    // CAP-11: the WS `list_agents` reply changed string[] → summary objects.
    // `listAgents` preserves the legacy id-array contract; `listAgentDetails`
    // exposes the full `{ id, name, configId?, namespace?, capabilities }`.
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()

    await transport.spawnAgent({
      name: 'test',
      command: 'npx',
      args: ['-y', '@example/agent'],
      env: {},
      allowTerminal: false
    })

    expect(await transport.listAgents()).toEqual(['agent-spawned-1'])
    const details = await transport.listAgentDetails()
    expect(details).toEqual([
      {
        id: 'agent-spawned-1',
        name: 'test',
        // `configId` is omitted (skip_serializing_if) — the spawn config had none.
        namespace: 'config:test',
        capabilities: { loadSession: true }
      }
    ])

    transport.dispose()
  })

  it('listAgents tolerates a pre-CAP-11 server returning bare id strings', async () => {
    let socket: FakeWebSocket | null = null
    class CaptureSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url)
        socket = this
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: CaptureSocket as unknown as typeof WebSocket
    })
    await transport.connect()

    await transport.spawnAgent({
      name: 'test',
      command: 'npx',
      args: ['-y', '@example/agent'],
      env: {},
      allowTerminal: false
    })

    if (socket) socket.listAgentsAsStrings = true
    expect(await transport.listAgents()).toEqual(['agent-spawned-1'])

    transport.dispose()
  })

  it('deleteSession sends delete_session; unknown id surfaces not_found', async () => {
    // CAP-11: server-mode history delete routes through the WS transport.
    let socket: FakeWebSocket | null = null
    class CaptureSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url)
        socket = this
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: CaptureSocket as unknown as typeof WebSocket
    })
    await transport.connect()

    await transport.deleteSession('sess-1')
    expect(socket?.deletedSessions).toEqual(['sess-1'])

    if (socket) socket.deleteSessionNotFound = true
    await expect(transport.deleteSession('sess-gone')).rejects.toMatchObject({
      name: 'AcpTransportError',
      code: 'not_found'
    })

    transport.dispose()
  })

  it('authenticate routes the agent `authenticate` method over WS (authenticate_agent)', async () => {
    // The web client must run the ACP agent-advertised `authenticate` method
    // (e.g. `pi_terminal_login`) on the host — NOT throw "is not available
    // over WS yet". The WS transport sends an `authenticate_agent` request
    // (distinct from the `authenticate` token-gate handshake) and resolves on
    // the host's ok reply.
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    // Must NOT throw — resolves on the host's ok reply.
    await expect(transport.authenticate('agent-1', 'pi_terminal_login')).resolves.toBeUndefined()

    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string; payload: unknown })
    const authReq = sent.find((r) => r.type === 'authenticate_agent')
    expect(authReq).toBeTruthy()
    expect(authReq?.payload).toEqual({
      agentId: 'agent-1',
      methodId: 'pi_terminal_login'
    })

    transport.dispose()
  })

  it('authenticate rejects with AcpTransportError when the host reports failure', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.authenticateAgentErr = { code: 'AUTHENTICATE_FAILED', message: 'provider denied' }

    await expect(transport.authenticate('agent-1', 'pi_terminal_login')).rejects.toBeInstanceOf(
      AcpTransportError
    )

    transport.dispose()
  })

  it('deliverAuthRedirect sends acp_deliver_auth_redirect and resolves the status', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    await expect(
      transport.deliverAuthRedirect('agent-1', 'http://127.0.0.1:54321/cb?code=x')
    ).resolves.toBe(200)

    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string; payload: unknown })
    const req = sent.find((r) => r.type === 'acp_deliver_auth_redirect')
    expect(req).toBeTruthy()
    expect(req?.payload).toEqual({
      agentId: 'agent-1',
      url: 'http://127.0.0.1:54321/cb?code=x'
    })

    transport.dispose()
  })

  it('deliverAuthRedirect surfaces a non-2xx status and host errors', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    // The agent's listener answered but rejected the redirect — the status is
    // data, not a transport failure.
    sock.deliverAuthRedirectReply = { ok: true, payload: { status: 500 } }
    await expect(transport.deliverAuthRedirect('agent-1', 'http://localhost:9/cb')).resolves.toBe(
      500
    )

    // A host-side failure (validation, dead agent) maps to AcpTransportError.
    sock.deliverAuthRedirectReply = {
      ok: false,
      err: { code: 'invalid_request', message: 'non-loopback url rejected' }
    }
    await expect(
      transport.deliverAuthRedirect('agent-1', 'http://localhost:9/cb')
    ).rejects.toBeInstanceOf(AcpTransportError)

    transport.dispose()
  })

  it('deliverAuthRedirect rejects a malformed reply missing numeric status', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    sock.deliverAuthRedirectReply = { ok: true, payload: {} }
    await expect(
      transport.deliverAuthRedirect('agent-1', 'http://localhost:9/cb')
    ).rejects.toBeInstanceOf(AcpTransportError)

    transport.dispose()
  })

  it('browser_open_request events reach onEvent subscribers', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    const seen: Array<{ agentId: string; url: string }> = []
    transport.onEvent<{ agentId: string; url: string }>('acp:browser_open_request', (payload) =>
      seen.push(payload)
    )
    sock.emit({
      sid: null,
      seq: 0,
      type: 'browser_open_request',
      payload: { agentId: 'agent-1', url: 'https://auth.example.com/x' }
    })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ agentId: 'agent-1', url: 'https://auth.example.com/x' })

    transport.dispose()
  })

  it('promoteSession sends promote_session then subscribes (story 8)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    await transport.promoteSession?.('agent-1', 'sess-warm')

    const sent = sock.sent.map((s) => JSON.parse(s) as { type: string; payload: unknown })
    const promoteIdx = sent.findIndex((r) => r.type === 'promote_session')
    const subscribeIdx = sent.findIndex(
      (r) =>
        r.type === 'subscribe' && (r.payload as { sessionId?: string }).sessionId === 'sess-warm'
    )
    expect(promoteIdx).toBeGreaterThanOrEqual(0)
    expect(subscribeIdx).toBeGreaterThanOrEqual(0)
    // The promote must land BEFORE the subscribe so the first prompt persists
    // (durability handoff, then stream attach).
    expect(promoteIdx).toBeLessThan(subscribeIdx)
    expect(sent[promoteIdx]?.payload).toEqual({ agentId: 'agent-1', sessionId: 'sess-warm' })

    transport.dispose()
  })

  it('promoteSession resolves when the post-promotion subscribe fails (story 8)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const internals = transport as unknown as TransportInternals
    const sock = internals.socket
    vi.mocked(logFrontendError).mockClear()

    // A subscribe failure AFTER a successful promote must not reject the
    // promotion: the session is already durable on the host. (Non-STALE code
    // so subscribeSession throws instead of entering snapshot recovery.)
    sock.subscribeFailureCodes.set('sess-warm', 'agent_crashed')

    await expect(transport.promoteSession?.('agent-1', 'sess-warm')).resolves.toBeUndefined()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'WsAcpTransport.promoteSession',
        message: expect.stringContaining('sess-warm')
      })
    )
    // The optimistic pre-request subscribed mark is cleared, so the
    // already-subscribed guard cannot suppress a later retry.
    expect(internals.subscribed.has('sess-warm')).toBe(false)

    // Retry eligibility: once the transient failure clears, a re-promote (or
    // the next sendPrompt's subscribe) re-attaches the live stream.
    sock.subscribeFailureCodes.delete('sess-warm')
    const subscribesFor = () =>
      sock.sent.filter((s) => {
        const frame = JSON.parse(s) as { type: string; payload?: { sessionId?: string } }
        return frame.type === 'subscribe' && frame.payload?.sessionId === 'sess-warm'
      }).length
    const subscribesBefore = subscribesFor()
    await expect(transport.promoteSession?.('agent-1', 'sess-warm')).resolves.toBeUndefined()
    expect(subscribesFor()).toBe(subscribesBefore + 1)
    expect(internals.subscribed.has('sess-warm')).toBe(true)

    transport.dispose()
  })

  it('timeout setters are desktop-only no-ops on the WS transport', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const sentBefore = sock.sent.length

    // The standalone server has no settings surface and configures these via
    // the TERMUL_ACP_* env vars — the setters must resolve without sending
    // anything over the wire (and without throwing).
    await transport.setTurnTimeout(7200)
    await transport.setTurnIdleTimeout(1800)
    await transport.setSessionNewTimeout(120)
    await transport.setSessionReopenTimeout(300)

    expect(sock.sent.length).toBe(sentBefore)
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

  it('sends the owning projectId on create_session and subscribes the new session', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    const outcome = await transport.newSession('a1', '/work/p2', undefined, { projectId: 'p-2' })

    const frames = sock.sent.map((raw) => JSON.parse(raw) as { type: string; payload: unknown })
    expect(frames).toContainEqual({
      id: expect.any(String),
      type: 'create_session',
      payload: { agentId: 'a1', cwd: '/work/p2', ephemeral: false, projectId: 'p-2' }
    })
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'subscribe', payload: { sessionId: outcome.sessionId } })
    )
    expect(frames.some((frame) => frame.type === 'switch_project')).toBe(false)
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
    await flushEvents(transport)
    expect(calls).toEqual([{ n: 3 }])
    expect(lastSeq.get('s1')).toBe(3)
    // A subsequent contiguous event (seq 4) flows without duplication.
    sock.emit({ sid: 's1', seq: 4, type: 'tool_call', payload: { n: 4 } })
    await flushEvents(transport)
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
    await flushEvents(transport)
    expect(chunks).toEqual([{ n: 2 }])
    expect(lastSeq.get('s1')).toBe(2)
    // A reordered-earlier seq cannot arrive on a single FIFO WebSocket, but if
    // one did it is dropped as `seq <= last` — the cursor never regresses.
    // Documents the intentional removal of reorder-recovery (see spec Design Notes).
    sock.emit({ sid: 's1', seq: 1, type: 'message_chunk', payload: { n: 1 } })
    await flushEvents(transport)
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
    await flushEvents(transport)
    expect(calls).toEqual([{ n: 3 }])
    // A reconnect replay re-emits the same seq (or a lower one already passed) —
    // the transport drops it as `seq <= last`, never re-delivering.
    sock.emit({ sid: 's1', seq: 3, type: 'tool_call', payload: { n: 3 } })
    sock.emit({ sid: 's1', seq: 2, type: 'tool_call', payload: { n: 2 } })
    await flushEvents(transport)
    expect(calls).toEqual([{ n: 3 }])
    transport.dispose()
  })

  it('passes the envelope seq to listeners so the store can seq-dedupe against the payload', async () => {
    // CAP-3 replay contract (story 11): the fetched payload is authoritative;
    // store handlers drop live events whose envelope seq the payload already
    // covers. That requires the envelope seq to reach the listener.
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const seen: Array<{ payload: unknown; eventSeq?: number }> = []
    transport.onEvent('acp:message_chunk', (p, eventSeq) => {
      seen.push({ payload: p, eventSeq })
    })

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.emit({ sid: 's1', seq: 7, type: 'message_chunk', payload: { n: 7 } })
    await flushEvents(transport)
    expect(seen).toEqual([{ payload: { n: 7 }, eventSeq: 7 }])
    // Agent-level / relay events carry no per-session seq: the listener
    // receives undefined (never a 0 that a `seq <= watermark` check could
    // misread as history-covered).
    const agentEvents: Array<{ payload: unknown; eventSeq?: number }> = []
    transport.onEvent('acp:agent_spawned', (p, eventSeq) => {
      agentEvents.push({ payload: p, eventSeq })
    })
    sock.emit({ sid: null, seq: 0, type: 'agent_spawned', payload: { agentId: 'a1' } })
    await flushEvents(transport)
    expect(agentEvents).toEqual([{ payload: { agentId: 'a1' }, eventSeq: undefined }])
    expect(seen).toHaveLength(1)
    transport.dispose()
  })

  it('unwraps a batched events frame through the same handleEvent path', async () => {
    // The WS write loop packs a drained burst as {type:'events', events:[…]};
    // each inner event must reach its listener with its own seq honored.
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const chunks: Array<{ payload: unknown; seq?: number }> = []
    transport.onEvent('acp:message_chunk', (p, eventSeq) =>
      chunks.push({ payload: p, seq: eventSeq })
    )
    const calls: unknown[] = []
    transport.onEvent('acp:tool_call', (p) => calls.push(p))

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const lastSeq = (transport as unknown as { lastSeq: Map<string, number> }).lastSeq
    sock.emit({
      type: 'events',
      events: [
        { sid: 's1', seq: 4, type: 'message_chunk', payload: { n: 4 } },
        { sid: 's1', seq: 5, type: 'tool_call', payload: { id: 't5' } },
        { sid: 's1', seq: 6, type: 'message_chunk', payload: { n: 6 } }
      ]
    })
    // Inner events deliver sequentially through `await handleEvent` — the
    // second and third land on later microtasks; wait on the condition, not
    // a guessed tick count.
    await vi.waitFor(() => expect(chunks).toHaveLength(2))
    expect(chunks).toEqual([
      { payload: { n: 4 }, seq: 4 },
      { payload: { n: 6 }, seq: 6 }
    ])
    expect(calls).toEqual([{ id: 't5' }])
    expect(lastSeq.get('s1')).toBe(6)
    // A stale seq inside a later batch is still deduped per inner event.
    sock.emit({
      type: 'events',
      events: [{ sid: 's1', seq: 4, type: 'message_chunk', payload: { n: 4 } }]
    })
    await vi.waitFor(() => expect(lastSeq.get('s1')).toBe(6))
    expect(chunks).toHaveLength(2)
    transport.dispose()
  })

  it('reload simulates cursor-replay-then-continue (fresh transport + fresh socket)', async () => {
    // Category B/E: simulate a page reload by creating a FRESH transport
    // whose `lastSeq` cursor is restored from the HOST (the cross-client
    // authority — not the old transport's in-memory state, which a reload
    // discards). The existing reconnect tests reuse the SAME transport
    // instance; this creates a NEW one to model a true page reload where
    // `seenTurnIds` + `lastSeq` are re-seeded from the host (e.g.
    // `get_session_cursor`), then a NEW socket replays the tail.
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const lastSeq = (transport as unknown as { lastSeq: Map<string, number> }).lastSeq
    // Cursor pre-seeded to 5 (simulating the result of a host restore —
    // the 5 events the previous page saw). The block comment above explains
    // this models a host-driven cursor restore; this test does NOT call the
    // host directly (it pre-seeds the cursor the host would have returned).
    lastSeq.set('sess-reload', 5)

    const calls: unknown[] = []
    transport.onEvent('acp:tool_call', (p) => calls.push(p))
    const chunks: unknown[] = []
    transport.onEvent('acp:message_chunk', (p) => chunks.push(p))

    // The NEW socket replays seqs <= 5 (already seen before the reload) — the
    // fresh transport dedups them (never re-delivered).
    sock.emit({ sid: 'sess-reload', seq: 4, type: 'tool_call', payload: { n: 4 } })
    sock.emit({ sid: 'sess-reload', seq: 5, type: 'tool_call', payload: { n: 5 } })
    await flushEvents(transport)
    expect(calls).toEqual([])

    // Reliable seqs 6-10 are delivered in order, advancing the cursor.
    for (let i = 6; i <= 10; i++) {
      sock.emit({ sid: 'sess-reload', seq: i, type: 'tool_call', payload: { n: i } })
    }
    await flushEvents(transport)
    expect(calls).toEqual([6, 7, 8, 9, 10].map((n) => ({ n })))

    // A lossy seq 11 is also delivered + the cursor advances to 11.
    sock.emit({ sid: 'sess-reload', seq: 11, type: 'message_chunk', payload: { n: 11 } })
    await flushEvents(transport)
    expect(chunks).toEqual([{ n: 11 }])
    expect(lastSeq.get('sess-reload')).toBe(11)
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

  it('retains a stale subscription when snapshot recovery fails transiently', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.snapshotFailureCodes.set('s-transient-snapshot', 'agent_crashed')

    await expect(transport.subscribeSession('s-transient-snapshot', 99)).rejects.toMatchObject({
      code: 'agent_crashed'
    })
    const subscribed = (transport as unknown as { subscribed: Set<string> }).subscribed
    expect(subscribed.has('s-transient-snapshot')).toBe(true)
    expect(isTransientAcpTransportError(new AcpTransportError('agent_crashed', 'retry'))).toBe(true)
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
  it('captures the reopen generation before the snapshot round-trip and threads it to recovery', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    const order: string[] = []
    transport.setRecoveryGenerationProvider((sessionId) => {
      order.push(`capture:${sessionId}`)
      return 5
    })
    const generations: Array<number | undefined> = []
    transport.setRecoveryHandler(async (_recovery, reopenGeneration) => {
      generations.push(reopenGeneration)
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.snapshotEvents = [
      { sid: 's1', seq: 42, type: 'message_chunk', payload: { content: { text: 'snapshot' } } }
    ]
    const origSend = sock.send.bind(sock)
    sock.send = (data: string) => {
      order.push(`send:${JSON.parse(data).type}`)
      origSend(data)
    }

    await transport.subscribeSession('s1', 99)

    // The generation handed to the handler is the one captured BEFORE the
    // recover_session_snapshot request went out — a mid-flight close/reopen
    // is detected by the store comparing against the CURRENT generation.
    expect(generations).toEqual([5])
    expect(order.indexOf('capture:s1')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('capture:s1')).toBeLessThan(order.indexOf('send:recover_session_snapshot'))
    transport.dispose()
  })

  it('threads the reopen generation to degraded (live-only) recovery', async () => {
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
    transport.setRecoveryGenerationProvider(() => 7)
    const generations: Array<number | undefined> = []
    transport.setRecoveryHandler(async (_recovery, reopenGeneration) => {
      generations.push(reopenGeneration)
    })
    await transport.connect()
    await transport.subscribeSession('s1', 99)
    expect(generations).toEqual([7])
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
    await flushEvents(transport)
    expect(completes).toHaveLength(1)
    expect(lastSeq.get('s1')).toBe(1)

    sock.emit({
      sid: 's1',
      seq: 2,
      type: 'prompt_complete',
      payload: { turnId: 't1', stopReason: 'end_turn' }
    })
    await flushEvents(transport)
    // Duplicate turn id: not re-emitted, but cursor advances.
    expect(completes).toHaveLength(1)
    expect(lastSeq.get('s1')).toBe(2)

    sock.emit({
      sid: 's1',
      seq: 3,
      type: 'tool_call',
      payload: { n: 3 }
    })
    await flushEvents(transport)
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

  it('registerDiscoveredSession promotes metadata over the WS seam', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })

    const summary = await transport.registerDiscoveredSession({
      sessionId: 'discovered-1',
      agentId: 'agent-1',
      cwd: '/work',
      title: 'Agent title',
      updatedAt: 42
    })

    expect(summary).toMatchObject({
      sessionId: 'discovered-1',
      runtimeAgentId: 'agent-1',
      title: 'Agent title',
      status: 'active'
    })
    transport.dispose()
  })

  it('recordAgentSwitch sends a record_agent_switch request frame over the WS seam', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    // CAP-2: the WS route mirrors the Tauri command's five-field payload.
    await transport.recordAgentSwitch('s-old', {
      fromConfigId: 'omp',
      toConfigId: 'claude',
      newSessionId: 's-new',
      summaryText: 'Handoff summary'
    })

    const frame = JSON.parse(sock.sent.at(-1)!) as {
      type: string
      payload: Record<string, string>
    }
    expect(frame.type).toBe('record_agent_switch')
    expect(frame.payload).toEqual({
      sessionId: 's-old',
      fromConfigId: 'omp',
      toConfigId: 'claude',
      newSessionId: 's-new',
      summaryText: 'Handoff summary'
    })
    transport.dispose()
  })

  it('watchProject / unwatchProject send the per-project watch requests', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const lastFrame = () =>
      JSON.parse(sock.sent.at(-1)!) as { type: string; payload: Record<string, string> }

    await transport.watchProject?.('p-1')
    expect(lastFrame()).toMatchObject({ type: 'watch_project', payload: { projectId: 'p-1' } })
    await transport.unwatchProject?.('p-1')
    expect(lastFrame()).toMatchObject({ type: 'unwatch_project', payload: { projectId: 'p-1' } })
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

  it('web transports a successful option change without a snapshot', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.setConfigOptionReply = null

    await expect(transport.setConfigOption('a1', 's1', 'model', 'm2')).resolves.toBeNull()
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
      id: expect.any(String),
      type: 'set_config_option',
      payload: { agentId: 'a1', sessionId: 's1', configId: 'model', valueId: 'm2' }
    })
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

  it('forwards promotable ephemeral creation over WS (story 8)', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket

    await transport.newSession('a1', '/work', undefined, { ephemeral: true, promotable: true })

    const frames = sock.sent.map((raw) => JSON.parse(raw) as { type: string; payload: unknown })
    expect(frames).toContainEqual({
      id: expect.any(String),
      type: 'create_session',
      payload: { agentId: 'a1', cwd: '/work', ephemeral: true, promotable: true }
    })
    // Ephemeral: still no subscribe at create (the subscribe happens on
    // `promoteSession`).
    expect(frames.some((frame) => frame.type === 'subscribe')).toBe(false)
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
    // Reply resolves on its frame; the streamed events drain via eventTail.
    await flushEvents(transport)
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
    await flushEvents(transport)
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

// Per-project fs watch: the host keeps no watch state across connections, so
// the transport re-sends `watch_project` after a reconnect and reports watches
// it cannot restore.
describe('WsAcpTransport project watches across reconnects', () => {
  afterEach(() => {
    FakeWebSocket.watchProjectRefusals = {}
    vi.useRealTimers()
  })

  async function connectedWithWatch(projectId: string): Promise<WsAcpTransport> {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.watchProject?.(projectId)
    return transport
  }

  const watchFrames = (transport: WsAcpTransport): string[] =>
    (transport as unknown as { socket: FakeWebSocket }).socket.sent
      .map((frame) => JSON.parse(frame) as { type: string; payload: { projectId?: string } })
      .filter((frame) => frame.type === 'watch_project')
      .map((frame) => frame.payload.projectId ?? '')

  async function dropAndReconnect(transport: WsAcpTransport): Promise<void> {
    ;(transport as unknown as { socket: FakeWebSocket }).socket.close()
    // Backoff doubles per consecutive drop (500 ms, 1 s, …); cover the second.
    await vi.advanceTimersByTimeAsync(2500)
    await vi.advanceTimersByTimeAsync(50) // let the off-critical-path re-watch settle
  }

  it('re-sends watch_project for every watched project on the fresh socket', async () => {
    vi.useFakeTimers()
    const transport = await connectedWithWatch('p-1')
    await transport.watchProject?.('p-2')

    await dropAndReconnect(transport)

    expect(watchFrames(transport).sort()).toEqual(['p-1', 'p-2'])
    transport.dispose()
  })

  it('drops a watch the host refuses after reconnect and reports it as ended', async () => {
    vi.useFakeTimers()
    const transport = await connectedWithWatch('p-gone')
    const ended: unknown[] = []
    transport.onEvent('acp:fs_watch_ended', (payload) => ended.push(payload))
    FakeWebSocket.watchProjectRefusals['p-gone'] = 'not_found'

    await dropAndReconnect(transport)

    expect(ended).toEqual([{ projectId: 'p-gone', reason: 'rewatch_failed' }])
    // It is no longer re-requested on later reconnects.
    FakeWebSocket.watchProjectRefusals = {}
    await dropAndReconnect(transport)
    expect(watchFrames(transport)).toEqual([])
    transport.dispose()
  })

  it('stops re-sending a watch the host ended (fs_watch_ended)', async () => {
    vi.useFakeTimers()
    const transport = await connectedWithWatch('p-1')
    ;(transport as unknown as { socket: FakeWebSocket }).socket.emit({
      sid: null,
      seq: 0,
      type: 'fs_watch_ended',
      payload: { projectId: 'p-1', reason: 'project_unavailable' }
    })
    await vi.advanceTimersByTimeAsync(10)

    await dropAndReconnect(transport)

    expect(watchFrames(transport)).toEqual([])
    transport.dispose()
  })

  it('a failing re-watch never delays or fails the reconnect itself', async () => {
    vi.useFakeTimers()
    const transport = await connectedWithWatch('p-1')
    const states: boolean[] = []
    transport.setReconnectListener((reconnecting) => states.push(reconnecting))
    FakeWebSocket.watchProjectRefusals['p-1'] = 'internal'

    await dropAndReconnect(transport)

    expect(states[states.length - 1]).toBe(false)
    transport.dispose()
  })
})

// Story 8 (web honesty) — reconnect-failure log routing.
// An idle client (no subscribed sessions, no in-flight requests) has nothing
// to recover: its reconnect churn (the server's PONG watchdog killing the
// idle `/ws` mid-auth → "WebSocket closed before auth") must be logged at
// info, not warn. A session-bearing client keeps the warn — a dropped
// channel there is a real outage.
describe('WsAcpTransport reconnect failure log routing (Story 8)', () => {
  afterEach(() => {
    _resetAcpTransportForTests(null)
    vi.useRealTimers()
  })

  /** Socket whose auth handshake never completes: it opens, demands auth,
   * then closes before the authenticate reply arrives — the exact server
   * PONG-watchdog mid-auth kill the QA report quotes. */
  class AuthNeverCompletesWebSocket extends FakeWebSocket {
    static autoOpen = false
    /** Sockets currently in CONNECTING state awaiting manual open. */
    static pending: AuthNeverCompletesWebSocket[] = []

    constructor(url: string) {
      super(url)
      this.readyState = FakeWebSocket.CONNECTING
      AuthNeverCompletesWebSocket.pending.push(this)
    }

    /** Open + demand auth, then close mid-handshake (watchdog kill). */
    openThenCloseMidAuth(): void {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.(new Event('open'))
      this.emit({ sid: null, seq: 0, type: 'auth_required', payload: {} })
      // The server kills the socket before answering `authenticate`.
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.(new CloseEvent('close'))
    }
  }

  it('logs an idle (no-session) reconnect failure at info, not warn', async () => {
    vi.useFakeTimers()
    vi.mocked(logFrontendError).mockClear()
    AuthNeverCompletesWebSocket.pending = []
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: AuthNeverCompletesWebSocket as unknown as typeof WebSocket
    })
    const internals = transport as unknown as TransportInternals

    // Initial connect: opens, demands auth, dies mid-auth → scheduleReconnect.
    const connectPromise = transport.connect()
    await Promise.resolve()
    const first = AuthNeverCompletesWebSocket.pending.shift()
    first?.openThenCloseMidAuth()
    await expect(connectPromise).rejects.toThrow('WebSocket closed before auth')
    expect(internals.reconnectTimer).not.toBeNull()

    // Reconnect attempt: a fresh socket also dies mid-auth → reconnect()
    // fails. The client has ZERO subscribed sessions and no pending requests,
    // so the failure must land at info (benign idle churn), never warn.
    await vi.advanceTimersByTimeAsync(600)
    const second = AuthNeverCompletesWebSocket.pending.shift()
    second?.openThenCloseMidAuth()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    const calls = vi
      .mocked(logFrontendError)
      .mock.calls.filter(
        (call) =>
          typeof call[0]?.source === 'string' && call[0].source.includes('WsAcpTransport.reconnect')
      )
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call[0]?.level).toBe('info')
    }
    expect(calls.some((call) => call[0]?.level === 'warn')).toBe(false)

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
  })

  it('keeps warn for a reconnect failure while a live session is subscribed', async () => {
    vi.useFakeTimers()
    vi.mocked(logFrontendError).mockClear()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    // A live session the reconnect must recover — not idle.
    await transport.subscribeSession('sess-live')

    // The reconnect attempt's fresh socket re-authenticates fine but fails
    // the required session resubscribe with a transient code (not not_found,
    // which would prune as obsolete) → reconnect() throws and its catch
    // logs. subscribed.size > 0 → real outage → warn, never info.
    FakeWebSocket.transientSubscribeFailuresOnNextSocket = { 'sess-live': 'closed' }
    const internals = transport as unknown as TransportInternals
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()

    const calls = vi
      .mocked(logFrontendError)
      .mock.calls.filter(
        (call) =>
          typeof call[0]?.source === 'string' && call[0].source.includes('WsAcpTransport.reconnect')
      )
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      // A live session lost its channel — this is the real-outage class and
      // must stay on the warn channel.
      expect(call[0]?.level).toBe('warn')
    }
    expect(calls.some((call) => call[0]?.level === 'info')).toBe(false)

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
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
  connecting: Promise<void> | null
  reconnecting: boolean
  visibilityHandler: (() => void) | null
  focusHandler: (() => void) | null
  pageShowHandler: (() => void) | null
  resumeHandler: (() => void) | null
  onlineHandler: (() => void) | null
  resumeValidation: Promise<void> | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  lastSeq: Map<string, number>
  subscribed: Set<string>
}

class DelayedOpenWebSocket extends FakeWebSocket {
  static autoOpen = false
  static pending: DelayedOpenWebSocket[] = []

  constructor(url: string) {
    super(url)
    this.readyState = FakeWebSocket.CONNECTING
    DelayedOpenWebSocket.pending.push(this)
  }

  openAndAuthenticate(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
    this.emit({ sid: null, seq: 0, type: 'auth_required', payload: {} })
  }
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

  it('validates a healthy OPEN socket on visibility return without replacing it', async () => {
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

    // Return from background validates with an application ping. A successful
    // round trip proves the OPEN socket is still usable, so no replacement.
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(1_000)
    dispatchVisibility('visible')
    await Promise.resolve()

    expect(internals.socket).toBe(oldSocket)
    expect(states).toEqual([])
    expect(findSentRequest(oldSocket, 'ping')).toBeDefined()

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
  })

  it('ignores lifecycle signals while initial authentication is still in flight', async () => {
    vi.useFakeTimers()
    DelayedOpenWebSocket.pending = []
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: DelayedOpenWebSocket as unknown as typeof WebSocket
    })
    const connecting = transport.connect()
    await Promise.resolve()
    const internals = transport as unknown as TransportInternals
    const openingSocket = internals.socket as DelayedOpenWebSocket

    dispatchVisibility('hidden')
    dispatchVisibility('visible')
    window.dispatchEvent(new Event('pageshow'))
    document.dispatchEvent(new Event('resume'))
    window.dispatchEvent(new Event('online'))

    expect(internals.socket).toBe(openingSocket)
    expect(internals.connecting).not.toBeNull()
    expect(openingSocket.onclose).not.toBeNull()
    expect(internals.reconnectTimer).toBeNull()

    openingSocket.openAndAuthenticate()
    await connecting
    expect(internals.socket).toBe(openingSocket)
    transport.dispose()
  })

  it('validates after a brief hide too because OPEN alone is not health proof', async () => {
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
    await vi.advanceTimersByTimeAsync(1_000)
    dispatchVisibility('visible')
    await Promise.resolve()

    expect(states).toEqual([])
    expect(internals.socket).toBe(socketBefore)
    expect(findSentRequest(socketBefore, 'ping')).toBeDefined()

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
  })

  it('force-reconnects and cursor-resubscribes when an OPEN socket fails resume validation', async () => {
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
    oldSocket.emit({
      sid: 'sess-A',
      seq: 1,
      type: 'message_chunk',
      payload: { role: 'agent', content: { text: 'before background' } }
    })
    await Promise.resolve()
    oldSocket.holdPing = true
    // The socket is OPEN (half-open: server gave up, client doesn't know yet).
    expect(oldSocket.readyState).toBe(FakeWebSocket.OPEN)

    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(1_000)
    dispatchVisibility('visible')
    await vi.advanceTimersByTimeAsync(5_100)
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
    const sub = findSentRequest(internals.socket, 'subscribe')
    expect(sub?.payload).toMatchObject({ sessionId: 'sess-A', lastSeq: 1 })

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
  })

  for (const signal of ['pageshow', 'resume', 'online'] as const) {
    it(`validates an OPEN socket on isolated ${signal}`, async () => {
      vi.useFakeTimers()
      const transport = new WsAcpTransport({
        url: 'ws://test/ws',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
      })
      await transport.connect()
      const internals = transport as unknown as TransportInternals
      const socket = internals.socket

      if (signal === 'resume') document.dispatchEvent(new Event(signal))
      else window.dispatchEvent(new Event(signal))
      await Promise.resolve()

      expect(findSentRequest(socket, 'ping')).toBeDefined()
      expect(internals.socket).toBe(socket)
      transport.dispose()
    })
  }

  it('does not start an extra probe or reconnect for lifecycle signals while the socket is healthy and a probe is in flight', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const internals = transport as unknown as TransportInternals
    const socket = internals.socket
    socket.holdPing = true

    window.dispatchEvent(new Event('pageshow'))
    document.dispatchEvent(new Event('resume'))
    window.dispatchEvent(new Event('online'))

    expect(socket.sent.filter((raw) => JSON.parse(raw).type === 'ping')).toHaveLength(1)
    expect(internals.reconnectTimer).toBeNull()
    expect(internals.socket).toBe(socket)
    transport.dispose()
  })

  it('coalesces visibility, pageshow, resume, online, and focus validation signals', async () => {
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
    oldSocket.holdPing = true

    // All lifecycle signals arrive while the same bounded ping is in flight.
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(1_000)
    dispatchVisibility('visible')
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('pageshow'))
    document.dispatchEvent(new Event('resume'))
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    expect(oldSocket.sent.filter((raw) => JSON.parse(raw).type === 'ping')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5_100)
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

  it('a plain focus of a socket that never left the page does not ping; focus after blur does, once', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const internals = transport as unknown as TransportInternals
    const socket = internals.socket
    const pings = () => socket.sent.filter((raw) => JSON.parse(raw).type === 'ping').length

    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(pings()).toBe(0)

    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(pings()).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    // The probe cleared the away flag: the next plain focus is free again.
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(pings()).toBe(1)

    // A hide → show cycle re-arms the probe on its own return signal.
    dispatchVisibility('hidden')
    dispatchVisibility('visible')
    await vi.advanceTimersByTimeAsync(10)
    expect(pings()).toBe(2)
    transport.dispose()
  })

  it('pageshow, online and resume still probe a never-blurred socket', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const socket = (transport as unknown as TransportInternals).socket
    const pings = () => socket.sent.filter((raw) => JSON.parse(raw).type === 'ping').length
    window.dispatchEvent(new Event('pageshow'))
    await vi.advanceTimersByTimeAsync(10)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(10)
    document.dispatchEvent(new Event('resume'))
    await vi.advanceTimersByTimeAsync(10)
    expect(pings()).toBe(3)
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
    expect(internals.pageShowHandler).not.toBeNull()
    expect(internals.resumeHandler).not.toBeNull()
    expect(internals.onlineHandler).not.toBeNull()

    transport.dispose()
    expect(internals.visibilityHandler).toBeNull()
    expect(internals.focusHandler).toBeNull()
    expect(internals.pageShowHandler).toBeNull()
    expect(internals.resumeHandler).toBeNull()
    expect(internals.onlineHandler).toBeNull()
  })

  // CLI-F4/AD Conventions › Reconnect: the 30 s hidden-duration forced
  // reconnect is retired — the host holds a backgrounded socket for 300 s, so
  // every return signal PROBES the held socket and reconnects only on failure.
  it('probes the held socket after a long (>30s) background and keeps it when the probe succeeds', async () => {
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

    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(120_000)
    oldSocket.sent.length = 0
    dispatchVisibility('visible')
    await vi.advanceTimersByTimeAsync(10)

    expect(findSentRequest(oldSocket, 'ping')).toBeDefined() // probed, not replaced
    expect(internals.socket).toBe(oldSocket)
    expect(oldSocket.readyState).toBe(FakeWebSocket.OPEN)
    expect(states).toEqual([])
    expect(internals.reconnectTimer).toBeNull()
    transport.dispose()
  })

  it('reconnects after a long background only when the probe fails, cursor-resubscribing', async () => {
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
    oldSocket.emit({
      sid: 'sess-A',
      seq: 1,
      type: 'message_chunk',
      payload: { role: 'agent', content: { text: 'before background' } }
    })
    await Promise.resolve()

    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(120_000)
    oldSocket.holdPing = true // the held socket died while backgrounded
    dispatchVisibility('visible')
    await vi.advanceTimersByTimeAsync(4_900)
    expect(states).toEqual([]) // still within the bounded probe
    await vi.advanceTimersByTimeAsync(200)
    expect(states).toEqual([true])
    expect(oldSocket.readyState).toBe(FakeWebSocket.CLOSED)

    await vi.advanceTimersByTimeAsync(600)
    expect(internals.socket).not.toBe(oldSocket)
    expect(findSentRequest(internals.socket, 'subscribe')?.payload).toMatchObject({
      sessionId: 'sess-A',
      lastSeq: 1
    })
    transport.dispose()
  })

  for (const signal of ['visibility', 'focus', 'pageshow', 'resume', 'online'] as const) {
    it(`${signal} cuts a pending backoff short without resetting the attempt counter`, async () => {
      vi.useFakeTimers()
      const transport = new WsAcpTransport({
        url: 'ws://test/ws',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
      })
      await transport.connect()
      const states: boolean[] = []
      transport.setReconnectListener((r) => states.push(r))
      const internals = transport as unknown as TransportInternals
      internals.reconnectAttempt = 4 // elevated: the pending delay would be the 8s cap
      const oldSocket = internals.socket
      oldSocket.close()
      expect(internals.reconnectTimer).not.toBeNull()
      expect(internals.reconnectAttempt).toBe(5)

      if (signal === 'visibility') dispatchVisibility('visible')
      else if (signal === 'resume') document.dispatchEvent(new Event('resume'))
      else window.dispatchEvent(new Event(signal))
      expect(internals.reconnectTimer).toBeNull() // backoff cut short

      await vi.advanceTimersByTimeAsync(10)
      expect(internals.socket).not.toBe(oldSocket)
      expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
      expect(states).toEqual([true, false])
      expect(internals.reconnectAttempt).toBe(5) // not reset by the wake
      transport.dispose()
    })
  }

  it('rate-limits wake-triggered early attempts so a focus burst is not a connect storm', async () => {
    vi.useFakeTimers()
    DelayedOpenWebSocket.pending = []
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: DelayedOpenWebSocket as unknown as typeof WebSocket
    })
    const connecting = transport.connect()
    await Promise.resolve()
    const internals = transport as unknown as TransportInternals
    ;(internals.socket as DelayedOpenWebSocket).openAndAuthenticate()
    await connecting
    internals.reconnectAttempt = 3 // elevated so a self-fired timer cannot mask the wake
    internals.socket.close()

    window.dispatchEvent(new Event('focus')) // cuts the backoff → attempt starts
    expect(DelayedOpenWebSocket.pending).toHaveLength(2)
    // Further focus events join the in-flight handshake instead of adding sockets.
    window.dispatchEvent(new Event('focus'))
    expect(DelayedOpenWebSocket.pending).toHaveLength(2)

    // The attempt dies at once; the next backoff is pending. A focus within the
    // same second must NOT cut it short again…
    DelayedOpenWebSocket.pending[1].close()
    await Promise.resolve()
    expect(internals.reconnectTimer).not.toBeNull()
    window.dispatchEvent(new Event('focus'))
    expect(internals.reconnectTimer).not.toBeNull()
    expect(DelayedOpenWebSocket.pending).toHaveLength(2)

    // …but once the minimum spacing has elapsed a wake signal does.
    await vi.advanceTimersByTimeAsync(1_000)
    window.dispatchEvent(new Event('focus'))
    expect(DelayedOpenWebSocket.pending.length).toBeGreaterThanOrEqual(3)
    transport.dispose()
  })

  it('a resume signal revalidates in the resubscribe phase when the socket is no longer OPEN (CLI-F3)', async () => {
    vi.useFakeTimers()
    class HoldResubscribeSocket extends FakeWebSocket {
      static instances = 0
      holdSubscribe = false

      constructor(url: string) {
        super(url)
        HoldResubscribeSocket.instances += 1
        this.holdSubscribe = HoldResubscribeSocket.instances > 1
      }

      send(data: string): void {
        if (this.holdSubscribe && (JSON.parse(data) as { type: string }).type === 'subscribe') {
          this.sent.push(data)
          return
        }
        super.send(data)
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: HoldResubscribeSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.subscribeSession('sess-A')
    const internals = transport as unknown as TransportInternals
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(600) // reconnect: auth ok, resubscribe in flight
    expect(internals.reconnecting).toBe(true)
    expect(internals.connecting).toBeNull()
    expect(internals.reconnectTimer).toBeNull()

    // The OS dropped the socket without delivering `onclose`.
    const dead = internals.socket
    dead.readyState = FakeWebSocket.CLOSED
    window.dispatchEvent(new Event('online'))

    // Recovery starts now, not after the 15s resubscribe bound / 60s timer.
    expect(internals.socket).toBeNull()
    expect(dead.onclose).toBeNull()
    expect(internals.reconnectTimer).not.toBeNull()
    transport.dispose()
  })

  it('resets the backoff counter only after 60s of stable connection, not on connect', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const internals = transport as unknown as TransportInternals
    internals.socket.close()
    expect(internals.reconnectAttempt).toBe(1)

    await vi.advanceTimersByTimeAsync(600) // reconnected
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(internals.reconnectAttempt).toBe(1) // connect alone does not reset
    await vi.advanceTimersByTimeAsync(58_000)
    expect(internals.reconnectAttempt).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(internals.reconnectAttempt).toBe(0) // 60s stable
    transport.dispose()
  })

  it('a connection that drops before 60s keeps climbing the backoff ladder', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const internals = transport as unknown as TransportInternals
    internals.socket.close() // attempt 0 → 1, 500ms
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(30_000) // up for only 30s
    internals.socket.close() // flap: attempt 1 → 2, 1000ms
    expect(internals.reconnectAttempt).toBe(2)
    await vi.advanceTimersByTimeAsync(900)
    expect(internals.reconnectTimer).not.toBeNull() // 1s delay still pending
    await vi.advanceTimersByTimeAsync(200)
    expect(internals.reconnectTimer).toBeNull()
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    transport.dispose()
  })

  for (const [randomValue, delayMs] of [
    [0, 375],
    [1, 625]
  ] as const) {
    it(`reconnect delay carries ±25% jitter (random=${randomValue} → ${delayMs}ms)`, async () => {
      vi.useFakeTimers()
      vi.mocked(Math.random).mockReturnValue(randomValue)
      const transport = new WsAcpTransport({
        url: 'ws://test/ws',
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
      })
      await transport.connect()
      const internals = transport as unknown as TransportInternals
      internals.socket.close()
      await vi.advanceTimersByTimeAsync(delayMs - 1)
      expect(internals.reconnectTimer).not.toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(internals.reconnectTimer).toBeNull() // fired exactly at the jittered delay
      transport.dispose()
    })
  }

  // CLI-F4: upgrade + authenticate share one ~10 s handshake bound on /ws.
  it('fails a stalled /ws upgrade at the 10s handshake bound and re-arms the backoff', async () => {
    vi.useFakeTimers()
    DelayedOpenWebSocket.pending = []
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: DelayedOpenWebSocket as unknown as typeof WebSocket
    })
    const internals = transport as unknown as TransportInternals
    let failure: unknown
    void transport.connect().catch((error) => {
      failure = error
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(failure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(failure).toMatchObject({ code: 'timeout' })
    expect(internals.socket).toBeNull()
    expect(DelayedOpenWebSocket.pending[0].readyState).toBe(FakeWebSocket.CLOSED)
    expect(internals.reconnectTimer).not.toBeNull()
    transport.dispose()
  })

  it('fails an unanswered authenticate at the 10s handshake bound', async () => {
    vi.useFakeTimers()
    class AuthSilentSocket extends DelayedOpenWebSocket {
      send(data: string): void {
        if ((JSON.parse(data) as { type: string }).type === 'authenticate') {
          this.sent.push(data)
          return
        }
        super.send(data)
      }
    }
    DelayedOpenWebSocket.pending = []
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: AuthSilentSocket as unknown as typeof WebSocket
    })
    const internals = transport as unknown as TransportInternals
    let failure: unknown
    void transport.connect().catch((error) => {
      failure = error
    })
    await Promise.resolve()
    DelayedOpenWebSocket.pending[0].openAndAuthenticate()
    await vi.advanceTimersByTimeAsync(9_900)
    expect(failure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(100)
    expect(failure).toMatchObject({ code: 'timeout' })
    expect(internals.socket).toBeNull()
    expect(internals.reconnectTimer).not.toBeNull()
    transport.dispose()
  })

  // CLI-F2: per-type timers, each >= the host's own bound for that operation.
  it('keeps install_acp_agent pending past the former 60s timer and times out at 330s', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const origSend = sock.send.bind(sock)
    sock.send = (data: string) => {
      if ((JSON.parse(data) as { type: string }).type === 'install_acp_agent') return
      origSend(data)
    }
    let settled: unknown
    void transport.installAcpAgent('agent-1').then(
      (v) => {
        settled = { ok: v }
      },
      (err) => {
        settled = { err }
      }
    )
    await vi.advanceTimersByTimeAsync(300_000) // host bound: 120s download + 180s child
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toMatchObject({ err: expect.objectContaining({ code: 'timeout' }) })
    sock.send = origSend
    transport.dispose()
  })

  it('keeps create_session pending through the 60s host cap and times out at 90s', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    const origSend = sock.send.bind(sock)
    sock.send = (data: string) => {
      if ((JSON.parse(data) as { type: string }).type === 'create_session') return
      origSend(data)
    }
    let settled: unknown
    void transport.newSession('agent-1', '/tmp', undefined, { ephemeral: true }).then(
      (v) => {
        settled = { ok: v }
      },
      (err) => {
        settled = { err }
      }
    )
    await vi.advanceTimersByTimeAsync(60_000) // server SESSION_NEW_TIMEOUT: the reply would land here
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toMatchObject({ err: expect.objectContaining({ code: 'timeout' }) })
    sock.send = origSend
    transport.dispose()
  })

  it('drops a permanently obsolete not_found subscription and completes reconnect', async () => {
    vi.useFakeTimers()
    class ReconnectSubscribeFailureSocket extends FakeWebSocket {
      static instances = 0

      constructor(url: string) {
        super(url)
        ReconnectSubscribeFailureSocket.instances += 1
        if (ReconnectSubscribeFailureSocket.instances > 1) {
          this.failSubscribeSessions.add('sess-fail')
        }
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: ReconnectSubscribeFailureSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.subscribeSession('sess-fail')
    const states: boolean[] = []
    transport.setReconnectListener((state) => states.push(state))
    const internals = transport as unknown as TransportInternals
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(600)

    expect(states).toEqual([true, false])
    expect(internals.subscribed.has('sess-fail')).toBe(false)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'WsAcpTransport.reconnect',
        message: expect.stringContaining('Dropped obsolete')
      })
    )
    transport.dispose()
  })

  it('keeps the socket and the other sessions up while one failing session retries alone, then degrades it to snapshot recovery (CLI-F1)', async () => {
    vi.useFakeTimers()
    class OneSessionFailsSocket extends FakeWebSocket {
      static instances = 0

      constructor(url: string) {
        super(url)
        OneSessionFailsSocket.instances += 1
        if (OneSessionFailsSocket.instances === 2) {
          this.subscribeFailureCodes.set('sess-slow', 'closed')
        }
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: OneSessionFailsSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.subscribeSession('sess-slow')
    await transport.subscribeSession('sess-ok')
    const states: boolean[] = []
    transport.setReconnectListener((state) => states.push(state))
    const internals = transport as unknown as TransportInternals
    internals.socket.close()

    // The pass completes: sess-ok re-subscribed, sess-slow handed to its own
    // retry. The reconnect is NOT failed and the socket is NOT torn down.
    await vi.advanceTimersByTimeAsync(700)
    expect(states).toEqual([true, false])
    const kept = internals.socket
    expect(kept.readyState).toBe(FakeWebSocket.OPEN)
    expect(internals.reconnectTimer).toBeNull()
    const subscribesFor = (sid: string) =>
      kept.sent
        .map((raw) => JSON.parse(raw) as { type: string; payload: { sessionId?: string } })
        .filter((req) => req.type === 'subscribe' && req.payload.sessionId === sid)
    expect(subscribesFor('sess-ok')).toHaveLength(1)
    expect(subscribesFor('sess-slow')).toHaveLength(1)

    // Two more cursor retries (1s, 2s backoff) keep failing on the same socket.
    await vi.advanceTimersByTimeAsync(1_100)
    await vi.advanceTimersByTimeAsync(2_100)
    expect(subscribesFor('sess-slow')).toHaveLength(3)
    expect(internals.socket).toBe(kept)
    expect(subscribesFor('sess-ok')).toHaveLength(1) // other sessions untouched

    // The next attempt (4s) degrades to snapshot + live recovery.
    await vi.advanceTimersByTimeAsync(4_100)
    expect(findSentRequest(kept, 'recover_session_snapshot')?.payload).toMatchObject({
      sessionId: 'sess-slow'
    })
    expect(internals.socket).toBe(kept)
    expect(internals.subscribed.has('sess-slow')).toBe(true)
    expect(internals.lastSeq.get('sess-slow')).toBe(42) // snapshot watermark adopted
    transport.dispose()
  })
})

describe('WsAcpTransport half-open socket during the resubscribe pass', () => {
  afterEach(() => {
    _resetAcpTransportForTests(null)
    vi.useRealTimers()
  })

  it('probes after the first per-session timeout and tears down a dead socket instead of stalling N x 15s', async () => {
    vi.useFakeTimers()
    class HalfOpenOnReconnectSocket extends FakeWebSocket {
      static instances: HalfOpenOnReconnectSocket[] = []

      constructor(url: string) {
        super(url)
        HalfOpenOnReconnectSocket.instances.push(this)
        if (HalfOpenOnReconnectSocket.instances.length === 2) {
          // The reconnected socket authenticates, then goes silent (half-open).
          this.holdSubscribe = true
          this.holdPing = true
        }
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: HalfOpenOnReconnectSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    for (const sid of ['sess-1', 'sess-2', 'sess-3']) await transport.subscribeSession(sid)
    const internals = transport as unknown as TransportInternals
    internals.socket.close()
    // Backoff (<=~700ms) + one 15s subscribe timeout + one 5s probe timeout.
    await vi.advanceTimersByTimeAsync(700)
    const halfOpen = internals.socket
    expect(HalfOpenOnReconnectSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(15_000 + 5_000 + 100)

    // Without the probe the pass would still be waiting on sess-2/sess-3 (45s).
    expect(halfOpen.readyState).toBe(FakeWebSocket.CLOSED)
    const subscribes = halfOpen.sent
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((req) => req.type === 'subscribe')
    expect(subscribes).toHaveLength(1)
    expect(internals.reconnectTimer).not.toBeNull() // backoff re-armed, pass failed as a connection error
    transport.dispose()
  })

  it('a timed-out session on a socket that still answers pings keeps the socket and retries alone', async () => {
    vi.useFakeTimers()
    class SlowSubscribeSocket extends FakeWebSocket {
      static instances: SlowSubscribeSocket[] = []

      constructor(url: string) {
        super(url)
        SlowSubscribeSocket.instances.push(this)
        if (SlowSubscribeSocket.instances.length === 2) this.holdSubscribe = true
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: SlowSubscribeSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.subscribeSession('sess-1')
    const internals = transport as unknown as TransportInternals
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(700)
    const kept = internals.socket
    await vi.advanceTimersByTimeAsync(15_000 + 100)
    // Ping answered → healthy socket: not torn down.
    expect(kept.readyState).toBe(FakeWebSocket.OPEN)
    expect(internals.socket).toBe(kept)
    transport.dispose()
  })
})

describe('WsAcpTransport background/foreground lifecycle signals (CAP-3)', () => {
  afterEach(() => {
    restoreVisibility()
    _resetAcpTransportForTests(null)
    vi.useRealTimers()
  })

  /** True if a raw frame of the given type was sent on the socket. */
  const sentType = (sock: FakeWebSocket, type: string): boolean =>
    sock.sent.some((raw) => {
      try {
        return (JSON.parse(raw) as { type?: string }).type === type
      } catch {
        return false
      }
    })

  it('sends a background frame on tab hide and foreground on return', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.subscribeSession('sess-cap3')
    const internals = transport as unknown as TransportInternals
    const socket = internals.socket

    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sentType(socket, 'background')).toBe(true)

    dispatchVisibility('visible')
    await Promise.resolve()
    expect(sentType(socket, 'foreground')).toBe(true)

    transport.dispose()
  })

  it('does not send lifecycle signals before authentication completes', async () => {
    vi.useFakeTimers()
    DelayedOpenWebSocket.pending = []
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: DelayedOpenWebSocket as unknown as typeof WebSocket
    })
    const connecting = transport.connect()
    await Promise.resolve()
    const internals = transport as unknown as TransportInternals
    const openingSocket = internals.socket as DelayedOpenWebSocket

    // While CONNECTING (not OPEN, not authed), hide must not send background.
    dispatchVisibility('hidden')
    expect(sentType(openingSocket, 'background')).toBe(false)

    openingSocket.openAndAuthenticate()
    await connecting
    transport.dispose()
  })

  it('does not send lifecycle signals after dispose', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.subscribeSession('sess-cap3')
    const internals = transport as unknown as TransportInternals
    const socket = internals.socket
    transport.dispose()

    dispatchVisibility('hidden')
    expect(sentType(socket, 'background')).toBe(false)
  })

  it('sends a background signal when initial authentication completes while hidden', async () => {
    vi.useFakeTimers()
    DelayedOpenWebSocket.pending = []
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: DelayedOpenWebSocket as unknown as typeof WebSocket
    })
    const connecting = transport.connect()
    await Promise.resolve()
    const internals = transport as unknown as TransportInternals
    const openingSocket = internals.socket as DelayedOpenWebSocket

    // Hidden BEFORE auth completes — the hide handler's background signal was
    // a no-op (not authed). Auth-completion must re-sync the server watchdog.
    dispatchVisibility('hidden')
    expect(sentType(openingSocket, 'background')).toBe(false)

    openingSocket.openAndAuthenticate()
    await connecting
    expect(sentType(openingSocket, 'background')).toBe(true)
    transport.dispose()
  })

  it('sends a background signal when reconnection authentication completes while hidden', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    await transport.subscribeSession('sess-cap3b')
    const internals = transport as unknown as TransportInternals
    const oldSocket = internals.socket

    // Tab hidden, then the server kills the socket → the reconnect's new
    // socket authenticates while still hidden → server watchdog re-synced.
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(1_000)
    oldSocket.close()
    await vi.advanceTimersByTimeAsync(3_000)
    await Promise.resolve()

    const newSocket = internals.socket
    expect(newSocket).not.toBe(oldSocket)
    expect(sentType(newSocket, 'background')).toBe(true)
    transport.dispose()
  })
})

describe('agent_auth_required transport parity (story 7 frozen contract)', () => {
  it('WS create_session agent_auth_required reply classifies as an auth setup error', async () => {
    // Story-7 servers tag agent-side auth failures on session/new with the
    // additive `agent_auth_required` reply code. The literal wire string is
    // pinned here (not the exported constant) so a spelling drift fails this
    // test — same pinning as the acp-store.test.ts twin.
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.createSessionErr = { code: 'agent_auth_required', message: 'Authentication required' }

    const err = await transport.newSession('a1', '/work').then(
      () => {
        throw new Error('newSession unexpectedly resolved')
      },
      (e: unknown) => e
    )

    // The WS reply code survives as AcpTransportError.code and classifies as
    // auth via the explicit-code path (beats message-pattern classification).
    expect(err).toBeInstanceOf(AcpTransportError)
    expect((err as AcpTransportError).code).toBe('agent_auth_required')
    const classified = classifySetupError(err)
    expect(classified.category).toBe('auth')
    expect(classified.detail).toBe('Authentication required')

    transport.dispose()
  })

  it('Tauri acp_new_session flattened string rejection classifies as an auth setup error', async () => {
    // Desktop parity: the Tauri command returns Result<_, String>, so invoke
    // rejects with the bare Rust error string — no Error instance, no .code
    // (a session/new auth_required failure flattens to the acp Error Display
    // message, "Authentication required"). Classification must still land on
    // `auth` via the message-pattern fallback.
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockRejectedValueOnce('Authentication required')
    const transport = createAcpTransport({ force: 'tauri' })

    const err = await transport.newSession('a1', '/work').then(
      () => {
        throw new Error('newSession unexpectedly resolved')
      },
      (e: unknown) => e
    )

    // The desktop path surfaces the flattened string verbatim…
    expect(err).toBe('Authentication required')
    // …and still classifies as an auth setup error without a coded error.
    const classified = classifySetupError(err)
    expect(classified.category).toBe('auth')
    expect(classified.detail).toBe('Authentication required')

    transport.dispose()
  })
})

describe('createAcpTransport selection', () => {
  beforeEach(() => {
    _resetAcpTransportForTests(null)
  })

  it('desktop transports a successful option change without a snapshot', async () => {
    vi.mocked(invoke).mockResolvedValue(null)
    const transport = createAcpTransport({ force: 'tauri' })
    await expect(transport.setConfigOption('a1', 's1', 'model', 'm2')).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledWith('acp_set_config_option', {
      agentId: 'a1',
      sessionId: 's1',
      configId: 'model',
      valueId: 'm2'
    })
    transport.dispose()
  })

  it('desktop load/resume return the typed Tauri invoke outcome', async () => {
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

  it('desktop recordAgentSwitch invokes acp_record_agent_switch with the exact five camelCase keys', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    const transport = createAcpTransport({ force: 'tauri' })

    // CAP-2: the durable agent-switch marker — the desktop adapter must
    // forward every identity field the command validates.
    await expect(
      transport.recordAgentSwitch('s-old', {
        fromConfigId: 'omp',
        toConfigId: 'claude',
        newSessionId: 's-new',
        summaryText: 'Handoff summary'
      })
    ).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('acp_record_agent_switch', {
      sessionId: 's-old',
      fromConfigId: 'omp',
      toConfigId: 'claude',
      newSessionId: 's-new',
      summaryText: 'Handoff summary'
    })
    transport.dispose()
  })

  it('desktop promoteSession invokes acp_promote_session and resolves on success', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    const transport = createAcpTransport({ force: 'tauri' })

    // Story 8: the desktop path delegates promotion to the Rust driver via
    // `acp_promote_session` — a successful command resolves with no payload.
    await expect(transport.promoteSession?.('a1', 's1')).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('acp_promote_session', {
      agentId: 'a1',
      sessionId: 's1'
    })
    transport.dispose()
  })

  it('desktop promoteSession propagates a failed promotion outcome', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('failed to persist promoted session: disk full'))
    const transport = createAcpTransport({ force: 'tauri' })

    // A backend promote failure must reject so the store can re-mark the
    // session ephemeral and warn the user (chat stays non-durable).
    await expect(transport.promoteSession?.('a1', 's1')).rejects.toThrow(
      'failed to persist promoted session'
    )
    expect(invoke).toHaveBeenCalledWith('acp_promote_session', {
      agentId: 'a1',
      sessionId: 's1'
    })
    transport.dispose()
  })

  it('desktop sendPrompt/sendPromptBlocks forward the client turnId to acp_send_prompt', async () => {
    vi.mocked(invoke).mockResolvedValue('end_turn')
    const transport = createAcpTransport({ force: 'tauri' })

    // The durable `user_prompt` record must carry the client-minted turnId so
    // the restored bubble materializes `turn:<turnId>` — id-matching the
    // optimistic bubble scroll-up backfill anchors on (web parity; a dropped
    // turnId left the twin as `user:seq-*` and duplicated the first prompt).
    await expect(transport.sendPrompt('a1', 's1', 'hello', 'turn-1')).resolves.toBe('end_turn')
    expect(invoke).toHaveBeenCalledWith('acp_send_prompt', {
      agentId: 'a1',
      sessionId: 's1',
      text: 'hello',
      turnId: 'turn-1',
      displayContent: undefined
    })

    await expect(
      transport.sendPromptBlocks('a1', 's1', [{ type: 'text', text: 'hi' }], 'turn-2')
    ).resolves.toBe('end_turn')
    expect(invoke).toHaveBeenCalledWith('acp_send_prompt', {
      agentId: 'a1',
      sessionId: 's1',
      content: [{ type: 'text', text: 'hi' }],
      turnId: 'turn-2',
      displayContent: undefined
    })
    transport.dispose()
  })

  it('desktop listAgentDetails invokes acp_list_agent_details (CAP-11 parity)', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const summaries = [
      {
        id: 'a1',
        name: 'Claude',
        configId: 'claude',
        namespace: 'config:claude',
        capabilities: { loadSession: true }
      }
    ]
    vi.mocked(invoke).mockResolvedValue(summaries)
    const transport = createAcpTransport({ force: 'tauri' })

    await expect(transport.listAgentDetails?.()).resolves.toEqual(summaries)
    expect(invoke).toHaveBeenCalledWith('acp_list_agent_details')
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

describe('reopen admission failure parity (ACP_REOPEN_TURN_ACTIVE)', () => {
  beforeEach(() => {
    _resetAcpTransportForTests(null)
  })

  it('desktop load/resume surface the admission rejection and recover on retry', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const transport = createAcpTransport({ force: 'tauri' })
    // The desktop command rejects the IPC promise with the manager's plain
    // error string (Result<_, String>).
    vi.mocked(invoke).mockRejectedValueOnce('ACP_REOPEN_TURN_ACTIVE: session s1')
    await expect(transport.loadSession('a1', 's1', '/work')).rejects.toContain(
      'ACP_REOPEN_TURN_ACTIVE'
    )
    vi.mocked(invoke).mockRejectedValueOnce('ACP_REOPEN_TURN_ACTIVE: session s1')
    await expect(transport.resumeSession('a1', 's1', '/work')).rejects.toContain(
      'ACP_REOPEN_TURN_ACTIVE'
    )

    // Caller recovery: once the active turn finishes, the identical retry succeeds.
    const outcome = { configOptions: [] }
    vi.mocked(invoke).mockResolvedValue(outcome)
    await expect(transport.loadSession('a1', 's1', '/work')).resolves.toEqual(outcome)
    await expect(transport.resumeSession('a1', 's1', '/work')).resolves.toEqual(outcome)
    transport.dispose()
  })

  it('ws load/resume surface the admission rejection and recover on retry', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    // The host maps the manager's admission rejection through
    // acp_err_to_reply: a generic wire code carrying the full
    // ACP_REOPEN_TURN_ACTIVE message.
    sock.reopenFailure = {
      code: 'not_implemented',
      message: 'ACP_REOPEN_TURN_ACTIVE: session s1'
    }

    const loadAttempt = transport.loadSession('a1', 's1', '/work')
    await expect(loadAttempt).rejects.toBeInstanceOf(AcpTransportError)
    await expect(loadAttempt).rejects.toThrow('ACP_REOPEN_TURN_ACTIVE')
    // A rejected reopen must NOT subscribe the session (no replay boundary is
    // established for a reopen that never started).
    expect(sock.sent.map((frame) => (JSON.parse(frame) as { type: string }).type)).not.toContain(
      'subscribe'
    )

    const resumeAttempt = transport.resumeSession('a1', 's1', '/work')
    await expect(resumeAttempt).rejects.toBeInstanceOf(AcpTransportError)
    await expect(resumeAttempt).rejects.toThrow('ACP_REOPEN_TURN_ACTIVE')

    // Caller recovery: clearing the failure lets the identical retry succeed.
    sock.reopenFailure = null
    await expect(transport.loadSession('a1', 's1', '/work')).resolves.toEqual(sock.reopenOutcome)
    await expect(transport.resumeSession('a1', 's1', '/work')).resolves.toEqual(sock.reopenOutcome)
    transport.dispose()
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

describe('WsAcpTransport web auth token presentation (CAP-1)', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('presents the resolved web auth token on the relay authenticate frame', async () => {
    window.localStorage.setItem('termul.webAuthToken', 's3cret-token')
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    // Test-only reach into the transport's live fake socket.
    const internals = transport as unknown as { socket: FakeWebSocket }
    const sent = internals.socket.sent.map((s) => {
      const frame = JSON.parse(s) as { type: string; payload: { token?: string } }
      return frame
    })
    const authReq = sent.find((r) => r.type === 'authenticate')
    expect(authReq, 'an authenticate frame must be sent').toBeTruthy()
    expect(authReq?.payload.token).toBe('s3cret-token')
    transport.dispose()
  })

  it("falls back to the legacy 'dev' placeholder when no token is known", async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const internals = transport as unknown as { socket: FakeWebSocket }
    const sent = internals.socket.sent.map((s) => {
      const frame = JSON.parse(s) as { type: string; payload: { token?: string } }
      return frame
    })
    const authReq = sent.find((r) => r.type === 'authenticate')
    expect(authReq?.payload.token).toBe('dev')
    transport.dispose()
  })

  it('sends the full versioned handshake payload on every (re)handshake', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    // The fake host validates version + identity; connect() only resolves for
    // a valid payload.
    await transport.connect()
    const internals = transport as unknown as { socket: FakeWebSocket }
    const authReq = internals.socket.sent
      .map((s) => JSON.parse(s) as { type: string; payload: Record<string, unknown> })
      .find((r) => r.type === 'authenticate')
    expect(authReq?.payload).toEqual({
      token: 'dev',
      protocolVersion: WS_PROTOCOL_VERSION,
      deviceId: window.localStorage.getItem('termul.deviceId'),
      clientInstanceId: window.sessionStorage.getItem('termul.clientInstanceId')
    })
    transport.dispose()
  })
})

// AD-15: a stale protocol / bad identity can never be fixed by retrying.
describe('WsAcpTransport versioned handshake refusals (AD-15)', () => {
  function refusedBy(code: string): typeof WebSocket {
    return class extends FakeWebSocket {
      constructor(url: string) {
        super(url)
        this.authRefusalCode = code
      }
    } as unknown as typeof WebSocket
  }

  beforeEach(() => {
    protocolReloadRef.handle.mockClear()
    vi.mocked(flagWebAuthUnauthorized).mockClear()
    vi.mocked(logFrontendError).mockClear()
  })

  afterEach(() => {
    _resetAcpTransportForTests(null)
    vi.useRealTimers()
  })

  it('protocol_version_mismatch halts reconnect, reloads once via the helper, and never flags the token gate', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: refusedBy('protocol_version_mismatch')
    })
    const states: string[] = []
    transport.setConnectionStateListener((state) => states.push(state))
    const internals = transport as unknown as TransportInternals

    // The first rejection may carry the transport-level 'closed' (the fake's
    // synchronous close races the refusal, same as the #907 token halt); the
    // halt itself is the contract, and later connect() calls name the cause.
    await expect(transport.connect()).rejects.toBeInstanceOf(AcpTransportError)
    expect(protocolReloadRef.handle).toHaveBeenCalledTimes(1)
    expect(protocolReloadRef.handle).toHaveBeenCalledWith('WsAcpTransport')
    expect(vi.mocked(flagWebAuthUnauthorized)).not.toHaveBeenCalled()
    expect(states[states.length - 1]).toBe('disconnected')
    expect(states).not.toContain('reconnecting')
    expect(internals.reconnectTimer).toBeNull()

    // Nothing re-arms and later connect() calls refuse without a new socket
    // or a second reload request.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(internals.reconnectTimer).toBeNull()
    await expect(transport.connect()).rejects.toMatchObject({
      code: 'protocol_version_mismatch'
    })
    expect(internals.socket).toBeNull()
    expect(protocolReloadRef.handle).toHaveBeenCalledTimes(1)
    transport.dispose()
  })

  it('invalid_client_identity is non-retryable and never reloads', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: refusedBy('invalid_client_identity')
    })
    const internals = transport as unknown as TransportInternals

    await expect(transport.connect()).rejects.toBeInstanceOf(AcpTransportError)
    await expect(transport.connect()).rejects.toMatchObject({
      code: 'invalid_client_identity'
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(protocolReloadRef.handle).not.toHaveBeenCalled()
    expect(internals.reconnectTimer).toBeNull()
    expect(vi.mocked(logFrontendError)).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'WsAcpTransport.handshake', level: 'error' })
    )
    transport.dispose()
  })
})

// reconnect transitions only) — this one also covers the initial connect.
describe('WsAcpTransport connection-state listener (Story 10)', () => {
  afterEach(() => {
    _resetAcpTransportForTests(null)
  })

  it('fires connecting → connected on the initial connect', async () => {
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    const states: string[] = []
    transport.setConnectionStateListener((state) => states.push(state))

    await transport.connect()
    expect(states).toEqual(['connecting', 'connected'])
    transport.dispose()
  })

  it('fires reconnecting on drop and connected on recovery — without flapping through connecting', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    const states: string[] = []
    transport.setConnectionStateListener((state) => states.push(state))
    await transport.connect()
    expect(states).toEqual(['connecting', 'connected'])

    const sock = (transport as unknown as { socket: FakeWebSocket }).socket
    sock.close()
    // Drop detected → scheduleReconnect fires 'reconnecting' synchronously.
    expect(states).toEqual(['connecting', 'connected', 'reconnecting'])

    // Backoff (500ms) → reconnect: openSocket stays silent about 'connecting'
    // (the reconnect cycle owns the state), then reconnect() fires 'connected'
    // only AFTER the (here: empty) session resubscribe pass succeeds.
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected'])

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

  it("reports 'connected' once the resubscribe pass completes even when one session fails — that session retries alone on the same socket (CLI-F1)", async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket
    })
    const states: string[] = []
    transport.setConnectionStateListener((state) => states.push(state))
    await transport.connect()
    await transport.subscribeSession('sess-x')
    expect(states).toEqual(['connecting', 'connected'])

    // The reconnect attempt's fresh socket fails the resubscribe with a
    // TRANSIENT code (not_found would prune the session as obsolete instead).
    FakeWebSocket.transientSubscribeFailuresOnNextSocket = { 'sess-x': 'unavailable' }
    const internals = transport as unknown as TransportInternals
    internals.socket.close()
    expect(states).toEqual(['connecting', 'connected', 'reconnecting'])

    // Backoff → reconnect: socket opens, auth handshake completes, the one
    // failing session is handed to its own retry — the socket is NOT torn down
    // and the channel is reported healthy.
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected'])
    expect(internals.reconnectTimer).toBeNull()
    const keptSocket = internals.socket
    expect(keptSocket.readyState).toBe(FakeWebSocket.OPEN)

    // The per-session retry recovers on the SAME socket once the host-side
    // condition clears.
    keptSocket.subscribeFailureCodes.clear()
    await vi.advanceTimersByTimeAsync(1_300)
    expect(internals.socket).toBe(keptSocket)
    expect(keptSocket.sent.filter((raw) => JSON.parse(raw).type === 'subscribe')).toHaveLength(2)
    expect(internals.subscribed.has('sess-x')).toBe(true)

    transport.dispose()
    vi.useRealTimers()
  })
})

// Issue #907 (F3): an `unauthorized` authenticate refusal is a TOKEN problem.
// The transport must stop the reconnect backoff loop (retrying the same
// token only churns), flag the web auth gate so the token-entry screen
// re-surfaces, and resume on the next connect after a token fix. Non-auth
// failures keep the existing backoff behavior.
describe('WsAcpTransport unauthorized authenticate halts reconnect churn (#907)', () => {
  /** Socket whose authenticate is refused with `unauthorized`. */
  class AuthRefusedWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url)
      this.authFail = true
    }
  }

  /** Socket whose auth handshake never completes (network-class failure):
   * opens, demands auth, then dies mid-handshake. */
  class DiesMidAuthWebSocket extends FakeWebSocket {
    static autoOpen = false
    static pending: DiesMidAuthWebSocket[] = []

    constructor(url: string) {
      super(url)
      this.readyState = FakeWebSocket.CONNECTING
      DiesMidAuthWebSocket.pending.push(this)
    }

    /** Open + demand auth, then close before the authenticate reply. */
    openThenCloseMidAuth(): void {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.(new Event('open'))
      this.emit({ sid: null, seq: 0, type: 'auth_required', payload: {} })
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.(new CloseEvent('close'))
    }
  }

  afterEach(() => {
    _resetAcpTransportForTests(null)
    vi.useRealTimers()
    window.localStorage.clear()
    gateStatusRef.current = 'ok'
  })

  it('stops the reconnect loop after one refused authenticate and flags the gate', async () => {
    vi.useFakeTimers()
    vi.mocked(flagWebAuthUnauthorized).mockClear()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: AuthRefusedWebSocket as unknown as typeof WebSocket
    })
    const internals = transport as unknown as TransportInternals & { tokenHalted: boolean }

    // The initial connect refuses authenticate → connect() rejects. The
    // visible code may be the transport-level 'closed' (the WS tears down
    // after the refusal), so assert the token-class outcome, not the code:
    // the halt flag + gate flag + zero re-arms are the observable contract.
    await expect(transport.connect()).rejects.toBeInstanceOf(AcpTransportError)
    expect(internals.tokenHalted).toBe(true)
    expect(vi.mocked(flagWebAuthUnauthorized)).toHaveBeenCalledWith('WsAcpTransport')
    // No reconnect timer may arm — the churn stops within one cycle.
    expect(internals.reconnectTimer).toBeNull()

    // Advance well past every backoff step (500ms → 8s): nothing re-opens.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(internals.reconnectTimer).toBeNull()
    expect(internals.socket).toBeNull()
    transport.dispose()
  })

  it('reports (false, recovered=false) when a reconnect cycle ends on the token halt, and (false, true) only after a real recovery', async () => {
    vi.useFakeTimers()
    let reject = false
    class RefuseOnReconnectWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url)
        this.authFail = reject
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: RefuseOnReconnectWebSocket as unknown as typeof WebSocket
    })
    await transport.connect()
    const calls: Array<[boolean, boolean | undefined]> = []
    transport.setReconnectListener((reconnecting, recovered) =>
      calls.push([reconnecting, recovered])
    )
    const internals = transport as unknown as TransportInternals

    // Drop → the reconnect handshake is refused (token halt): no recovery.
    reject = true
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toEqual([
      [true, undefined],
      [false, false]
    ])

    // Token fixed → a later reconnect that really recovers reports `true`.
    calls.length = 0
    gateStatusRef.current = 'ok'
    reject = false
    await transport.connect()
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toEqual([
      [true, undefined],
      [false, true]
    ])
    transport.dispose()
  })

  it('reports the channel disconnected instead of spinning reconnecting', async () => {
    vi.useFakeTimers()
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: AuthRefusedWebSocket as unknown as typeof WebSocket
    })
    const states: string[] = []
    transport.setConnectionStateListener((state) => states.push(state))

    await expect(transport.connect()).rejects.toBeInstanceOf(AcpTransportError)

    // connecting (fresh connect) → disconnected (token-class halt). Never a
    // reconnecting spinner: the user must enter a token, not wait out a retry.
    expect(states[states.length - 1]).toBe('disconnected')
    expect(states).not.toContain('reconnecting')
    transport.dispose()
  })

  it('recovers on the next connect after the token is fixed', async () => {
    vi.useFakeTimers()
    window.localStorage.setItem('termul.webAuthToken', 'good-token')
    let refused = true
    class FirstRefusedThenOkWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url)
        this.authFail = refused
      }
    }
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: FirstRefusedThenOkWebSocket as unknown as typeof WebSocket
    })
    const internals = transport as unknown as TransportInternals & { tokenHalted: boolean }

    // Boot with the bad token: refused → halted.
    await expect(transport.connect()).rejects.toBeInstanceOf(AcpTransportError)
    expect(internals.tokenHalted).toBe(true)

    // While the gate is still unauthorized, connect() stays dormant: it
    // throws WITHOUT opening a socket (the halt's hold side).
    gateStatusRef.current = 'unauthorized'
    const socketCountBefore = internals.socket
    await expect(transport.connect()).rejects.toMatchObject({
      code: 'unauthorized'
    })
    expect(internals.socket).toBe(socketCountBefore)

    // The user submits a valid token (the gate screen) — the next
    // request()→connect() retries normally and the handshake succeeds,
    // clearing the halt.
    gateStatusRef.current = 'ok'
    refused = false
    await expect(transport.listAgents()).resolves.toEqual([])
    expect(internals.tokenHalted).toBe(false)
    expect(internals.socket?.readyState).toBe(FakeWebSocket.OPEN)
    transport.dispose()
  })

  it('keeps backoff reconnects for non-auth handshake failures', async () => {
    vi.useFakeTimers()
    vi.mocked(flagWebAuthUnauthorized).mockClear()
    DiesMidAuthWebSocket.pending.length = 0
    const transport = new WsAcpTransport({
      url: 'ws://test/ws',
      WebSocketImpl: DiesMidAuthWebSocket as unknown as typeof WebSocket
    })
    const internals = transport as unknown as TransportInternals & { tokenHalted: boolean }

    // The socket dies mid-auth (network-class): the backoff loop must keep
    // re-arming and the gate must NOT be flagged.
    const connectPromise = transport.connect()
    await Promise.resolve()
    const first = DiesMidAuthWebSocket.pending.shift()
    first?.openThenCloseMidAuth()
    await expect(connectPromise).rejects.toThrow('WebSocket closed before auth')
    expect(internals.reconnectTimer).not.toBeNull()
    expect(internals.tokenHalted).toBe(false)
    expect(vi.mocked(flagWebAuthUnauthorized)).not.toHaveBeenCalled()

    // And the loop keeps trying: the next attempt opens a fresh socket.
    await vi.advanceTimersByTimeAsync(600)
    expect(DiesMidAuthWebSocket.pending.length).toBe(1)

    const timerField = transport as unknown as {
      reconnectTimer: ReturnType<typeof setTimeout> | null
    }
    if (timerField.reconnectTimer) {
      clearTimeout(timerField.reconnectTimer)
      timerField.reconnectTimer = null
    }
    transport.dispose()
  })
})
