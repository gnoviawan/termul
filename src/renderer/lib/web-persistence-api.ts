/**
 * Web persistence API (issue #613).
 *
 * Persists web-client app state (settings, terminal layout, editor state,
 * command history, snapshots, SSH profiles) to the termul-server's
 * server-side JSON store over the authenticated `/ws` protocol instead of
 * per-browser localStorage, so state survives browser switches, refreshes,
 * and device changes.
 *
 * Implements the same `PersistenceApi` interface as the desktop
 * `tauriPersistenceApi` (plugin-store). Values are stored versioned
 * (`{ _version, data }`) exactly like the desktop store so a store file
 * stays readable by either implementation.
 */

import type {
  IpcResult,
  PersistenceApi,
  PersistenceWriteOpts,
  StampedValue
} from '@shared/types/ipc.types'
import { scopedKey, scopeOf } from '@shared/types/persistence.types'
import {
  WS_ERROR_CODES,
  type WsRequest,
  type WsRequestType
} from '@shared/types/web-protocol.types'
import { randomUUID } from '@/lib/uuid'
import { resolveWsUrl } from './acp-transport'
import { HANDSHAKE_TIMEOUT_MS } from './acp-transport/ws-transport-timing'
import { findUnresolvedCommand, openCommand, resolveCommand } from './command-journal'
import { logFrontendError } from './log-api'
import { getWebAuthToken } from './web-auth-token'
import { buildAuthenticatePayload, getDeviceId } from './web-client-identity'
import { clearProtocolMismatchLatch, handleProtocolVersionMismatch } from './web-protocol-reload'

const DEBOUNCE_MS = 500
const CURRENT_VERSION = 1

/** Transport-level failure carrying the server's stable error `code`. */
interface StoreError {
  code: string
  message: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: StoreError) => void
}

interface PendingDebounceEntry {
  timer: ReturnType<typeof setTimeout> | null
  data: unknown
  resolvers: ((result: IpcResult<void>) => void)[]
}

/**
 * Minimal authenticated WS client for the store request types. Speaks only
 * `authenticate` + `store_read` / `store_write` / `store_delete`; replies are
 * matched by correlation id. The connect promise settles only after the
 * `auth_required` → `authenticate` handshake completes.
 */
export class WebStoreSocket {
  private socket: WebSocket | null = null
  private authed = false
  private connecting: Promise<void> | null = null
  /**
   * AD-15: the host refused `authenticate` with `protocol_version_mismatch` /
   * `invalid_client_identity`. Neither succeeds on retry, so every later
   * request fails fast with the same error instead of re-handshaking (a
   * version mismatch reloads the page once via the shared helper).
   */
  private halted: StoreError | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly wsUrl: string
  private readonly wsCtor: typeof WebSocket
  private readonly deviceId: string | undefined

  constructor(opts?: { url?: string; WebSocketImpl?: typeof WebSocket; deviceId?: string }) {
    this.deviceId = opts?.deviceId
    this.wsUrl =
      opts?.url ?? (typeof window !== 'undefined' ? resolveWsUrl() : 'ws://127.0.0.1:8080/ws')
    this.wsCtor = opts?.WebSocketImpl ?? WebSocket
  }

