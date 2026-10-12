/**
 * Tests for the web-mode persistence API (issue #613).
 *
 * Uses a fake WebSocket that speaks the minimal WS handshake
 * (`auth_required` → `authenticate`) and serves `store_read` / `store_write`
 * / `store_delete` from an in-memory map, mirroring the Rust `WebStore`.
 */

import { MAX_CLIENT_ID_LEN, WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebPersistenceApi } from '../web-persistence-api'

const mockHandleProtocolVersionMismatch = vi.hoisted(() => vi.fn())
vi.mock('../web-protocol-reload', () => ({
  handleProtocolVersionMismatch: mockHandleProtocolVersionMismatch,
  clearProtocolMismatchLatch: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

/**
 * Host-side handshake validation mirroring the Rust `/ws` `authenticate` arm:
 * version first, then identity. Returns the `err.code` or null when valid.
 */
function validateHandshake(payload: Record<string, unknown>): string | null {
  if (payload.protocolVersion !== WS_PROTOCOL_VERSION) return 'protocol_version_mismatch'
  for (const key of ['deviceId', 'clientInstanceId']) {
    const value = payload[key]
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

/** Test knob: force this refusal on every `authenticate` (null = validate). */
let forcedAuthRefusal: string | null = null

class FakeStoreSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3

  readyState = FakeStoreSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  sent: string[] = []
  closed = false
  /** Handshake stall injection: 'upgrade' never opens; 'authenticate' never answers. */
  static stall: 'none' | 'upgrade' | 'authenticate' = 'none'
  store = new Map<string, unknown>()
  /** When set, every non-auth request replies with this error. */
  failCode: string | null = null

  constructor(public url: string) {
    if (FakeStoreSocket.stall === 'upgrade') return
    queueMicrotask(() => {
      this.readyState = FakeStoreSocket.OPEN
      this.onopen?.(new Event('open'))
      this.emit({ type: 'auth_required', payload: {} })
    })
  }

  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
  }

  send(data: string): void {
    this.sent.push(data)
    const req = JSON.parse(data) as {
      id: string
      type: string
      payload: { key?: string; value?: unknown }
    }
    if (req.type === 'authenticate') {
      if (FakeStoreSocket.stall === 'authenticate') return
      const refusal = forcedAuthRefusal ?? validateHandshake(req.payload as Record<string, unknown>)
      if (refusal) {
        this.emit({ id: req.id, ok: false, err: { code: refusal, message: refusal } })
        return
      }
      this.emit({ id: req.id, ok: true, payload: {} })
      return
    }
    if (this.failCode) {
      this.emit({ id: req.id, ok: false, err: { code: this.failCode, message: 'store failed' } })
      return
    }
    const key = req.payload.key as string
    if (req.type === 'store_read') {
      this.emit({ id: req.id, ok: true, payload: { value: this.store.get(key) ?? null } })
      return
    }
    if (req.type === 'store_write') {
      this.store.set(key, req.payload.value)
      this.emit({ id: req.id, ok: true, payload: {} })
      return
    }
    if (req.type === 'store_delete') {
      const existed = this.store.delete(key)
      this.emit({ id: req.id, ok: true, payload: { existed } })
      return
    }
    this.emit({ id: req.id, ok: false, err: { code: 'not_implemented', message: 'unknown' } })
  }

  close(): void {
    this.closed = true
  }
}

const okVoid = { success: true, data: undefined }

describe('createWebPersistenceApi', () => {
  let sockets: FakeStoreSocket[]
  let api: ReturnType<typeof createWebPersistenceApi>

  beforeEach(() => {
    sockets = []
    class TrackerSocket extends FakeStoreSocket {
      constructor(url: string) {
        super(url)
        sockets.push(this)
      }
    }
    api = createWebPersistenceApi({ WebSocketImpl: TrackerSocket as unknown as typeof WebSocket })
  })

  afterEach(() => {
    vi.useRealTimers()
    forcedAuthRefusal = null
    mockHandleProtocolVersionMismatch.mockClear()
  })

  it('read returns KEY_NOT_FOUND for a missing key', async () => {
    const result = await api.read('settings')
    expect(result).toEqual({
      success: false,
      error: 'Key not found: settings',
      code: 'KEY_NOT_FOUND'
    })
  })

  it('read unwraps a versioned value written by write', async () => {
    await api.write('settings', { theme: 'dark' })
    const result = await api.read<{ theme: string }>('settings')
    expect(result).toEqual({ success: true, data: { theme: 'dark' } })
  })

  it('write persists a versioned payload to the server', async () => {
    const result = await api.write('settings', { theme: 'dark' })
    expect(result).toEqual(okVoid)
    const stored = sockets[0].store.get('settings') as { _version: number; data: unknown }
    expect(stored).toEqual({ _version: 1, data: { theme: 'dark' } })
  })

  it('delete removes a key', async () => {
    await api.write('k', 1)
    const result = await api.delete('k')
    expect(result).toEqual(okVoid)
    expect(sockets[0].store.has('k')).toBe(false)
  })

  it('writeDebounced coalesces rapid writes into a single store_write', async () => {
    vi.useFakeTimers()
    const p1 = api.writeDebounced('k', 1)
    const p2 = api.writeDebounced('k', 2)
    await vi.advanceTimersByTimeAsync(500)
    await expect(p1).resolves.toEqual(okVoid)
    await expect(p2).resolves.toEqual(okVoid)

    const writes = sockets[0].sent.filter((s) => JSON.parse(s).type === 'store_write')
    expect(writes).toHaveLength(1)
    const stored = JSON.parse(writes[0]).payload.value as { data: unknown }
    expect(stored.data).toBe(2)
  })

  it('flushPendingWrites flushes immediately', async () => {
    vi.useFakeTimers()
    const p = api.writeDebounced('k', { a: 1 })
    const result = await api.flushPendingWrites()
    expect(result).toEqual(okVoid)
    await expect(p).resolves.toEqual(okVoid)
    expect(sockets[0].store.get('k')).toEqual({ _version: 1, data: { a: 1 } })
  })

  it('maps a server error code into the IpcResult', async () => {
    // Warm the socket (connect is lazy) before arming the failure.
    await api.read('warmup')
    sockets[0].failCode = 'STORE_UNAVAILABLE'
    const result = await api.write('k', 1)
    expect(result).toEqual({
      success: false,
      error: 'store failed',
      code: 'STORE_UNAVAILABLE'
    })
  })
  // CAP-1 interim gate: the store socket must present the resolved web auth
  // token on its `authenticate` frame — a gated server refuses 'dev'.
  describe('web auth token presentation', () => {
    afterEach(() => {
      window.localStorage.clear()
    })

    function sentAuthenticate(): { payload: { token?: string } } {
      const frame = sockets[0].sent
        .map((s) => JSON.parse(s) as { type: string; payload: { token?: string } })
        .find((r) => r.type === 'authenticate')
      expect(frame, 'an authenticate frame must be sent').toBeTruthy()
      return frame!
    }

    it('presents the persisted web auth token on authenticate', async () => {
      window.localStorage.setItem('termul.webAuthToken', 's3cret-token')
      await api.read('warmup')
      expect(sentAuthenticate().payload.token).toBe('s3cret-token')
    })

    it('falls back to the legacy dev placeholder when no token is known', async () => {
      await api.read('warmup')
      expect(sentAuthenticate().payload.token).toBe('dev')
    })

    it('sends the full versioned handshake payload (version + device + instance ids)', async () => {
      const result = await api.read('warmup')
      // The fake host validates the payload; a stale shape would be refused
      // with protocol_version_mismatch / invalid_client_identity.
      expect(result).toMatchObject({ success: false, code: 'KEY_NOT_FOUND' })
      expect(sentAuthenticate().payload).toEqual({
        token: 'dev',
        protocolVersion: WS_PROTOCOL_VERSION,
        deviceId: window.localStorage.getItem('termul.deviceId'),
        clientInstanceId: window.sessionStorage.getItem('termul.clientInstanceId')
      })
    })
  })

  describe('handshake refusals (AD-15)', () => {
    it('protocol_version_mismatch reports once, then every request fails fast without re-handshaking', async () => {
      forcedAuthRefusal = 'protocol_version_mismatch'
      const first = await api.read('k')
      expect(first).toMatchObject({ success: false, code: 'protocol_version_mismatch' })
      expect(mockHandleProtocolVersionMismatch).toHaveBeenCalledTimes(1)
      expect(mockHandleProtocolVersionMismatch).toHaveBeenCalledWith('WebStoreSocket')

      const second = await api.write('k', 1)
      expect(second).toMatchObject({ success: false, code: 'protocol_version_mismatch' })
      expect(sockets).toHaveLength(1)
      expect(mockHandleProtocolVersionMismatch).toHaveBeenCalledTimes(1)
    })

    it('invalid_client_identity is non-retryable and never reloads', async () => {
      forcedAuthRefusal = 'invalid_client_identity'
      const first = await api.read('k')
      expect(first).toMatchObject({ success: false, code: 'invalid_client_identity' })
      const second = await api.read('k')
      expect(second).toMatchObject({ success: false, code: 'invalid_client_identity' })
      expect(sockets).toHaveLength(1)
      expect(mockHandleProtocolVersionMismatch).not.toHaveBeenCalled()
    })

    it('an unauthorized refusal stays retryable (a later request re-handshakes)', async () => {
      forcedAuthRefusal = 'unauthorized'
      expect(await api.read('k')).toMatchObject({ success: false, code: 'unauthorized' })
      forcedAuthRefusal = null
      expect(await api.read('k')).toMatchObject({ success: false, code: 'KEY_NOT_FOUND' })
      expect(sockets.length).toBeGreaterThanOrEqual(2)
    })
  })

  // D8-F2: upgrade + authenticate share one ~10 s handshake bound; without it a
  // stalled socket left `connecting` set forever and hung every caller,
  // including `flushPendingWrites` on app close.
  describe('handshake timeout', () => {
    afterEach(() => {
      FakeStoreSocket.stall = 'none'
    })

    for (const stall of ['upgrade', 'authenticate'] as const) {
      it(`settles a read with WS_TIMEOUT at 10s when the ${stall} stalls, then recovers`, async () => {
        vi.useFakeTimers()
        FakeStoreSocket.stall = stall
        let result: unknown
        void api.read('k').then((r) => {
          result = r
        })
        await vi.advanceTimersByTimeAsync(9_999)
        expect(result).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1)
        expect(result).toMatchObject({ success: false, code: 'WS_TIMEOUT' })
        expect(sockets[0].closed).toBe(true)

        // The hung attempt did not wedge `connecting`: the next call re-opens.
        FakeStoreSocket.stall = 'none'
        const retry = await api.read('k')
        expect(retry).toMatchObject({ success: false, code: 'KEY_NOT_FOUND' })
        expect(sockets).toHaveLength(2)
      })
    }

    it('flushPendingWrites settles (with the timeout failure) instead of hanging', async () => {
      vi.useFakeTimers()
      FakeStoreSocket.stall = 'authenticate'
      void api.writeDebounced('settings', { theme: 'dark' })
      let flushed: unknown
      void api.flushPendingWrites().then((r) => {
        flushed = r
      })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(flushed).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(flushed).toMatchObject({ success: false, code: 'WS_TIMEOUT' })
    })
  })
})
