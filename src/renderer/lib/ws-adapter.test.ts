import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWsAdapter } from './ws-adapter'

vi.mock('globalThis', () => ({
  WebSocket: vi.fn(),
}))

const MockWebSocket = vi.fn()

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket)
  MockWebSocket.mockClear()
})

describe('createWsAdapter', () => {
  it('creates an adapter with expected methods', () => {
    const adapter = createWsAdapter({ url: 'ws://localhost:9876', authToken: 'test' })
    expect(typeof adapter.connect).toBe('function')
    expect(typeof adapter.disconnect).toBe('function')
    expect(typeof adapter.invoke).toBe('function')
    expect(typeof adapter.listen).toBe('function')
    expect(typeof adapter.isConnected).toBe('function')
    expect(typeof adapter.onDisconnect).toBe('function')
  })

  it('isConnected returns false before connect', () => {
    const adapter = createWsAdapter({ url: 'ws://localhost:9876', authToken: 'test' })
    expect(adapter.isConnected()).toBe(false)
  })

  it('listen returns an unsubscribe function', () => {
    const adapter = createWsAdapter({ url: 'ws://localhost:9876', authToken: 'test' })
    const unsub = adapter.listen('test-event', () => {})
    expect(typeof unsub).toBe('function')
    unsub()
  })

  it('onDisconnect returns an unsubscribe function', () => {
    const adapter = createWsAdapter({ url: 'ws://localhost:9876', authToken: 'test' })
    const unsub = adapter.onDisconnect(() => {})
    expect(typeof unsub).toBe('function')
    unsub()
  })

  it('invoke rejects when not connected', async () => {
    const adapter = createWsAdapter({ url: 'ws://localhost:9876', authToken: 'test' })
    await expect(adapter.invoke('test_method')).rejects.toThrow()
  })
})