  async connect(): Promise<void> {
    if (this.halted) throw this.halted
    if (this.socket?.readyState === WebSocket.OPEN && this.authed) return
    if (this.connecting) return this.connecting
    this.connecting = this.open()
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  async request<T>(type: WsRequestType, payload: unknown): Promise<T> {
    await this.connect()
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID()
      const frame: WsRequest = { id, type, payload }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject({ code: 'WS_TIMEOUT', message: 'store request timed out' })
      }, 15000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      })
      this.socket?.send(JSON.stringify(frame))
    })
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null
      const settleOk = () => {
        if (settled) return
        settled = true
        if (handshakeTimer) clearTimeout(handshakeTimer)
        resolve()
      }
      const settleErr = (err: StoreError) => {
        if (settled) return
        settled = true
        if (handshakeTimer) clearTimeout(handshakeTimer)
        reject(err)
      }

      const ws = new this.wsCtor(this.wsUrl)
      this.socket = ws
      this.authed = false

      ws.onopen = () => {
        void this.authenticate().then(() => {
          this.authed = true
          clearProtocolMismatchLatch()
          settleOk()
        }, settleErr)
      }

      ws.onmessage = (ev) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (!parsed || typeof parsed !== 'object') return
        const obj = parsed as Record<string, unknown>

        if (obj.type === 'auth_required') return

        // Reply frame: { id, ok, payload | err }.
        if (typeof obj.id === 'string' && typeof obj.ok === 'boolean') {
          const reply = obj as unknown as {
            id: string
            ok: boolean
            payload?: unknown
            err?: { code: string; message: string }
          }
          const pending = this.pending.get(reply.id)
          if (!pending) return
          this.pending.delete(reply.id)
          if (reply.ok) pending.resolve(reply.payload)
          else pending.reject(reply.err ?? { code: 'WS_ERROR', message: 'store request failed' })
        }
      }

      ws.onerror = () => {
        this.rejectAll({ code: 'WS_ERROR', message: 'WebSocket error' })
        settleErr({ code: 'WS_ERROR', message: 'WebSocket error' })
      }

      ws.onclose = () => {
        this.socket = null
        this.authed = false
        this.rejectAll({ code: 'WS_ERROR', message: 'WebSocket closed' })
        settleErr({ code: 'WS_ERROR', message: 'WebSocket closed' })
      }

      // D8-F2: one ~10 s budget for upgrade + `authenticate`. Without it a
      // stalled upgrade or an unanswered authenticate leaves `connecting` set
      // forever and every read/write/`flushPendingWrites` joins the hung
      // promise. On expiry the socket is closed and every pending caller
      // (including the authenticate request) settles with `WS_TIMEOUT`.
      handshakeTimer = setTimeout(() => {
        if (settled) return
        const err: StoreError = {
          code: 'WS_TIMEOUT',
          message: 'persistence socket handshake timed out'
        }
        void logFrontendError({
          level: 'warn',
          source: 'WebStoreSocket.handshakeTimeout',
          message: `persistence socket upgrade/authenticate did not complete within ${HANDSHAKE_TIMEOUT_MS}ms`
        })
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        if (this.socket === ws) {
          this.socket = null
          this.authed = false
        }
        try {
          ws.close()
        } catch {
          /* already closing */
        }
        this.rejectAll(err)
        settleErr(err)
      }, HANDSHAKE_TIMEOUT_MS)
    })
  }

  private authenticate(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID()
      // CAP-1 interim gate: present the resolved web auth token (URL #token=
      // fragment → localStorage), falling back to the legacy 'dev' placeholder that
      // ungated servers accept. Mirrors WsAcpTransport's auth_required handling.
      const frame: WsRequest = {
        id,
        type: 'authenticate',
        payload: buildAuthenticatePayload(getWebAuthToken() ?? 'dev', this.deviceId)
      }
      this.pending.set(id, {
        resolve: () => resolve(),
        reject: (err) => {
          if (
            err.code === WS_ERROR_CODES.PROTOCOL_VERSION_MISMATCH ||
            err.code === WS_ERROR_CODES.INVALID_CLIENT_IDENTITY
          ) {
            this.haltHandshake(err)
          }
          reject(err)
        }
      })
      this.socket?.send(JSON.stringify(frame))
    })
  }

  private haltHandshake(err: StoreError): void {
    this.halted = err
    try {
      this.socket?.close()
    } catch {
      /* already closing */
    }
    if (err.code === WS_ERROR_CODES.PROTOCOL_VERSION_MISMATCH) {
      handleProtocolVersionMismatch('WebStoreSocket')
    } else {
      void logFrontendError({
        level: 'error',
        source: 'WebStoreSocket.handshake',
        message: `authenticate refused (${err.code}); persistence requests are stopped`
      })
    }
  }

  private rejectAll(err: StoreError): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }
}

/** Largest serialized value the host accepts (mirrors `STORE_VALUE_MAX_BYTES`). */
const STORE_VALUE_MAX_BYTES = 256 * 1024

const utf8 = new TextEncoder()

interface StoredValue<T> {
  _version: number
  data: T
}

/** Wire reply shapes (camelCase) of `store_read` / `store_write` / `store_delete`. */
interface StoreReadReply {
  value?: unknown
  revision?: number
  clientInstanceId?: string | null
}

