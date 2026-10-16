/**
 * One protocol contract, two carriers (E6). The SAME fake host speaks the `/ws`
 * frames to a WebSocket-shaped carrier (`WsAcpTransport` over a fake socket) and
 * to the desktop's IPC Channel carrier (`DesktopAcpTransport` over `ChannelSocket`
 * with a faked `invoke` + `Channel`). Every case runs against both, so the
 * desktop provably speaks `/ws`: the handshake, reply-vs-echo order, ordered
 * `send_prompt` → `cancel_prompt`, lost-reply recovery by `commandId`, and
 * reconnect after the carrier closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// These suites exercise the real class, not the invoke-backed double from vitest.setup.ts.
vi.unmock('@/lib/acp-transport/desktop-transport')
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/web-auth-gate', () => ({
  flagWebAuthUnauthorized: vi.fn(),
  getWebAuthGateState: () => ({ status: 'ok', submitting: false })
}))
vi.mock('@/lib/web-protocol-reload', () => ({
  handleProtocolVersionMismatch: vi.fn(),
  clearProtocolMismatchLatch: vi.fn()
}))

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage: (raw: unknown) => void = () => {}
  }
}))

import { WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import { type AcpTransport, isOutcomeUncertainError, WsAcpTransport } from './acp-transport'
import { DesktopAcpTransport } from './acp-transport/desktop-transport'

// --- The fake host ----------------------------------------------------------

interface Frame {
  id: string
  type: string
  command_id?: string
  payload: Record<string, unknown>
}

interface HostConn {
  id: number
  received: Frame[]
  closedByClient: boolean
  ended: boolean
  emit(obj: unknown): void
  endByHost(code: number, reason: string): void
}

const RUNTIME_POLICY = {
  turnTimeoutMs: 3_600_000,
  promptInactivityTimeoutMs: 3_600_000,
  permissionReconnectGraceMs: 15_000,
  pingIntervalMs: 20_000,
  pongTimeoutMs: 75_000
}

/** A minimal relay: one handler per frame type, replies and events in emission order. */
class FakeHost {
  conns: HostConn[] = []
  authPayloads: Array<Record<string, unknown>> = []
  /** Frame types whose reply is withheld until `release(type)`. */
  hold = new Set<string>()
  private held: Array<{ conn: HostConn; id: string; type: string }> = []
  /** `command_id`s whose first run ends the connection before any reply (a lost reply). */
  dropReplyOnce = new Set<string>()

  open(wire: { emit(text: string): void; end(code: number, reason: string): void }): HostConn {
    const conn: HostConn = {
      id: this.conns.length + 1,
      received: [],
      closedByClient: false,
      ended: false,
      emit: (obj) => {
        if (!conn.ended) wire.emit(JSON.stringify(obj))
      },
      endByHost: (code, reason) => {
        if (conn.ended) return
        wire.end(code, reason)
        conn.ended = true
      }
    }
    this.conns.push(conn)
    return conn
  }

  /** The relay speaks first: `auth_required` is the first frame of every connection. */
  greet(conn: HostConn): void {
    conn.emit({ sid: null, seq: 0, type: 'auth_required', payload: {} })
  }

  onFrame(conn: HostConn, text: string): void {
    const frame = JSON.parse(text) as Frame
    conn.received.push(frame)
    const ok = (payload: unknown = {}) => conn.emit({ id: frame.id, ok: true, payload })

    if (frame.command_id && this.dropReplyOnce.delete(frame.command_id)) {
      conn.endByHost(1012, 'host restart')
      return
    }
    if (this.hold.has(frame.type)) {
      this.held.push({ conn, id: frame.id, type: frame.type })
      return
    }
    switch (frame.type) {
      case 'authenticate':
        this.authPayloads.push(frame.payload)
        ok({ historyMode: 'live_only', runtimePolicy: RUNTIME_POLICY })
        return
      case 'subscribe':
        ok({
          sessionId: frame.payload.sessionId,
          replayed: 0,
          logEpoch: 'epoch-A',
          headSeq: 0
        })
        return
      case 'send_prompt':
        // The durable echo is numbered before the reply, exactly like the relay.
        conn.emit({
          sid: frame.payload.sessionId,
          seq: 1,
          type: 'user_prompt',
          payload: { sessionId: frame.payload.sessionId, turnId: frame.payload.turnId }
        })
        ok('end_turn')
        return
      case 'list_agents':
        ok([])
        return
      case 'mark_chat_read':
        ok({ sessionId: frame.payload.sessionId, seq: 9 })
        return
      default:
        ok()
    }
  }

  release(type: string): void {
    this.hold.delete(type)
    const ready = this.held.filter((entry) => entry.type === type)
    this.held = this.held.filter((entry) => entry.type !== type)
    for (const entry of ready) {
      entry.conn.emit({
        id: entry.id,
        ok: true,
        payload: type === 'send_prompt' ? 'end_turn' : {}
      })
    }
  }

