/**
 * Tests for the web-mode persistence API (issue #613).
 *
 * Uses a fake WebSocket that speaks the minimal WS handshake
 * (`auth_required` → `authenticate`) and serves `store_read` / `store_write`
 * / `store_delete` from an in-memory map, mirroring the Rust `WebStore`.
 */

import { MAX_CLIENT_ID_LEN, WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCommandJournalForTesting } from '../command-journal'
import { __resetClientIdentityForTesting } from '../web-client-identity'
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

interface HostRecord {
  v: unknown
  rev: number
  cid: string | null
  cmd?: string
  fields?: Record<string, number>
}

/** The one fake host store shared by every fake socket (like one real host). */
const host = new Map<string, HostRecord>()
/** Every request the host saw, in arrival order (all connections). */
const hostLog: { deviceId: string; type: string; payload: Record<string, unknown> }[] = []

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

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
  /** When set, every non-auth request replies with this error. */
  failCode: string | null = null
  /** One-shot: the next store request is APPLIED, then answered with this error (lost reply). */
  applyThenFail: string | null = null
  deviceId = ''
  clientInstanceId = ''

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

  private err(id: string, code: string, message = code): void {
    this.emit({ id, ok: false, err: { code, message } })
  }

  send(data: string): void {
    this.sent.push(data)
    const req = JSON.parse(data) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    if (req.type === 'authenticate') {
      if (FakeStoreSocket.stall === 'authenticate') return
      const refusal = forcedAuthRefusal ?? validateHandshake(req.payload)
      if (refusal) {
        this.err(req.id, refusal)
        return
      }
      this.deviceId = req.payload.deviceId as string
      this.clientInstanceId = req.payload.clientInstanceId as string
      this.emit({ id: req.id, ok: true, payload: {} })
      return
    }
    if (this.failCode) {
      this.err(req.id, this.failCode, 'store failed')
      return
    }
    hostLog.push({ deviceId: this.deviceId, type: req.type, payload: req.payload })
    const lost = this.applyThenFail
    this.applyThenFail = null
    const reply = this.handle(req.type, req.payload)
    if (lost && reply.ok) {
      this.err(req.id, lost)
      return
    }
    this.emit({ id: req.id, ...reply })
  }

  /** Mirrors the Rust host's scope enforcement, LWW merge and CAS rules. */
  private handle(
    type: string,
    p: Record<string, unknown>
  ): { ok: true; payload: unknown } | { ok: false; err: { code: string; message: string } } {
    const fail = (code: string) => ({ ok: false as const, err: { code, message: code } })
    const key = p.key as string
    const device = key.match(/^device\/([^/]+)\//)
    const scope = device
      ? 'device'
      : key.startsWith('shared/lww/')
        ? 'lww'
        : key.startsWith('shared/cas/')
          ? 'cas'
          : null
    if (!scope || (device && device[1] !== this.deviceId)) return fail('STORE_KEY_SCOPE')
    const rec = host.get(key)
    if (type === 'store_read') {
      return {
        ok: true,
        payload: {
          value: rec?.v ?? null,
          revision: rec?.rev ?? 0,
          clientInstanceId: rec?.cid ?? null
        }
      }
    }
    if (type === 'store_delete') {
      if (scope === 'lww' && rec && typeof p.baseRevision !== 'number')
        return fail('STORE_BASE_REQUIRED')
      if (scope === 'cas' && !('expected' in p)) return fail('VALIDATION_ERROR')
      host.delete(key)
      return { ok: true, payload: { existed: !!rec } }
    }
    const value = p.value as { _version: number; data: unknown }
    const nextRev = (rec?.rev ?? 0) + 1
    if (scope === 'device') {
      host.set(key, { v: value, rev: nextRev, cid: this.clientInstanceId })
      return { ok: true, payload: { revision: nextRev } }
    }
    if (scope === 'lww') {
      if (rec && typeof p.baseRevision !== 'number') return fail('STORE_BASE_REQUIRED')
      const base = (p.baseRevision as number | undefined) ?? 0
      const cur = (rec?.v as { data: Record<string, unknown> } | undefined)?.data ?? {}
      const fields = new Map<string, number>(Object.entries(rec?.fields ?? {}))
      const merged = new Map<string, unknown>(Object.entries(cur))
      let changed = !rec
      for (const [f, fv] of Object.entries(value.data as Record<string, unknown>)) {
        if ((fields.get(f) ?? 0) <= base) {
          if (!deepEqual(cur[f], fv) || !rec) {
            merged.set(f, fv)
            fields.set(f, nextRev)
            changed = true
          }
        }
      }
      const mergedValue = { _version: value._version, data: Object.fromEntries(merged) }
      const rev = changed ? nextRev : (rec?.rev ?? 0)
      host.set(key, {
        v: mergedValue,
        rev,
        cid: this.clientInstanceId,
        fields: Object.fromEntries(fields)
      })
      return {
        ok: true,
        payload: { value: mergedValue, revision: rev, merged: !deepEqual(mergedValue, value) }
      }
    }
    // shared/cas
    if (!('expected' in p) || typeof p.commandId !== 'string') return fail('VALIDATION_ERROR')
    const resend = rec?.cmd === p.commandId && deepEqual(rec.v, value)
    if (!resend && !deepEqual(p.expected, rec?.v ?? null)) return fail('STORE_CAS_FAILED')
    const rev = resend ? rec.rev : nextRev
    host.set(key, { v: value, rev, cid: this.clientInstanceId, cmd: p.commandId })
    return { ok: true, payload: { value, revision: rev } }
  }

  close(): void {
    this.closed = true
  }
}