interface StoreWriteReply {
  value?: unknown
  revision?: number
  merged?: boolean
}

/** Listener for a shared key whose merged value differs from what this page wrote. */
export type SharedChangeListener = (data: unknown, revision: number) => void

export interface WebPersistenceApi extends PersistenceApi {
  /**
   * Subscribe to shared-key changes this page learns about (by logical key).
   * Fires when a shared/lww write reply carries a merged value that differs
   * from the value written. Returns the unsubscribe function.
   */
  onSharedChange: (key: string, listener: SharedChangeListener) => () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]))
    )
  }
  return false
}

function unwrap<T>(raw: unknown): T {
  if (isRecord(raw) && '_version' in raw) return (raw as unknown as StoredValue<T>).data
  return raw as T
}

function failure(code: string, error: string): IpcResult<never> {
  return { success: false, error, code }
}

/**
 * Factory for a web-mode `PersistenceApi`. Each instance owns its debounce
 * queue, revision book and hydration state (and, via `opts`, an injectable
 * socket and device id for tests).
 *
 * Logical keys are mapped to host-store keys by `scopedKey` (device partition
 * from the page's `deviceId`, or `shared/lww` / `shared/cas`). The per-key
 * revision seen in read/write replies is tracked in memory: shared/lww writes
 * send it as `baseRevision`, shared/cas writes send `expected` + a journaled
 * `commandId`. A key whose read failed (anything but KEY_NOT_FOUND) refuses
 * writes until a later read succeeds, so defaults can never overwrite data the
 * page could not read.
 */
