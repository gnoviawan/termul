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

import type { PermissionRequestEvent } from '@/lib/acp-api'
import { PendingPermissionCoverage, readPendingPermissions } from './pending-permissions'
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

describe('readPendingPermissions', () => {
  it('returns null when the reply carries no list', () => {
    expect(readPendingPermissions(SID, { headSeq: 3 })).toBeNull()
    expect(readPendingPermissions(SID, undefined)).toBeNull()
  })

  it('keeps well-formed requests of the session and skips the rest', () => {
    const list = [request('perm-1'), request('perm-2', 'other'), { requestId: 'x' }, null]
    expect(readPendingPermissions(SID, { pendingPermissions: list })).toEqual([request('perm-1')])
    expect(readPendingPermissions(SID, { pendingPermissions: [] })).toEqual([])
  })
})

describe('PendingPermissionCoverage', () => {
  it('covers agent approvals at or below the head of a reply that carried a list', () => {
    const coverage = new PendingPermissionCoverage()
    const at = (seq: number, requestId = 'perm-1') => ({
      type: 'permission_request',
      seq,
      payload: { requestId }
    })
    expect(coverage.covers(SID, at(3))).toBe(false)
    coverage.note(SID, 5, true)
    expect(coverage.covers(SID, at(5))).toBe(true)
    expect(coverage.covers(SID, at(6)), 'live approvals are never covered').toBe(false)
    expect(coverage.covers(SID, { type: 'tool_call', seq: 2 })).toBe(false)
    expect(coverage.covers(SID, at(2, 'host:1')), 'host tickets are never listed').toBe(false)
    coverage.note(SID, 9, false)
    expect(coverage.covers(SID, at(3)), 'a reply without a list covers nothing').toBe(false)
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
  static headSeq = 5
  /** Cursors the host refuses `stale` (forces a snapshot). */
  static staleCursor = false

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
    const pending =
      PendingHost.pending === undefined ? {} : { pendingPermissions: PendingHost.pending }
    if (req.type === 'authenticate') {
      this.reply(req.id, { historyMode: 'server', runtimePolicy: {} })
    } else if (req.type === 'subscribe') {
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
  installed: Array<{ sessionId: string; requests: PermissionRequestEvent[] }>
  delivered: Array<{ requestId: string; seq?: number }>
}> {
  const transport = new WsAcpTransport({
    url: 'ws://test/ws',
    WebSocketImpl: PendingHost as unknown as typeof WebSocket
  })
  const installed: Array<{ sessionId: string; requests: PermissionRequestEvent[] }> = []
  transport.setPendingPermissionsHandler((sessionId, requests) =>
    installed.push({ sessionId, requests })
  )
  transport.setRecoveryHandler(async () => {})
  const delivered: Array<{ requestId: string; seq?: number }> = []
  transport.onEvent<PermissionRequestEvent>('acp:permission_request', (e, seq) =>
    delivered.push({ requestId: e.requestId, seq })
  )
  await transport.connect()
  return { transport, installed, delivered }
}

describe('WsAcpTransport pending approvals (issue #1595)', () => {
  afterEach(() => {
    PendingHost.pending = undefined
    PendingHost.headSeq = 5
    PendingHost.staleCursor = false
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
})
