/**
 * One authenticated `/ws` request channel to a termul-server, enough to seed
 * store keys. Same handshake as the web client and gpuix/o2's tools/chat/ws.ts.
 */

import { WS_PROTOCOL_VERSION } from '../../../../src/shared/types/web-protocol.types.ts'

export interface WsClient {
  request<T = unknown>(
    type: string,
    payload: unknown,
    timeoutMs?: number,
    commandId?: string
  ): Promise<T>
  close(): void
}

export async function connectWs(opts: {
  baseUrl: string
  token: string
  deviceId: string
}): Promise<WsClient> {
  const socket = new WebSocket(`${opts.baseUrl.replace(/^http/, 'ws')}/ws`)
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>()
  let nextId = 0
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as {
      id?: string
      ok?: boolean
      payload?: unknown
      err?: { code?: string; message?: string }
    }
    if (frame.id === undefined || frame.ok === undefined) return
    const waiter = pending.get(frame.id)
    if (!waiter) return
    pending.delete(frame.id)
    if (frame.ok) waiter.resolve(frame.payload)
    else waiter.reject(new Error(`${frame.err?.code}: ${frame.err?.message}`))
  }
  const request = <T>(
    type: string,
    payload: unknown,
    timeoutMs = 15_000,
    commandId?: string
  ): Promise<T> => {
    const id = `r${nextId++}`
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`ws ${type} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    pending.set(id, { resolve: (value) => resolve(value as T), reject })
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
    clientInstanceId: 'composer-seed',
    token: opts.token
  })
  return { request, close: () => socket.close() }
}
