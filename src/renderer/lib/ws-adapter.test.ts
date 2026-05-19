import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWsAdapter } from './ws-adapter'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3

  url: string
  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  triggerMessage(data: string): void {
    this.onmessage?.({ data })
  }
}

describe('createWsAdapter', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.1234567)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('authenticates, invokes methods, and dispatches events', async () => {
    const adapter = createWsAdapter({ url: 'ws://localhost:9876', authToken: 'test-token', projectId: 'proj-1', sessionId: 'session-1', reconnectInterval: 10, maxReconnectAttempts: 1 })

    const connectPromise = adapter.connect()
    const socket = MockWebSocket.instances[0]
    expect(socket?.url).toBe('ws://localhost:9876')

    socket?.triggerOpen()
    expect(socket?.sent[0]).toBe(JSON.stringify({ type: 'auth', token: 'test-token', projectId: 'proj-1', sessionId: 'session-1' }))

    socket?.triggerMessage(JSON.stringify({ type: 'response', id: 'auth', success: true }))
    await connectPromise

    expect(adapter.isConnected()).toBe(true)

    const seenEvents: Array<Record<string, unknown>> = []
    const unlisten = adapter.listen('tunnel-status-changed', (payload) => {
      seenEvents.push(payload)
    })

    const invokePromise = adapter.invoke<{ ok: boolean }>('tunnel_start', { id: 't1' })
    const request = JSON.parse(socket?.sent[1] ?? '{}') as { id: string }

    expect(request.id).toMatch(/^req-1700000000000-/)
    socket?.triggerMessage(JSON.stringify({ type: 'event', event: 'tunnel-status-changed', payload: { tunnelId: 't1', status: 'running' } }))
    socket?.triggerMessage(JSON.stringify({ type: 'response', id: request.id, success: true, data: { ok: true } }))

    await expect(invokePromise).resolves.toEqual({ ok: true })
    expect(seenEvents).toEqual([{ tunnelId: 't1', status: 'running' }])

    unlisten()
  })

  it('rejects pending requests when the socket disconnects', async () => {
    const adapter = createWsAdapter({ url: 'ws://localhost:9876', authToken: 'test-token' })

    const connectPromise = adapter.connect()
    const socket = MockWebSocket.instances[0]
    socket?.triggerOpen()
    socket?.triggerMessage(JSON.stringify({ type: 'response', id: 'auth', success: true }))
    await connectPromise

    const pending = adapter.invoke('tunnel_list')
    adapter.disconnect()

    await expect(pending).rejects.toThrow('WebSocket disconnected')
  })

  it('reconnects after a close when attempts remain', async () => {
    const adapter = createWsAdapter({ url: 'ws://localhost:9876', authToken: 'test-token', reconnectInterval: 20, maxReconnectAttempts: 2 })

    const connectPromise = adapter.connect()
    const firstSocket = MockWebSocket.instances[0]
    firstSocket?.triggerOpen()
    firstSocket?.triggerMessage(JSON.stringify({ type: 'response', id: 'auth', success: true }))
    await connectPromise

    firstSocket?.close()
    await vi.advanceTimersByTimeAsync(20)

    expect(MockWebSocket.instances.length).toBeGreaterThan(1)
  })
})
