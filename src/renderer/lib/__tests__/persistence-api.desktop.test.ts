/**
 * The persistence facade on the desktop: the SAME host store the browsers use,
 * reached over the Tauri IPC Channel carrier. A fake host speaks the `/ws`
 * frames behind a faked `invoke` + `Channel` (the pattern of
 * `acp-transport-carriers.test.ts`), so these cases run the real
 * `persistence-api.ts`, `ChannelSocket`, `WebStoreSocket` and
 * `DesktopAcpTransport`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real `DesktopAcpTransport` (its watches), not the invoke-backed double.
vi.unmock('@/lib/acp-transport/desktop-transport')
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriRuntime>()),
  isTauriContext: () => true
}))

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage: (raw: unknown) => void = () => {}
  }
}))

import type { PersistenceKeyChange } from '@shared/types/ipc.types'
import { WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import type * as TauriRuntime from '@/lib/tauri-runtime'

interface Frame {
  id: string
  type: string
  payload: Record<string, unknown>
}

interface HostConn {
  id: number
  received: Frame[]
  ended: boolean
  /** `scope` -> revision counter of each store watch this connection holds. */
  watches: Map<string, number>
  emit(obj: unknown): void
}

const wrap = (data: unknown) => ({ _version: 1, data })

/** The desktop host: one store behind every Channel connection. */
class FakeHost {
  conns: HostConn[] = []
  store = new Map<string, { value: unknown; revision: number }>()
  authPayloads: Array<Record<string, unknown>> = []
  private channels = new Map<number, (raw: unknown) => void>()

  open(onFrame: (raw: unknown) => void): HostConn {
    const conn: HostConn = {
      id: this.conns.length + 1,
      received: [],
      ended: false,
      watches: new Map(),
      emit: (obj) => {
        if (!conn.ended) onFrame(JSON.stringify(obj))
      }
    }
    this.conns.push(conn)
    this.channels.set(conn.id, onFrame)
    conn.emit({ sid: null, seq: 0, type: 'auth_required', payload: {} })
    return conn
  }

  /** The host ends one connection (the relay's idle watchdog, a restart). */
  endByHost(conn: HostConn): void {
    conn.emit({ type: 'channel_closed', code: 1011, reason: 'connection ended by host' })
    conn.ended = true
  }

  /** A write by another device: stored, then pushed to every watcher of the key. */
  remoteWrite(key: string, value: unknown): void {
    const revision = (this.store.get(key)?.revision ?? 0) + 1
    this.store.set(key, { value, revision })
    for (const conn of this.conns) this.publish(conn, key)
  }

  private publish(conn: HostConn, key: string): void {
    const n = conn.watches.get(key)
    if (n === undefined) return
    conn.watches.set(key, n + 1)
    conn.emit({
      type: 'watch',
      watch: 'store',
      scope: key,
      delta: { exists: this.store.has(key), value: this.store.get(key)?.value ?? null },
      revision: { hostEpoch: 'epoch-1', n: n + 1 }
    })
  }

  onFrame(conn: HostConn, text: string): void {
    const frame = JSON.parse(text) as Frame
    conn.received.push(frame)
    const ok = (payload: unknown = {}) => conn.emit({ id: frame.id, ok: true, payload })
    const key = frame.payload.key as string
    switch (frame.type) {
      case 'authenticate':
        this.authPayloads.push(frame.payload)
        ok({ historyMode: 'live_only' })
        return
      case 'store_read': {
        const entry = this.store.get(key)
        ok({ value: entry?.value ?? null, revision: entry?.revision ?? 0, clientInstanceId: null })
        return
      }
      case 'store_write': {
        const revision = (this.store.get(key)?.revision ?? 0) + 1
        this.store.set(key, { value: frame.payload.value, revision })
        ok(
          key.startsWith('shared/lww/')
            ? { value: frame.payload.value, revision, merged: false }
            : { revision }
        )
        for (const other of this.conns) this.publish(other, key)
        return
      }
      case 'store_delete': {
        const existed = this.store.delete(key)
        ok({ existed })
        for (const other of this.conns) this.publish(other, key)
        return
      }
      case 'watch': {
        const scope = frame.payload.scope as string
        conn.watches.set(scope, 1)
        conn.emit({
          type: 'watch',
          watch: 'store',
          scope,
          reset: true,
          state: { exists: this.store.has(scope), value: this.store.get(scope)?.value ?? null },
          revision: { hostEpoch: 'epoch-1', n: 1 }
        })
        ok({ watch: 'store', scope, revision: { hostEpoch: 'epoch-1', n: 1 } })
        return
      }
      default:
        ok()
    }
  }

  /** The connection that carried store requests (the facade's own socket). */
  storeConn(): HostConn | undefined {
    return this.conns.find((conn) => conn.received.some((f) => f.type.startsWith('store_')))
  }
}

let host: FakeHost

function wireInvoke(): void {
  const byId = new Map<number, HostConn>()
  ipc.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'ws_channel_open') {
      const conn = host.open((args.onFrame as { onmessage: (raw: unknown) => void }).onmessage)
      byId.set(conn.id, conn)
      return conn.id
    }
    const conn = byId.get(args.connectionId as number)
    if (command === 'ws_channel_send') {
      if (!conn || conn.ended) throw 'unknown or closed connection'
      host.onFrame(conn, args.frame as string)
    } else if (command === 'ws_channel_close' && conn) {
      conn.ended = true
    }
    return undefined
  })
}

/**
 * A fresh facade + transport over this test's host. The facade keeps its
 * revisions and socket in module state, so each case loads its own copy: the
 * import has to happen after `vi.resetModules()`, which a static import cannot do.
 */