export function createWebPersistenceApi(opts?: {
  url?: string
  WebSocketImpl?: typeof WebSocket
  /** Test seam: the device partition to use instead of the page's stored id. */
  deviceId?: string
}): WebPersistenceApi {
  const socket = new WebStoreSocket(opts)
  const pendingDebounce = new Map<string, PendingDebounceEntry>()
  /** Last revision seen per host key; present = the key was read/written in this page. */
  const revisions = new Map<string, number>()
  /** Host keys whose last read failed with something other than KEY_NOT_FOUND. */
  const unhydrated = new Set<string>()
  /** Last known stored (wrapped) value of shared/cas keys: the default `expected`. */
  const casValues = new Map<string, unknown>()
  const listeners = new Map<string, Set<SharedChangeListener>>()
  /** Per host key operation chain: replies must land in request order. */
  const chains = new Map<string, Promise<unknown>>()

  const ok = (): IpcResult<void> => ({ success: true, data: undefined })
  const deviceId = (): string => opts?.deviceId ?? getDeviceId()

  async function toResult<T>(op: () => Promise<T>): Promise<IpcResult<T>> {
    try {
      return { success: true, data: await op() }
    } catch (err) {
      const e = err as Partial<StoreError>
      return {
        success: false,
        error: e.message ?? String(err),
        code: e.code ?? 'WS_ERROR'
      }
    }
  }

  /** Runs `op` after every earlier operation on the same host key settled. */
  function serialized<T>(hostKey: string, op: () => Promise<T>): Promise<T> {
    const prev = chains.get(hostKey) ?? Promise.resolve()
    const run = prev.then(op, op)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    chains.set(hostKey, tail)
    void tail.then(() => {
      if (chains.get(hostKey) === tail) chains.delete(hostKey)
    })
    return run
  }

  /** Why a write/delete to this key must not be sent, or null when it may go. */
  function blockedWrite(logicalKey: string, hostKey: string): IpcResult<never> | null {
    if (unhydrated.has(hostKey)) {
      return failure(
        'STORE_NOT_HYDRATED',
        `Refusing to write ${logicalKey}: its last read failed, so the stored value is unknown`
      )
    }
    if (scopeOf(logicalKey) !== 'device' && !revisions.has(hostKey)) {
      return failure(
        'STORE_BASE_REQUIRED',
        `Refusing to write ${logicalKey}: shared key was never read in this page`
      )
    }
    return null
  }

  function notifyShared(logicalKey: string, data: unknown, revision: number): void {
    for (const listener of Array.from(listeners.get(logicalKey) ?? [])) {
      try {
        listener(data, revision)
      } catch (err) {
        void logFrontendError({
          level: 'warn',
          source: 'WebPersistenceApi.onSharedChange',
          message: `shared-change listener for ${logicalKey} threw: ${String(err)}`
        })
      }
    }
  }

  /**
   * The journaled `commandId` for one CAS intent: a resend of the same write
   * (same key, expected and value) reuses the id; a different write mints one.
   */
  function casCommandId(kind: string, intent: string, explicit: string | undefined): string {
    if (explicit) return explicit
    return (findUnresolvedCommand(kind, intent) ?? openCommand(kind, intent)).commandId
  }

  /** A CAS command stays journaled only while its outcome is unknown (transport loss). */
  function settleCas(kind: string, intent: string, result: IpcResult<unknown>): void {
    const transportLoss = !result.success && result.code.startsWith('WS_')
    if (!transportLoss) {
      const entry = findUnresolvedCommand(kind, intent)
      if (entry) resolveCommand(entry.commandId)
    }
  }

  async function readRaw<T>(logicalKey: string): Promise<IpcResult<StampedValue<T>>> {
    const hostKey = scopedKey(logicalKey, deviceId())
    return serialized(hostKey, async () => {
      const result = await toResult(() =>
        socket.request<StoreReadReply>('store_read', { key: hostKey })
      )
      if (!result.success) {
        unhydrated.add(hostKey)
        return result
      }
      const reply = result.data
      const revision = typeof reply?.revision === 'number' ? reply.revision : 0
      const raw = reply?.value ?? null
      unhydrated.delete(hostKey)
      revisions.set(hostKey, raw === null ? 0 : revision)
      if (scopeOf(logicalKey) === 'sharedCas') casValues.set(hostKey, raw)
      if (raw === null) {
        return failure('KEY_NOT_FOUND', `Key not found: ${logicalKey}`)
      }
      return {
        success: true as const,
        data: {
          value: unwrap<T>(raw),
          revision,
          clientInstanceId: reply?.clientInstanceId ?? null
        }
      }
    })
  }

  async function persist<T>(
    logicalKey: string,
    data: T,
    writeOpts?: PersistenceWriteOpts
  ): Promise<IpcResult<void>> {
    return flushOrSupersede(logicalKey, () => sendWrite(logicalKey, data, writeOpts))
  }

  function sendWrite<T>(
    logicalKey: string,
    data: T,
    writeOpts?: PersistenceWriteOpts
  ): Promise<IpcResult<void>> {
    const hostKey = scopedKey(logicalKey, deviceId())
    const scope = scopeOf(logicalKey)
    const wrapped: StoredValue<T> = { _version: CURRENT_VERSION, data }
    const size = utf8.encode(JSON.stringify(wrapped)).length
    if (size > STORE_VALUE_MAX_BYTES) {
      return Promise.resolve(
        failure(
          'STORE_VALUE_TOO_LARGE',
          `value for ${logicalKey} is ${size} bytes (max ${STORE_VALUE_MAX_BYTES})`
        )
      )
    }
    return serialized(hostKey, async () => {
      const blocked = blockedWrite(logicalKey, hostKey)
      if (blocked) return blocked
      const payload: Record<string, unknown> = { key: hostKey, value: wrapped }
      let intent = ''
      let kind = ''
      if (scope === 'sharedLww') {
        payload.baseRevision = revisions.get(hostKey) ?? 0
      } else if (scope === 'sharedCas') {
        const expected =
          writeOpts?.expected === undefined
            ? (casValues.get(hostKey) ?? null)
            : writeOpts.expected === null
              ? null
              : ({
                  _version: CURRENT_VERSION,
                  data: writeOpts.expected
                } satisfies StoredValue<unknown>)
        kind = 'store_cas_write'
        intent = `${hostKey}|${JSON.stringify(expected)}|${JSON.stringify(wrapped)}`
        payload.expected = expected
        payload.commandId = casCommandId(kind, intent, writeOpts?.commandId)
      }
      const result = await toResult(() => socket.request<StoreWriteReply>('store_write', payload))
      if (kind) settleCas(kind, intent, result)
      if (!result.success) return result
      const reply = result.data
      if (typeof reply?.revision === 'number') revisions.set(hostKey, reply.revision)
      if (scope === 'sharedCas') casValues.set(hostKey, reply?.value ?? wrapped)
      if (scope === 'sharedLww' && reply?.value !== undefined) {
        const changed =
          typeof reply.merged === 'boolean' ? reply.merged : !deepEqual(reply.value, wrapped)
        if (changed) notifyShared(logicalKey, unwrap(reply.value), reply.revision ?? 0)
      }
      return ok()
    })
  }

  function sendDelete(logicalKey: string): Promise<IpcResult<void>> {
    const hostKey = scopedKey(logicalKey, deviceId())
    const scope = scopeOf(logicalKey)
    return serialized(hostKey, async () => {
      const blocked = blockedWrite(logicalKey, hostKey)
      if (blocked) return blocked
      const payload: Record<string, unknown> = { key: hostKey }
      let intent = ''
      let kind = ''
      if (scope === 'sharedLww') {
        payload.baseRevision = revisions.get(hostKey) ?? 0
      } else if (scope === 'sharedCas') {
        const expected = casValues.get(hostKey) ?? null
        kind = 'store_cas_delete'
        intent = `${hostKey}|${JSON.stringify(expected)}`
        payload.expected = expected
        payload.commandId = casCommandId(kind, intent, undefined)
      }
      const result = await toResult(() => socket.request('store_delete', payload))
      if (kind) settleCas(kind, intent, result)
      if (!result.success) return result
      if (scope !== 'device') revisions.set(hostKey, 0)
      if (scope === 'sharedCas') casValues.set(hostKey, null)
      return ok()
    })
  }

  async function flushOrSupersede(
    key: string,
    supersedeAction: () => Promise<IpcResult<void>>
  ): Promise<IpcResult<void>> {
    const existing = pendingDebounce.get(key)
    if (existing?.timer) {
      clearTimeout(existing.timer)
      existing.timer = null
    }
    pendingDebounce.delete(key)
    const result = await supersedeAction()
    if (existing) {
      existing.resolvers.forEach((resolve) => {
        resolve(result)
      })
    }
    return result
  }

  async function flushEntry(key: string, entry: PendingDebounceEntry): Promise<IpcResult<void>> {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    pendingDebounce.delete(key)
    const result = await sendWrite(key, entry.data)
    entry.resolvers.forEach((resolve) => {
      resolve(result)
    })
    return result
  }

  async function flushPendingWrites(): Promise<IpcResult<void>> {
    let firstFailure: IpcResult<void> | null = null
    for (const [key, entry] of Array.from(pendingDebounce.entries())) {
      const result = await flushEntry(key, entry)
      if (!result.success && firstFailure === null) firstFailure = result
    }
    return firstFailure ?? ok()
  }

  // Best-effort flush when the page is leaving or being backgrounded: a
  // debounced write must not die with the tab. No await — nothing can be done
  // with the outcome during unload.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushPendingWrites()
    })
    window.addEventListener('pagehide', () => {
      void flushPendingWrites()
    })
  }

  return {
    readStamped: readRaw,

    async read<T>(key: string): Promise<IpcResult<T>> {
      const result = await readRaw<T>(key)
      return result.success ? { success: true, data: result.data.value } : result
    },

    write: persist,

    async writeDebounced<T>(key: string, data: T): Promise<IpcResult<void>> {
      return new Promise((resolve) => {
        const existing = pendingDebounce.get(key)
        if (existing) {
          if (existing.timer) clearTimeout(existing.timer)
          existing.data = data
          existing.resolvers.push(resolve)
          existing.timer = setTimeout(() => void flushEntry(key, existing), DEBOUNCE_MS)
          return
        }
        const entry: PendingDebounceEntry = {
          timer: null,
          data,
          resolvers: [resolve]
        }
        pendingDebounce.set(key, entry)
        entry.timer = setTimeout(() => void flushEntry(key, entry), DEBOUNCE_MS)
      })
    },

    async delete(key: string): Promise<IpcResult<void>> {
      return flushOrSupersede(key, () => sendDelete(key))
    },

    flushPendingWrites,

    onSharedChange(key: string, listener: SharedChangeListener): () => void {
      const set = listeners.get(key) ?? new Set<SharedChangeListener>()
      set.add(listener)
      listeners.set(key, set)
      return () => {
        set.delete(listener)
      }
    }
  }
}
