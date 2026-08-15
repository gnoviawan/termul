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

import type { IpcResult, PersistenceApi } from '@shared/types/ipc.types'
import type { WsRequest, WsRequestType } from '@shared/types/web-protocol.types'
import { randomUUID } from '@/lib/uuid'
import { resolveWsUrl } from './acp-transport'

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
  private readonly pending = new Map<string, PendingRequest>()
  private readonly wsUrl: string
  private readonly wsCtor: typeof WebSocket

  constructor(opts?: { url?: string; WebSocketImpl?: typeof WebSocket }) {
    this.wsUrl =
      opts?.url ?? (typeof window !== 'undefined' ? resolveWsUrl() : 'ws://127.0.0.1:8080/ws')
    this.wsCtor = opts?.WebSocketImpl ?? WebSocket
  }

  async connect(): Promise<void> {
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
      const settleOk = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const settleErr = (err: StoreError) => {
        if (settled) return
        settled = true
        reject(err)
      }

      const ws = new this.wsCtor(this.wsUrl)
      this.socket = ws
      this.authed = false

      ws.onopen = () => {
        void this.authenticate().then(() => {
          this.authed = true
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
    })
  }

  private authenticate(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID()
      const frame: WsRequest = { id, type: 'authenticate', payload: { token: 'dev' } }
      this.pending.set(id, { resolve: () => resolve(), reject })
      this.socket?.send(JSON.stringify(frame))
    })
  }

  private rejectAll(err: StoreError): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }
}

/**
 * Factory for a web-mode `PersistenceApi`. Each instance owns its debounce
 * queue (and, via `opts`, an injectable socket for tests).
 */
export function createWebPersistenceApi(opts?: {
  url?: string
  WebSocketImpl?: typeof WebSocket
}): PersistenceApi {
  const socket = new WebStoreSocket(opts)
  const pendingDebounce = new Map<string, PendingDebounceEntry>()

  const ok = (): IpcResult<void> => ({ success: true, data: undefined })

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

  async function persist<T>(key: string, data: T, expected?: T): Promise<IpcResult<void>> {
    return flushOrSupersede(key, () =>
      toResult(async () => {
        const payload: Record<string, unknown> = {
          key,
          value: { _version: CURRENT_VERSION, data }
        }
        if (expected !== undefined) {
          payload.expected = { _version: CURRENT_VERSION, data: expected }
        }
        await socket.request('store_write', payload)
      })
    )
  }

  async function flushEntry(key: string, entry: PendingDebounceEntry): Promise<IpcResult<void>> {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    pendingDebounce.delete(key)
    const result = await persist(key, entry.data)
    entry.resolvers.forEach((resolve) => {
      resolve(result)
    })
    return result
  }

  return {
    async read<T>(key: string): Promise<IpcResult<T>> {
      return toResult(async () => {
        const reply = await socket.request<{ value: unknown }>('store_read', { key })
        const raw = reply?.value ?? null
        if (raw === null || raw === undefined) {
          throw { code: 'KEY_NOT_FOUND', message: `Key not found: ${key}` } satisfies StoreError
        }
        // Versioned payload written by this API (or the desktop store).
        if (typeof raw === 'object' && raw !== null && '_version' in raw) {
          return (raw as unknown as { data: T }).data
        }
        return raw as T
      })
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
      return flushOrSupersede(key, () =>
        toResult(async () => {
          await socket.request('store_delete', { key })
        })
      )
    },

    async flushPendingWrites(): Promise<IpcResult<void>> {
      let firstFailure: IpcResult<void> | null = null
      for (const [key, entry] of Array.from(pendingDebounce.entries())) {
        const result = await flushEntry(key, entry)
        if (!result.success && firstFailure === null) firstFailure = result
      }
      return firstFailure ?? ok()
    }
  }
}
