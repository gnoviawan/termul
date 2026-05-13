import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useTunnelStore } from './tunnel-store'

vi.mock('@/lib/api', () => ({
  tunnelApi: {
    list: vi.fn(async () => ({ success: true, data: [] })),
    start: vi.fn(async () => ({ success: true, data: { id: 't1', configId: 't1', status: 'running', publicUrl: 'https://example.com', pid: 123, lastError: null } })),
    stop: vi.fn(async () => ({ success: true, data: undefined })),
    onStatusChanged: vi.fn(() => () => {}),
    onLog: vi.fn(() => () => {})
  }
}))

describe('useTunnelStore', () => {
  beforeEach(() => {
    useTunnelStore.setState({ configs: [], sessions: [], logs: [], activeTunnelId: '', isLoading: false, error: null })
  })

  it('upserts sessions', () => {
    useTunnelStore.getState().upsertSession({ id: 't1', configId: 't1', status: 'starting', publicUrl: null, pid: 1, lastError: null })
    useTunnelStore.getState().upsertSession({ id: 't1', configId: 't1', status: 'running', publicUrl: 'https://x', pid: 1, lastError: null })
    expect(useTunnelStore.getState().sessions).toHaveLength(1)
    expect(useTunnelStore.getState().sessions[0]?.status).toBe('running')
  })

  it('appends logs', () => {
    useTunnelStore.getState().appendLog('t1', 'hello')
    expect(useTunnelStore.getState().logs[0]?.line).toBe('hello')
  })
})
