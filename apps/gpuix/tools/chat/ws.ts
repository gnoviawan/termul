/**
 * One authenticated `/ws` connection to a termul-server: correlated requests
 * plus a listener for session event frames. The handshake mirrors the web
 * client's (`authenticate` with protocol version, device id and token).
 */

import { WS_PROTOCOL_VERSION } from '../../../../src/shared/types/web-protocol.types.ts'

export interface EventFrame {
  sid: string
  seq: number
  type: string
  payload: Record<string, unknown>
}

interface ReplyFrame {
  id?: string
  ok?: boolean
  payload?: unknown
  err?: { code?: string; message?: string }
  sid?: string
  seq?: number
  type?: string
}

export interface WsClient {
  request<T = unknown>(
    type: string,
    payload: unknown,
    opts?: { commandId?: string; timeoutMs?: number }
  ): Promise<T>
  onEvent(listener: (frame: EventFrame, receivedAt: number) => void): () => void
  close(): void
}

const DEFAULT_TIMEOUT_MS = 15_000

export async function connectWs(opts: {
  baseUrl: string
  token: string
  deviceId: string
  clientInstanceId: string
}): Promise<WsClient> {
  const socket = new WebSocket(`${opts.baseUrl.replace(/^http/, 'ws')}/ws`)
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>()
  const listeners = new Set<(frame: EventFrame, receivedAt: number) => void>()
  let nextId = 0

  socket.onmessage = (event) => {
    const receivedAt = Date.now()
    const frame = JSON.parse(String(event.data)) as ReplyFrame
    if (frame.id !== undefined && frame.ok !== undefined) {
      const waiter = pending.get(frame.id)
      if (!waiter) return
      pending.delete(frame.id)
      if (frame.ok) waiter.resolve(frame.payload)
      else waiter.reject(new Error(`${frame.err?.code}: ${frame.err?.message}`))
      return
    }
    if (typeof frame.sid === 'string' && typeof frame.type === 'string') {
      for (const listener of listeners) listener(frame as EventFrame, receivedAt)
    }
  }
  socket.onclose = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('ws closed'))
    pending.clear()
  }

  const request = <T>(
    type: string,
    payload: unknown,
    { commandId, timeoutMs = DEFAULT_TIMEOUT_MS }: { commandId?: string; timeoutMs?: number } = {}
  ): Promise<T> => {
    const id = `r${nextId++}`
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`ws ${type} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject: (error) => reject(new Error(`ws ${type}: ${error.message}`))
    })
    socket.send(JSON.stringify({ id, type, payload, ...(commandId && { command_id: commandId }) }))
    return promise.finally(() => clearTimeout(timer))
  }

  const opened = Promise.withResolvers<void>()
  socket.onopen = () => opened.resolve()
  socket.onerror = () => opened.reject(new Error(`ws connect to ${opts.baseUrl} failed`))
  await opened.promise
  await request('authenticate', {
    protocolVersion: WS_PROTOCOL_VERSION,
    deviceId: opts.deviceId,
    clientInstanceId: opts.clientInstanceId,
    token: opts.token
  })

  return {
    request,
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => socket.close()
  }
}

/** A `commandId`: 1-128 characters of `[A-Za-z0-9_-]`. */
export function commandId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}