const okVoid = { success: true, data: undefined }

const DEVICE = 'device-a'

describe('createWebPersistenceApi', () => {
  let sockets: FakeStoreSocket[]
  let api: ReturnType<typeof createWebPersistenceApi>

  /** A fresh api (own revision book / hydration state) for another device or tab. */
  function makeApi(deviceId: string): ReturnType<typeof createWebPersistenceApi> {
    class TrackerSocket extends FakeStoreSocket {
      constructor(url: string) {
        super(url)
        sockets.push(this)
      }
    }
    return createWebPersistenceApi({
      WebSocketImpl: TrackerSocket as unknown as typeof WebSocket,
      deviceId
    })
  }

  /** The `store_*` frames an api sent (handshake excluded), in order. */
  function storeFrames(socketIndex = 0): { type: string; payload: Record<string, unknown> }[] {
    return sockets[socketIndex].sent
      .map((s) => JSON.parse(s) as { type: string; payload: Record<string, unknown> })
      .filter((r) => r.type.startsWith('store_'))
  }

  beforeEach(() => {
    sockets = []
    host.clear()
    hostLog.length = 0
    window.sessionStorage.clear()
    __resetClientIdentityForTesting()
    __resetCommandJournalForTesting()
    api = makeApi(DEVICE)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
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

  it('write persists a versioned payload under the device partition', async () => {
    const result = await api.write('settings', { theme: 'dark' })
    expect(result).toEqual(okVoid)
    expect(host.get(`device/${DEVICE}/settings`)?.v).toEqual({
      _version: 1,
      data: { theme: 'dark' }
    })
  })

  it('delete removes a key', async () => {
    await api.write('k', 1)
    const result = await api.delete('k')
    expect(result).toEqual(okVoid)
    expect(host.has(`device/${DEVICE}/k`)).toBe(false)
  })

  it('writeDebounced coalesces rapid writes into a single store_write', async () => {
    vi.useFakeTimers()
    const p1 = api.writeDebounced('k', 1)
    const p2 = api.writeDebounced('k', 2)
    await vi.advanceTimersByTimeAsync(500)
    await expect(p1).resolves.toEqual(okVoid)
    await expect(p2).resolves.toEqual(okVoid)

    const writes = storeFrames().filter((f) => f.type === 'store_write')
    expect(writes).toHaveLength(1)
    expect((writes[0].payload.value as { data: unknown }).data).toBe(2)
  })

  it('flushPendingWrites flushes immediately', async () => {
    vi.useFakeTimers()
    const p = api.writeDebounced('k', { a: 1 })
    const result = await api.flushPendingWrites()
    expect(result).toEqual(okVoid)
    await expect(p).resolves.toEqual(okVoid)
    expect(host.get(`device/${DEVICE}/k`)?.v).toEqual({ _version: 1, data: { a: 1 } })
  })

  it('answers HOST_OFFLINE without opening a socket after Close(1001) until /health answers', async () => {
    await api.read('warmup')
    const first = sockets[0]
    first.readyState = FakeStoreSocket.CLOSED
    first.onclose?.(new CloseEvent('close', { code: 1001 }))

    const health = vi.fn(async () => ({ ok: false }) as Response)
    vi.stubGlobal('fetch', health)
    try {
      const refused = await api.read('k')
      expect(refused).toMatchObject({ success: false, code: 'HOST_OFFLINE' })
      expect(sockets).toHaveLength(1)

      health.mockImplementation(async () => ({ ok: true }) as Response)
      const answered = await api.read('k')
      expect(answered).toMatchObject({ code: 'KEY_NOT_FOUND' })
      expect(sockets).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
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
        deviceId: DEVICE,
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

      const second = await api.write('other', 1)
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

  describe('key scopes', () => {
    it('keeps each device in its own partition: two devices, one logical key', async () => {
      const phone = makeApi('phone')
      await api.write('shell-layout', { rail: 'wide' })
      await phone.write('shell-layout', { rail: 'narrow' })

      expect(await api.read('shell-layout')).toEqual({ success: true, data: { rail: 'wide' } })
      expect(await phone.read('shell-layout')).toEqual({ success: true, data: { rail: 'narrow' } })
      expect([...host.keys()].sort()).toEqual([
        `device/${DEVICE}/shell-layout`,
        'device/phone/shell-layout'
      ])
    })

    it('never addresses another partition: every device key sent carries the own device id', async () => {
      await api.write('terminals/p1', { t: 1 })
      await api.read('window-state')
      await api.delete('snapshots/p1')
      const keys = storeFrames().map((f) => f.payload.key)
      expect(keys).toEqual([
        `device/${DEVICE}/terminals/p1`,
        `device/${DEVICE}/window-state`,
        `device/${DEVICE}/snapshots/p1`
      ])
    })

    it('stores shared keys under shared/lww/ and shared/cas/', async () => {
      await api.read('settings/app')
      await api.write('settings/app', { theme: 'dark' })
      await api.read('ssh/profiles')
      await api.write('ssh/profiles', [], { expected: null })
      expect([...host.keys()].sort()).toEqual([
        'shared/cas/ssh/profiles',
        'shared/lww/settings/app'
      ])
    })

    it('readStamped returns the value with its revision and writer stamp', async () => {
      await api.write('k', 'a')
      await api.write('k', 'b')
      const stamped = await api.readStamped<string>('k')
      expect(stamped).toEqual({
        success: true,
        data: {
          value: 'b',
          revision: 2,
          clientInstanceId: window.sessionStorage.getItem('termul.clientInstanceId')
        }
      })
    })

    it('readStamped on a missing key is KEY_NOT_FOUND', async () => {
      expect(await api.readStamped('nope')).toMatchObject({ success: false, code: 'KEY_NOT_FOUND' })
    })
  })

  describe('shared/lww merge', () => {
    it('sends the revision it read as baseRevision', async () => {
      await api.read('settings/app')
      await api.write('settings/app', { f1: 1 })
      await api.write('settings/app', { f1: 2 })
      const writes = storeFrames().filter((f) => f.type === 'store_write')
      // absent key reads as revision 0; the second write carries the revision the first reply set.
      expect(writes.map((w) => w.payload.baseRevision)).toEqual([0, 1])
      expect((host.get('shared/lww/settings/app')?.v as { data: unknown }).data).toEqual({ f1: 2 })
    })

    it('merges concurrent field edits from two devices and reports the merged reply', async () => {
      const desktop = api
      const phone = makeApi('phone')
      await desktop.read('settings/app')
      await desktop.write('settings/app', { f0: 0 })
      await desktop.read('settings/app')
      await phone.read('settings/app')

      const seen: { data: unknown; revision: number }[] = []
      phone.onSharedChange('settings/app', (data, revision) => seen.push({ data, revision }))

      await desktop.write('settings/app', { f0: 0, f1: 'desktop' })
      const result = await phone.write('settings/app', { f0: 0, f2: 'phone' })

      expect(result).toEqual(okVoid)
      expect((host.get('shared/lww/settings/app')?.v as { data: unknown }).data).toEqual({
        f0: 0,
        f1: 'desktop',
        f2: 'phone'
      })
      expect(seen).toEqual([{ data: { f0: 0, f1: 'desktop', f2: 'phone' }, revision: 3 }])
    })

    it('does not notify when the host kept exactly what was written', async () => {
      const spy = vi.fn()
      api.onSharedChange('settings/app', spy)
      await api.read('settings/app')
      await api.write('settings/app', { f1: 1 })
      expect(spy).not.toHaveBeenCalled()
    })

    it('stops notifying after unsubscribe', async () => {
      const phone = makeApi('phone')
      await api.read('settings/app')
      await api.write('settings/app', { f0: 0 })
      await phone.read('settings/app')
      const spy = vi.fn()
      const off = phone.onSharedChange('settings/app', spy)
      off()
      await api.read('settings/app')
      await api.write('settings/app', { f0: 0, f1: 1 })
      await phone.write('settings/app', { f0: 0, f2: 2 })
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('hydration guard', () => {
    it('refuses to write a key whose read failed, and sends nothing', async () => {
      await api.read('warmup')
      sockets[0].failCode = 'STORE_UNAVAILABLE'
      expect(await api.read('shell-layout')).toMatchObject({
        success: false,
        code: 'STORE_UNAVAILABLE'
      })
      sockets[0].failCode = null

      const before = storeFrames().length
      expect(await api.write('shell-layout', { defaults: true })).toMatchObject({
        success: false,
        code: 'STORE_NOT_HYDRATED'
      })
      expect(await api.delete('shell-layout')).toMatchObject({
        success: false,
        code: 'STORE_NOT_HYDRATED'
      })
      expect(storeFrames()).toHaveLength(before)
      expect(host.size).toBe(0)
    })

    it('the guard is per key: other keys still write', async () => {
      await api.read('warmup')
      sockets[0].failCode = 'STORE_UNAVAILABLE'
      await api.read('shell-layout')
      sockets[0].failCode = null
      expect(await api.write('window-state', { w: 1 })).toEqual(okVoid)
    })

    it('a later successful read lifts the guard', async () => {
      await api.read('warmup')
      sockets[0].failCode = 'STORE_UNAVAILABLE'
      await api.read('shell-layout')
      sockets[0].failCode = null
      // KEY_NOT_FOUND is a successful read of an absent key.
      expect(await api.read('shell-layout')).toMatchObject({ code: 'KEY_NOT_FOUND' })
      expect(await api.write('shell-layout', { ok: true })).toEqual(okVoid)
    })

    it('a debounced write to a guarded key settles with STORE_NOT_HYDRATED', async () => {
      vi.useFakeTimers()
      await api.read('warmup')
      sockets[0].failCode = 'STORE_UNAVAILABLE'
      await api.read('settings/app')
      sockets[0].failCode = null
      const pending = api.writeDebounced('settings/app', { theme: 'dark' })
      await vi.advanceTimersByTimeAsync(500)
      await expect(pending).resolves.toMatchObject({ success: false, code: 'STORE_NOT_HYDRATED' })
      expect(storeFrames().filter((f) => f.type === 'store_write')).toHaveLength(0)
    })

    it('blocks a shared key that was never read in this page (host would refuse STORE_BASE_REQUIRED)', async () => {
      expect(await api.write('settings/app', { theme: 'dark' })).toMatchObject({
        success: false,
        code: 'STORE_BASE_REQUIRED'
      })
      expect(await api.delete('settings/app')).toMatchObject({
        success: false,
        code: 'STORE_BASE_REQUIRED'
      })
      expect(sockets).toHaveLength(0)
    })

    it('a shared key read as KEY_NOT_FOUND is writable (revision 0 is known)', async () => {
      expect(await api.read('settings/app')).toMatchObject({ code: 'KEY_NOT_FOUND' })
      expect(await api.write('settings/app', { theme: 'dark' })).toEqual(okVoid)
      expect(storeFrames().find((f) => f.type === 'store_write')?.payload.baseRevision).toBe(0)
    })
  })

  describe('shared/cas writes', () => {
    const writes = (): { expected: unknown; commandId: string; key: unknown }[] =>
      storeFrames()
        .filter((f) => f.type === 'store_write')
        .map((f) => f.payload as { expected: unknown; commandId: string; key: unknown })

    it('first write asserts the key is absent (expected null), later ones the stored list', async () => {
      await api.read('ssh/profiles')
      await api.write('ssh/profiles', [{ id: 'a' }], { expected: null })
      await api.write('ssh/profiles', [{ id: 'a' }, { id: 'b' }], { expected: [{ id: 'a' }] })

      const sent = writes()
      expect(sent[0].expected).toBeNull()
      expect(sent[1].expected).toEqual({ _version: 1, data: [{ id: 'a' }] })
      expect(sent[0].commandId).toBeTruthy()
      expect(sent[1].commandId).not.toBe(sent[0].commandId)
    })

    it('resends the same commandId for the same write after a lost reply', async () => {
      await api.read('ssh/profiles')
      sockets[0].applyThenFail = 'WS_ERROR'
      const first = await api.write('ssh/profiles', [{ id: 'a' }], { expected: null })
      expect(first).toMatchObject({ success: false, code: 'WS_ERROR' })

      // The host applied it; the identical resend must succeed despite the stale `expected`.
      const second = await api.write('ssh/profiles', [{ id: 'a' }], { expected: null })
      expect(second).toEqual(okVoid)
      const sent = writes()
      expect(sent).toHaveLength(2)
      expect(sent[1].commandId).toBe(sent[0].commandId)
    })

    it('a different write with a stale expected is STORE_CAS_FAILED and mints a new commandId next time', async () => {
      await api.read('ssh/profiles')
      await api.write('ssh/profiles', [{ id: 'a' }], { expected: null })

      const stale = await api.write('ssh/profiles', [{ id: 'z' }], { expected: null })
      expect(stale).toMatchObject({ success: false, code: 'STORE_CAS_FAILED' })
      const retry = await api.write('ssh/profiles', [{ id: 'z' }], { expected: null })
      expect(retry).toMatchObject({ success: false, code: 'STORE_CAS_FAILED' })

      const sent = writes()
      expect(sent[2].commandId).not.toBe(sent[1].commandId)
    })

    it('uses an explicit commandId as given', async () => {
      await api.read('ssh/profiles')
      await api.write('ssh/profiles', [], { expected: null, commandId: 'cmd-explicit' })
      expect(writes()[0].commandId).toBe('cmd-explicit')
    })

    it('defaults expected to the last value this page saw', async () => {
      await api.read('ssh/profiles')
      await api.write('ssh/profiles', [1], { expected: null })
      await api.write('ssh/profiles', [1, 2])
      expect(writes()[1].expected).toEqual({ _version: 1, data: [1] })
    })
  })

  describe('value cap', () => {
    it('refuses an oversized value client-side with STORE_VALUE_TOO_LARGE and sends nothing', async () => {
      const result = await api.write('k', 'x'.repeat(256 * 1024))
      expect(result).toMatchObject({ success: false, code: 'STORE_VALUE_TOO_LARGE' })
      expect(sockets).toHaveLength(0)
    })

    it('accepts a value just under the cap', async () => {
      const overhead = JSON.stringify({ _version: 1, data: '' }).length
      expect(await api.write('k', 'x'.repeat(256 * 1024 - overhead))).toEqual(okVoid)
    })

    it('a debounced oversized write settles with the error', async () => {
      vi.useFakeTimers()
      const pending = api.writeDebounced('k', 'x'.repeat(256 * 1024))
      await vi.advanceTimersByTimeAsync(500)
      await expect(pending).resolves.toMatchObject({ code: 'STORE_VALUE_TOO_LARGE' })
    })
  })

  describe('flush on page lifecycle', () => {
    function setVisibility(state: 'hidden' | 'visible'): void {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
    }

    it('flushes a pending debounced write when the page is hidden', async () => {
      const pending = api.writeDebounced('k', { a: 1 })
      setVisibility('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      await expect(pending).resolves.toEqual(okVoid)
      expect(host.get(`device/${DEVICE}/k`)?.v).toEqual({ _version: 1, data: { a: 1 } })
    })

    it('does not flush when the page becomes visible', async () => {
      vi.useFakeTimers()
      void api.writeDebounced('k', { a: 1 })
      setVisibility('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(100)
      expect(sockets).toHaveLength(0)
    })

    it('flushes on pagehide', async () => {
      const pending = api.writeDebounced('k', { a: 2 })
      window.dispatchEvent(new Event('pagehide'))
      await expect(pending).resolves.toEqual(okVoid)
      expect(host.get(`device/${DEVICE}/k`)?.v).toEqual({ _version: 1, data: { a: 2 } })
    })

    it('registers its lifecycle listeners once per api instance', async () => {
      const pending = api.writeDebounced('k', 1)
      window.dispatchEvent(new Event('pagehide'))
      window.dispatchEvent(new Event('pagehide'))
      await pending
      expect(storeFrames().filter((f) => f.type === 'store_write')).toHaveLength(1)
    })
  })

  describe('persistence error bus', () => {
    /** An api plus the events it reported. */
    function withEvents(instance = api): {
      events: { key: string; code: string; message: string }[]
      unsubscribe: () => void
    } {
      const events: { key: string; code: string; message: string }[] = []
      const unsubscribe = instance.onPersistenceError((event) => events.push(event))
      return { events, unsubscribe }
    }

    it('reports STORE_VALUE_TOO_LARGE with the logical key, and sends nothing', async () => {
      const { events } = withEvents()

      const result = await api.write('chat-draft/p1/s1', 'x'.repeat(256 * 1024))

      expect(result).toMatchObject({ success: false, code: 'STORE_VALUE_TOO_LARGE' })
      expect(events).toEqual([
        {
          key: 'chat-draft/p1/s1',
          code: 'STORE_VALUE_TOO_LARGE',
          message: expect.stringContaining('chat-draft/p1/s1')
        }
      ])
      expect(hostLog).toHaveLength(0)
    })

    it.each([
      'STORE_PARTITION_FULL',
      'STORE_WRITE_FAILED'
    ])('reports %s answered by the host', async (code) => {
      const { events } = withEvents()
      await api.read('warmup')
      sockets[0].failCode = code

      const result = await api.write('terminals/p1', { a: 1 })

      expect(result).toMatchObject({ success: false, code })
      expect(events).toEqual([{ key: 'terminals/p1', code, message: 'store failed' }])
    })

    it('reports STORE_NOT_HYDRATED when the key was never read successfully', async () => {
      const { events } = withEvents()
      await api.read('warmup')
      sockets[0].failCode = 'STORE_UNAVAILABLE'
      await api.read('terminals/p1')
      sockets[0].failCode = null

      const result = await api.write('terminals/p1', { a: 1 })

      expect(result).toMatchObject({ success: false, code: 'STORE_NOT_HYDRATED' })
      expect(events.map((e) => [e.key, e.code])).toEqual([['terminals/p1', 'STORE_NOT_HYDRATED']])
    })

    it('reports STORE_BASE_REQUIRED for a shared key this page never read', async () => {
      const { events } = withEvents()

      const result = await api.write('settings/app', { theme: 'dark' })

      expect(result).toMatchObject({ success: false, code: 'STORE_BASE_REQUIRED' })
      expect(events.map((e) => [e.key, e.code])).toEqual([['settings/app', 'STORE_BASE_REQUIRED']])
    })

    it('reports a failed delete the same way', async () => {
      const { events } = withEvents()

      await api.delete('settings/app')

      expect(events.map((e) => [e.key, e.code])).toEqual([['settings/app', 'STORE_BASE_REQUIRED']])
    })

    describe('STORE_CAS_FAILED', () => {
      /** Reads the absent key, then makes another device create it: `expected: null` is stale. */
      async function loseTheRace(): Promise<void> {
        await api.read('ssh/profiles')
        const other = makeApi('device-b')
        await other.read('ssh/profiles')
        expect(await other.write('ssh/profiles', [{ id: 'other' }], { expected: null })).toEqual(
          okVoid
        )
      }

      it('is reported for a write that loses the race', async () => {
        const { events } = withEvents()
        await loseTheRace()

        const result = await api.write('ssh/profiles', [{ id: 'mine' }], { expected: null })

        expect(result).toMatchObject({ success: false, code: 'STORE_CAS_FAILED' })
        expect(events.map((e) => [e.key, e.code])).toEqual([['ssh/profiles', 'STORE_CAS_FAILED']])
      })

      it('stays quiet while the caller retries, and reports the last attempt', async () => {
        const { events } = withEvents()
        await loseTheRace()

        const retried = await api.write('ssh/profiles', [{ id: 'mine' }], {
          expected: null,
          retrying: true
        })
        expect(retried).toMatchObject({ success: false, code: 'STORE_CAS_FAILED' })
        expect(events).toEqual([])

        await api.write('ssh/profiles', [{ id: 'mine' }], { expected: null, retrying: false })
        expect(events).toHaveLength(1)
      })

      it('does not silence other failures of a retrying write', async () => {
        const { events } = withEvents()

        await api.write('ssh/profiles', [{ id: 'mine' }], { expected: null, retrying: true })

        // Never read in this page: refused before any compare-and-set happens.
        expect(events.map((e) => e.code)).toEqual(['STORE_BASE_REQUIRED'])
      })
    })

    it('reports a failed debounced write when it flushes', async () => {
      vi.useFakeTimers()
      const { events } = withEvents()
      void api.writeDebounced('settings/app', { theme: 'dark' })

      await vi.advanceTimersByTimeAsync(500)

      expect(events.map((e) => [e.key, e.code])).toEqual([['settings/app', 'STORE_BASE_REQUIRED']])
    })

    it('stays quiet for successes, failed reads and codes the user cannot act on', async () => {
      const { events } = withEvents()

      await api.write('terminals/p1', { a: 1 })
      await api.read('missing')
      sockets[0].failCode = 'STORE_UNAVAILABLE'
      await api.write('terminals/p1', { a: 2 })
      await api.read('unreadable')
      sockets[0].failCode = 'STORE_KEY_SCOPE'
      await api.write('terminals/p1', { a: 3 })

      expect(events).toEqual([])
    })

    it('stops reporting after unsubscribe and survives a throwing listener', async () => {
      const first = withEvents()
      const second = withEvents()
      api.onPersistenceError(() => {
        throw new Error('listener bug')
      })

      const result = await api.write('settings/app', { theme: 'dark' })
      first.unsubscribe()
      await api.write('settings/app', { theme: 'light' })

      expect(result).toMatchObject({ success: false, code: 'STORE_BASE_REQUIRED' })
      expect(first.events).toHaveLength(1)
      expect(second.events).toHaveLength(2)
    })
  })
})