  framesOf(type: string): Frame[] {
    return this.conns.flatMap((conn) => conn.received).filter((frame) => frame.type === type)
  }
}

// --- Carriers ---------------------------------------------------------------

interface Carrier {
  name: string
  /** `authenticate` presents a token on the browser; the desktop's process boundary is the auth. */
  expectsToken: boolean
  expectedHistoryMode: string
  make(host: FakeHost): AcpTransport
}

/** A WebSocket-shaped carrier wired straight to the fake host. */
function webCarrier(): Carrier {
  return {
    name: 'WebSocket (WsAcpTransport)',
    expectsToken: true,
    expectedHistoryMode: 'live_only',
    make(host) {
      class HostSocket {
        static readonly CONNECTING = 0
        static readonly OPEN = 1
        static readonly CLOSING = 2
        static readonly CLOSED = 3
        readyState = 0
        onopen: ((ev: Event) => void) | null = null
        onmessage: ((ev: { data: string }) => void) | null = null
        onerror: ((ev: Event) => void) | null = null
        onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null
        private readonly conn: HostConn
        constructor(public readonly url: string) {
          this.conn = host.open({
            emit: (text) => this.onmessage?.({ data: text }),
            end: (code, reason) => {
              this.readyState = 3
              this.onclose?.({ code, reason, wasClean: true })
            }
          })
          queueMicrotask(() => {
            this.readyState = 1
            this.onopen?.(new Event('open'))
            host.greet(this.conn)
          })
        }
        send(text: string): void {
          host.onFrame(this.conn, text)
        }
        close(): void {
          if (this.readyState === 3) return
          this.conn.closedByClient = true
          this.conn.ended = true
          this.readyState = 3
          this.onclose?.({ code: 1000, reason: '', wasClean: true })
        }
      }
      return new WsAcpTransport({
        url: 'ws://test/ws',
        WebSocketImpl: HostSocket as unknown as typeof WebSocket
      })
    }
  }
}

/** The desktop carrier: `ws_channel_*` invokes + a Channel, served by the same host. */
function channelCarrier(): Carrier {
  return {
    name: 'IPC Channel (DesktopAcpTransport)',
    expectsToken: false,
    expectedHistoryMode: 'tauri_store',
    make(host) {
      const byId = new Map<number, HostConn>()
      ipc.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        if (command === 'ws_channel_open') {
          const channel = args.onFrame as { onmessage: (raw: unknown) => void }
          const conn = host.open({
            emit: (text) => channel.onmessage(text),
            end: (code, reason) =>
              channel.onmessage(JSON.stringify({ type: 'channel_closed', code, reason }))
          })
          byId.set(conn.id, conn)
          // The relay's first frame is already on the Channel when the id comes back.
          host.greet(conn)
          return conn.id
        }
        const conn = byId.get(args.connectionId as number)
        if (command === 'ws_channel_send') {
          if (!conn || conn.ended) throw 'unknown or closed connection'
          host.onFrame(conn, args.frame as string)
          return undefined
        }
        if (command === 'ws_channel_close' && conn) {
          conn.closedByClient = true
          conn.ended = true
        }
        return undefined
      })
      return new DesktopAcpTransport()
    }
  }
}