async function loadDesktop() {
  vi.resetModules()
  const { persistenceApi } = await import('../persistence-api')
  const transports = await import('../acp-transport')
  const { getDeviceId } = await import('../web-client-identity')
  return { persistenceApi, transports, deviceId: getDeviceId() }
}

describe('the desktop persistence facade over the Channel carrier', () => {
  let cleanup: (() => void) | null = null

  beforeEach(() => {
    ipc.invoke.mockReset()
    host = new FakeHost()
    wireInvoke()
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('stores a device key in the host store under this device, with no token and no plugin-store', async () => {
    const { persistenceApi, deviceId } = await loadDesktop()

    expect(await persistenceApi.write('shell-layout', { columns: 3 })).toEqual({
      success: true,
      data: undefined
    })

    expect(host.store.get(`device/${deviceId}/shell-layout`)?.value).toEqual(wrap({ columns: 3 }))
    expect(await persistenceApi.read('shell-layout')).toEqual({
      success: true,
      data: { columns: 3 }
    })
    const [auth] = host.authPayloads
    expect(auth.protocolVersion).toBe(WS_PROTOCOL_VERSION)
    expect(auth.deviceId).toBe(deviceId)
    expect(typeof auth.clientInstanceId).toBe('string')
    expect(auth).not.toHaveProperty('token')
    const commands = new Set(ipc.invoke.mock.calls.map(([command]) => command))
    expect([...commands].every((command) => String(command).startsWith('ws_channel_'))).toBe(true)
  })

  it('keeps shared keys in the shared scope and reports a miss as not found', async () => {
    const { persistenceApi } = await loadDesktop()

    expect(await persistenceApi.read('settings/app')).toMatchObject({ code: 'KEY_NOT_FOUND' })
    expect((await persistenceApi.write('settings/app', { theme: 'dark' })).success).toBe(true)

    expect(host.store.get('shared/lww/settings/app')?.value).toEqual(wrap({ theme: 'dark' }))
    expect(await persistenceApi.readStamped('settings/app')).toMatchObject({
      success: true,
      data: { value: { theme: 'dark' }, revision: 1 }
    })
  })

  it('sends a debounced write when the pending writes are flushed', async () => {
    const { persistenceApi, deviceId } = await loadDesktop()

    const pending = persistenceApi.writeDebounced('window-state', { width: 800 })
    expect(await persistenceApi.flushPendingWrites()).toEqual({ success: true, data: undefined })
    await pending

    expect(host.store.get(`device/${deviceId}/window-state`)?.value).toEqual(wrap({ width: 800 }))
  })

  it('reconnects on demand after the host ends an idle connection', async () => {
    const { persistenceApi } = await loadDesktop()
    await persistenceApi.write('shell-layout', { columns: 1 })
    const first = host.storeConn()
    expect(first).toBeDefined()

    host.endByHost(first as HostConn)
    await Promise.resolve()

    expect((await persistenceApi.write('shell-layout', { columns: 2 })).success).toBe(true)
    expect(await persistenceApi.read('shell-layout')).toEqual({
      success: true,
      data: { columns: 2 }
    })
    expect(host.conns).toHaveLength(2)
    expect(host.conns[1].received.map((frame) => frame.type)).toContain('authenticate')
  })

  it('pings while idle so the host never closes the store connection for silence', async () => {
    vi.useFakeTimers()
    try {
      const { persistenceApi } = await loadDesktop()
      await persistenceApi.write('shell-layout', { columns: 1 })
      const conn = host.storeConn() as HostConn
      const pings = () => conn.received.filter((frame) => frame.type === 'ping').length
      expect(pings()).toBe(0)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(pings()).toBe(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(pings()).toBe(3)

      // The connection ends: the pings stop and the next request reconnects.
      host.endByHost(conn)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(pings()).toBe(3)
      expect((await persistenceApi.write('shell-layout', { columns: 2 })).success).toBe(true)
      expect(host.conns).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers a shared-key change made on another device to the owner', async () => {
    const { persistenceApi, transports } = await loadDesktop()
    const transport = transports.getAcpTransport()
    cleanup = () => transports._resetAcpTransportForTests(null)
    await transport.connect()
    // A shared key is read before it is written or watched.
    expect(await persistenceApi.read('settings/app')).toMatchObject({ code: 'KEY_NOT_FOUND' })
    expect((await persistenceApi.write('settings/app', { theme: 'dark' })).success).toBe(true)
    const seen: PersistenceKeyChange[] = []

    const stop = persistenceApi.watchShared('settings/app', (change) => seen.push(change))
    await vi.waitFor(() => {
      const watching = host.conns.some((conn) => conn.watches.has('shared/lww/settings/app'))
      expect(watching).toBe(true)
    })
    // The state frame equals what this page wrote: no change to report.
    expect(seen).toEqual([])

    host.remoteWrite('shared/lww/settings/app', wrap({ theme: 'light' }))
    expect(seen).toEqual([{ exists: true, data: { theme: 'light' } }])

    // A delete elsewhere reaches the owner too.
    host.store.delete('shared/lww/settings/app')
    for (const conn of host.conns) {
      if (!conn.watches.has('shared/lww/settings/app')) continue
      const n = (conn.watches.get('shared/lww/settings/app') ?? 1) + 1
      conn.watches.set('shared/lww/settings/app', n)
      conn.emit({
        type: 'watch',
        watch: 'store',
        scope: 'shared/lww/settings/app',
        delta: { exists: false, value: null },
        revision: { hostEpoch: 'epoch-1', n }
      })
    }
    expect(seen.at(-1)).toEqual({ exists: false })

    stop()
    host.remoteWrite('shared/lww/settings/app', wrap({ theme: 'later' }))
    expect(seen).toHaveLength(2)
  })
})
