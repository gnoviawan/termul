/**
 * Tests for the web-mode persistence API (issue #613).
 *
 * Uses a fake WebSocket that speaks the minimal WS handshake
 * (`auth_required` → `authenticate`) and serves `store_read` / `store_write`
 * / `store_delete` from an in-memory map, mirroring the Rust `WebStore`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebPersistenceApi } from '../web-persistence-api'

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
  store = new Map<string, unknown>()
  /** When set, every non-auth request replies with this error. */
  failCode: string | null = null

  constructor(public url: string) {
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
    /* no-op */
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
})