/** Await a condition that only microtask-driven carriers can satisfy. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await Promise.resolve()
  expect(condition()).toBe(true)
}

describe.each([webCarrier(), channelCarrier()])('/ws contract over $name', (carrier) => {
  let host: FakeHost
  let transport: AcpTransport

  beforeEach(() => {
    ipc.invoke.mockReset()
    host = new FakeHost()
    transport = carrier.make(host)
  })

  afterEach(() => {
    transport.dispose()
    vi.useRealTimers()
  })

  it('completes the authenticate handshake with the client identity and the carrier-appropriate token', async () => {
    await transport.connect()

    expect(host.authPayloads).toHaveLength(1)
    const payload = host.authPayloads[0]
    expect(payload.protocolVersion).toBe(WS_PROTOCOL_VERSION)
    expect(typeof payload.deviceId).toBe('string')
    expect(typeof payload.clientInstanceId).toBe('string')
    if (carrier.expectsToken) expect(payload.token).toBe('dev')
    else expect(payload).not.toHaveProperty('token')
    expect(transport.historyMode?.()).toBe(carrier.expectedHistoryMode)
  })

  it('delivers the durable user_prompt echo before the send_prompt reply resolves', async () => {
    const order: string[] = []
    transport.onEvent('acp:user_prompt', () => order.push('echo'))
    await transport.connect()

    await transport.sendPrompt('a1', 's1', 'hello', 'turn-1').then(() => order.push('reply'))
    await until(() => order.length === 2)

    expect(order).toEqual(['echo', 'reply'])
    expect(host.framesOf('send_prompt')[0].payload).toMatchObject({
      sessionId: 's1',
      text: 'hello',
      turnId: 'turn-1'
    })
  })

  it('delivers an events batch to subscribers in frame order', async () => {
    const seen: unknown[] = []
    transport.onEvent('acp:message_chunk', (payload) => seen.push(payload))
    await transport.connect()
    await transport.subscribeSession?.('s1')

    host.conns[0].emit({
      type: 'events',
      events: [
        { sid: 's1', seq: 1, type: 'message_chunk', payload: { n: 1 } },
        { sid: 's1', seq: 2, type: 'message_chunk', payload: { n: 2 } },
        { sid: 's1', seq: 3, type: 'message_chunk', payload: { n: 3 } }
      ]
    })
    await until(() => seen.length === 3)

    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('keeps send_prompt ahead of cancel_prompt on the wire', async () => {
    await transport.connect()
    await transport.subscribeSession?.('s1')
    host.hold.add('send_prompt')

    const prompt = transport.sendPrompt('a1', 's1', 'long task', 'turn-1')
    await until(() => host.framesOf('send_prompt').length === 1)
    await transport.cancelPrompt('a1', 's1')
    host.release('send_prompt')
    await expect(prompt).resolves.toBe('end_turn')

    const wire = host.conns[0].received.map((frame) => frame.type)
    expect(wire.indexOf('send_prompt')).toBeGreaterThan(-1)
    expect(wire.indexOf('send_prompt')).toBeLessThan(wire.indexOf('cancel_prompt'))
  })

  it('preserves the order of a burst of requests', async () => {
    await transport.connect()

    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`)
    await Promise.all(ids.map((id) => transport.closeSession('a1', id)))

    expect(host.framesOf('close_session').map((frame) => frame.payload.sessionId)).toEqual(ids)
  })

  it('recovers a lost reply by resending the SAME commandId on a fresh connection', async () => {
    vi.useFakeTimers()
    await transport.connect()
    host.dropReplyOnce.add('cmd-1')

    // The host ends the connection before answering: the outcome is unknown, never "rejected".
    const first = await transport.closeSession('a1', 's1', { commandId: 'cmd-1' }).catch((e) => e)
    expect(isOutcomeUncertainError(first)).toBe(true)

    await transport.closeSession('a1', 's1', { commandId: 'cmd-1' })

    const sends = host.framesOf('close_session')
    expect(sends.map((frame) => frame.command_id)).toEqual(['cmd-1', 'cmd-1'])
    expect(sends[0].id).not.toBe(sends[1].id)
    expect(host.conns).toHaveLength(2)
    expect(host.conns[1].received.map((frame) => frame.type)).toContain('close_session')
  })

  it('reconnects and re-authenticates after the host closes the carrier', async () => {
    vi.useFakeTimers()
    await transport.connect()
    const states: boolean[] = []
    transport.setReconnectListener?.((reconnecting) => states.push(reconnecting))

    host.conns[0].endByHost(1012, 'host restart')
    expect(states).toEqual([true])

    await vi.advanceTimersByTimeAsync(2_000)

    expect(states.at(-1)).toBe(false)
    expect(host.conns).toHaveLength(2)
    expect(host.authPayloads).toHaveLength(2)
    await expect(transport.listAgents()).resolves.toEqual([])
  })

  it('reports a chat read as mark_chat_read and resolves the host marker', async () => {
    await transport.connect()

    await expect(transport.markChatRead?.('s1', 4)).resolves.toEqual({ sessionId: 's1', seq: 9 })

    expect(host.framesOf('mark_chat_read').map((frame) => frame.payload)).toEqual([
      { sessionId: 's1', seq: 4 }
    ])
  })

  it('delivers the chat_reads watch state and deltas', async () => {
    const seen: unknown[] = []
    await transport.connect()
    transport.watches?.subscribe('chat_reads', {
      onState: (state) => seen.push(['state', state]),
      onDelta: (delta) => seen.push(['delta', delta])
    })
    await until(() => host.framesOf('watch').length === 1)
    expect(host.framesOf('watch')[0].payload).toEqual({ watch: 'chat_reads', scope: '' })

    const revision = (n: number) => ({ hostEpoch: 'h1', n })
    const frame = { type: 'watch', watch: 'chat_reads', scope: '' }
    host.conns[0].emit({ ...frame, revision: revision(1), reset: true, state: { marks: {} } })
    host.conns[0].emit({ ...frame, revision: revision(2), delta: { sessionId: 's1', seq: 6 } })
    await until(() => seen.length === 2)

    expect(seen).toEqual([
      ['state', { marks: {} }],
      ['delta', { sessionId: 's1', seq: 6 }]
    ])
  })

  it('releases its host connection when the transport is disposed', async () => {
    await transport.connect()

    transport.dispose()
    await until(() => host.conns[0].closedByClient)

    expect(host.conns[0].closedByClient).toBe(true)
  })
})
