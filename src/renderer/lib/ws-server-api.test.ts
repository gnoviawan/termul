import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wsServerApi } from './ws-server-api'
import type { WsServerStatus } from './ws-server-api'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const { invoke } = await import('@tauri-apps/api/core')
const mockInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockInvoke.mockClear()
})

describe('wsServerApi', () => {
  it('start returns success on valid invoke', async () => {
    const mockStatus: WsServerStatus = {
      isRunning: true,
      port: 9876,
      clientCount: 0,
      httpUrl: 'http://localhost:9876',
      wsUrl: 'ws://localhost:9876',
      useHttps: false,
    }
    mockInvoke.mockResolvedValueOnce(mockStatus)

    const result = await wsServerApi.start(9876, 'test-token')
    expect(result.success).toBe(true)
    expect(result.data).toEqual(mockStatus)
    expect(mockInvoke).toHaveBeenCalledWith('ws_server_start', { port: 9876, authToken: 'test-token', useHttps: false })
  })

  it('start returns error on invoke failure', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Server error'))

    const result = await wsServerApi.start(9876, 'test-token')
    expect(result.success).toBe(false)
    expect(result.error).toBe('Server error')
  })

  it('stop returns success on valid invoke', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)

    const result = await wsServerApi.stop()
    expect(result.success).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('ws_server_stop')
  })

  it('stop returns error on invoke failure', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Not running'))

    const result = await wsServerApi.stop()
    expect(result.success).toBe(false)
    expect(result.error).toBe('Not running')
  })

  it('getStatus returns status on valid invoke', async () => {
    const mockStatus: WsServerStatus = {
      isRunning: true,
      port: 9876,
      clientCount: 2,
      httpUrl: 'http://192.168.1.10:9876',
      wsUrl: 'ws://192.168.1.10:9876',
      useHttps: false,
    }
    mockInvoke.mockResolvedValueOnce(mockStatus)

    const status = await wsServerApi.getStatus()
    expect(status).toEqual(mockStatus)
  })

  it('getStatus returns default on failure', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Not available'))

    const status = await wsServerApi.getStatus()
    expect(status.isRunning).toBe(false)
    expect(status.port).toBe(9876)
    expect(status.clientCount).toBe(0)
  })

  it('generateToken returns token on valid invoke', async () => {
    mockInvoke.mockResolvedValueOnce('abc123token')

    const token = await wsServerApi.generateToken()
    expect(token).toBe('abc123token')
    expect(mockInvoke).toHaveBeenCalledWith('ws_server_get_token')
  })

  it('generateToken returns empty string on failure', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Failed'))

    const token = await wsServerApi.generateToken()
    expect(token).toBe('')
  })
})
