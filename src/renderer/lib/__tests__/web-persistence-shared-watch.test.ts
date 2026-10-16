import type { StoreWatchState } from '@shared/types/web-protocol.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchHandlers } from '../acp-transport/watch-client'

const { mockTransport } = vi.hoisted(() => ({
  mockTransport: { watches: undefined as unknown }
}))
vi.mock('../acp-transport', async () => {
  const actual = await vi.importActual<typeof import('../acp-transport')>('../acp-transport')
  return { ...actual, getAcpTransport: () => mockTransport }
})
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { __resetCommandJournalForTesting } from '../command-journal'
import { createWebPersistenceApi, type WebPersistenceApi } from '../web-persistence-api'

const KEY = 'settings/app'
const HOST_KEY = `shared/lww/${KEY}`
const wrap = (data: unknown) => ({ _version: 1, data })

/** A host store that answers `store_read` / `store_write` of one shared key by plain overwrite. */
class FakeStoreSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  /** Stored value of HOST_KEY (wrapped), `null` = absent. */
  static stored: unknown = null
  /** When set, every `store_read` fails with this code. */
  static readFailure: string | null = null
  static writes: unknown[] = []
  /** When true, `store_write` replies wait in `held` until the test sends them. */
  static holdWrites = false
  static held: (() => void)[] = []

  readyState = FakeStoreSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null

  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = FakeStoreSocket.OPEN
      this.onopen?.(new Event('open'))
      this.emit({ type: 'auth_required', payload: {} })
    })
  }

  private emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
  }

  send(data: string): void {
    const req = JSON.parse(data) as { id: string; type: string; payload: Record<string, unknown> }
    if (req.type === 'authenticate') {
      this.emit({ id: req.id, ok: true, payload: {} })
    } else if (req.type === 'store_read') {
      if (FakeStoreSocket.readFailure) {
        this.emit({
          id: req.id,
          ok: false,
          err: { code: FakeStoreSocket.readFailure, message: 'read failed' }
        })
        return
      }
      const value = FakeStoreSocket.stored
      this.emit({
        id: req.id,
        ok: true,
        payload: { value, revision: value === null ? 0 : 1, clientInstanceId: null }
      })
    } else if (req.type === 'store_write') {
      FakeStoreSocket.stored = req.payload.value
      FakeStoreSocket.writes.push(req.payload.value)
      const reply = () =>
        this.emit({
          id: req.id,
          ok: true,
          payload: { value: req.payload.value, revision: 2, merged: false }
        })
      if (FakeStoreSocket.holdWrites) FakeStoreSocket.held.push(reply)
      else reply()
    }
  }

  close(): void {}
}

type Handlers = WatchHandlers<StoreWatchState, StoreWatchState>

describe('createWebPersistenceApi watchShared', () => {
  let handlers: Handlers | null
  const release = vi.fn()
  const subscribe = vi.fn((_watch: string, h: Handlers, _scope?: string) => {
    handlers = h
    return release
  })
  let api: WebPersistenceApi
  let seen: unknown[]

  const remote = (data: unknown) => handlers?.onDelta?.({ exists: true, value: wrap(data) })

  beforeEach(() => {
    handlers = null
    seen = []
    release.mockClear()
    subscribe.mockClear()
    mockTransport.watches = { subscribe }
    FakeStoreSocket.stored = wrap({ theme: 'dark' })
    FakeStoreSocket.readFailure = null
    FakeStoreSocket.writes = []
    FakeStoreSocket.holdWrites = false
    FakeStoreSocket.held = []
    window.sessionStorage.clear()
    __resetCommandJournalForTesting()
    api = createWebPersistenceApi({
      WebSocketImpl: FakeStoreSocket as unknown as typeof WebSocket,
      deviceId: 'device-a'
    })
  })

  it('starts watching the scoped key only after the key was read, then applies remote changes', async () => {
    const stop = api.watchShared(KEY, (change) => seen.push(change))
    expect(subscribe).not.toHaveBeenCalled()

    await api.read(KEY)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledWith('store', expect.any(Object), HOST_KEY)

    // The state frame of the subscription equals what was read: nothing to apply.
    handlers?.onState({ exists: true, value: wrap({ theme: 'dark' }) })
    expect(seen).toEqual([])

    remote({ theme: 'light' })
    expect(seen).toEqual([{ exists: true, data: { theme: 'light' } }])

    stop()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('does not start the watch when unsubscribed before the first read', async () => {
    const stop = api.watchShared(KEY, (change) => seen.push(change))
    stop()
    await api.read(KEY)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('applies a delta for a key that did not exist when it was read', async () => {
    FakeStoreSocket.stored = null
    expect(await api.read(KEY)).toMatchObject({ success: false, code: 'KEY_NOT_FOUND' })
    api.watchShared(KEY, (change) => seen.push(change))
    handlers?.onState({ exists: false })
    expect(seen).toEqual([])
    remote({ theme: 'light' })
    expect(seen).toEqual([{ exists: true, data: { theme: 'light' } }])
  })

  it('never applies the echo of its own write, and never writes back', async () => {
    await api.read(KEY)
    api.watchShared(KEY, (change) => seen.push(change))

    // The host publishes before it answers: the echo can arrive while the write is in flight.
    FakeStoreSocket.holdWrites = true
    const writing = api.write(KEY, { theme: 'solar' })
    await vi.waitFor(() => expect(FakeStoreSocket.held).toHaveLength(1))
    remote({ theme: 'solar' })
    FakeStoreSocket.held[0]()
    await writing
    remote({ theme: 'solar' })

    expect(seen).toEqual([])
    expect(FakeStoreSocket.writes).toHaveLength(1)
  })

  it('applies a change that returns to a value this page wrote earlier', async () => {
    await api.read(KEY)
    api.watchShared(KEY, (change) => seen.push(change))
    await api.write(KEY, { theme: 'solar' })

    remote({ theme: 'light' })
    remote({ theme: 'solar' })

    expect(seen).toEqual([
      { exists: true, data: { theme: 'light' } },
      { exists: true, data: { theme: 'solar' } }
    ])
  })

  it('re-applies the full state a reset or reconnect delivers when it differs', async () => {
    await api.read(KEY)
    api.watchShared(KEY, (change) => seen.push(change))
    handlers?.onState({ exists: true, value: wrap({ theme: 'dark' }) })
    handlers?.onState({ exists: true, value: wrap({ theme: 'light', extra: 1 }) })
    handlers?.onState({ exists: false })
    expect(seen).toEqual([{ exists: true, data: { theme: 'light', extra: 1 } }, { exists: false }])
  })

  it('applies a remote delete and ignores the echo of its own delete', async () => {
    await api.read(KEY)
    api.watchShared(KEY, (change) => seen.push(change))
    handlers?.onDelta?.({ exists: false })
    expect(seen).toEqual([{ exists: false }])
  })

  it('applies nothing while the last read of the key failed', async () => {
    await api.read(KEY)
    api.watchShared(KEY, (change) => seen.push(change))
    FakeStoreSocket.readFailure = 'STORE_UNAVAILABLE'
    await api.read(KEY)

    remote({ theme: 'light' })
    expect(seen).toEqual([])

    FakeStoreSocket.readFailure = null
    await api.read(KEY)
    remote({ theme: 'light' })
    expect(seen).toEqual([{ exists: true, data: { theme: 'light' } }])
  })

  it('is a no-op without a host watch (desktop)', async () => {
    mockTransport.watches = undefined
    await api.read(KEY)
    const stop = api.watchShared(KEY, (change) => seen.push(change))
    expect(stop).not.toThrow()
    expect(seen).toEqual([])
  })
})
