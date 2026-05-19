import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useTunnelStore } from './tunnel-store'

const {
  mockList,
  mockStart,
  mockStop
} = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockStart: vi.fn(),
  mockStop: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  tunnelApi: {
    list: mockList,
    start: mockStart,
    stop: mockStop,
    onStatusChanged: vi.fn(() => () => {}),
    onLog: vi.fn(() => () => {})
  }
}))

describe('useTunnelStore', () => {
  beforeEach(() => {
    useTunnelStore.setState({ configs: [], sessions: [], logs: [], activeTunnelId: '', isLoading: false, error: null })
    mockList.mockReset()
    mockStart.mockReset()
    mockStop.mockReset()
    mockList.mockResolvedValue({ success: true, data: [] })
    mockStart.mockResolvedValue({
      success: true,
      data: { id: 't1', configId: 't1', status: 'running', publicUrl: 'https://example.com', pid: 123, lastError: null }
    })
    mockStop.mockResolvedValue({ success: true, data: undefined })
  })

  it('manages config lists, logs, and session merges', () => {
    useTunnelStore.getState().addConfig({ id: 't1', name: 'Tunnel', localPort: 3000 })
    useTunnelStore.getState().removeConfig('missing')
    useTunnelStore.getState().appendLog('t1', 'hello')
    useTunnelStore.getState().appendLog('t1', 'world')
    useTunnelStore.getState().clearLogs('other')
    useTunnelStore.getState().upsertSession({ id: 't1', configId: 't1', status: 'starting', publicUrl: 'https://old', pid: 1, lastError: 'old' })
    useTunnelStore.getState().upsertSession({ id: 't1', configId: 't1', status: 'running', publicUrl: null, pid: 2, lastError: null })

    expect(useTunnelStore.getState().configs).toHaveLength(1)
    expect(useTunnelStore.getState().logs).toHaveLength(2)
    expect(useTunnelStore.getState().sessions).toHaveLength(1)
    expect(useTunnelStore.getState().sessions[0]?.status).toBe('running')
    expect(useTunnelStore.getState().sessions[0]?.publicUrl).toBe('https://old')
    expect(useTunnelStore.getState().sessions[0]?.lastError).toBe('old')
  })

  it('refreshes sessions from the tunnel api', async () => {
    mockList.mockResolvedValueOnce({
      success: true,
      data: [{ id: 't2', configId: 't2', status: 'running', publicUrl: 'https://t2.example.com', pid: 2, lastError: null }]
    })

    await useTunnelStore.getState().refreshSessions()

    expect(mockList).toHaveBeenCalledTimes(1)
    expect(useTunnelStore.getState().sessions).toEqual([
      { id: 't2', configId: 't2', status: 'running', publicUrl: 'https://t2.example.com', pid: 2, lastError: null }
    ])
    expect(useTunnelStore.getState().error).toBeNull()
  })

  it('starts and stops tunnels through the api boundary', async () => {
    const session = await useTunnelStore.getState().startTunnel({ id: 't1', name: 'Tunnel', localPort: 3000 })

    expect(mockStart).toHaveBeenCalledWith({ id: 't1', name: 'Tunnel', localPort: 3000 })
    expect(session?.id).toBe('t1')
    expect(useTunnelStore.getState().activeTunnelId).toBe('t1')
    expect(useTunnelStore.getState().sessions[0]?.status).toBe('running')

    mockStop.mockResolvedValueOnce({ success: true, data: undefined })

    await expect(useTunnelStore.getState().stopTunnel('t1')).resolves.toBe(true)
    expect(mockStop).toHaveBeenCalledWith('t1')
    expect(useTunnelStore.getState().sessions[0]?.status).toBe('stopped')
  })

  it('surfaces errors from failed tunnel actions', async () => {
    mockStart.mockResolvedValueOnce({ success: false, error: 'missing cloudflared', code: 'CLOUDFLARED_NOT_FOUND' })
    mockStop.mockResolvedValueOnce({ success: false, error: 'not found', code: 'TUNNEL_NOT_FOUND' })

    await expect(useTunnelStore.getState().startTunnel({ id: 't1', name: 'Tunnel', localPort: 3000 })).resolves.toBeNull()
    expect(useTunnelStore.getState().error).toBe('missing cloudflared')

    await expect(useTunnelStore.getState().stopTunnel('t1')).resolves.toBe(false)
    expect(useTunnelStore.getState().error).toBe('not found')
  })
})
