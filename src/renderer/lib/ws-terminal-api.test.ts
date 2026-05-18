import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWsTerminalApi } from './ws-terminal-api'
import type { WsAdapter } from '@shared/types/ws.types'

function createMockWsAdapter(): WsAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    invoke: vi.fn().mockResolvedValue({}),
    listen: vi.fn().mockReturnValue(vi.fn()),
    isConnected: vi.fn().mockReturnValue(true),
    onDisconnect: vi.fn().mockReturnValue(vi.fn()),
  }
}

describe('createWsTerminalApi', () => {
  let mockWs: WsAdapter
  let api: ReturnType<typeof createWsTerminalApi>

  beforeEach(() => {
    mockWs = createMockWsAdapter()
    api = createWsTerminalApi(mockWs)
  })

  it('spawn returns success on valid invoke', async () => {
    vi.mocked(mockWs.invoke).mockResolvedValueOnce({ id: 't1', shell: 'bash', cwd: '/home' })

    const result = await api.spawn({ shell: 'bash' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.id).toBe('t1')
    }
  })

  it('spawn returns error on invoke failure', async () => {
    vi.mocked(mockWs.invoke).mockRejectedValueOnce(new Error('Spawn failed'))

    const result = await api.spawn({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('Spawn failed')
    }
  })

  it('write returns success on valid invoke', async () => {
    vi.mocked(mockWs.invoke).mockResolvedValueOnce(null)

    const result = await api.write('t1', 'ls\n')
    expect(result.success).toBe(true)
    expect(mockWs.invoke).toHaveBeenCalledWith('terminal_write', { terminalId: 't1', data: 'ls\n' })
  })

  it('resize returns success on valid invoke', async () => {
    vi.mocked(mockWs.invoke).mockResolvedValueOnce(null)

    const result = await api.resize('t1', 80, 24)
    expect(result.success).toBe(true)
    expect(mockWs.invoke).toHaveBeenCalledWith('terminal_resize', { terminalId: 't1', cols: 80, rows: 24 })
  })

  it('kill returns success on valid invoke', async () => {
    vi.mocked(mockWs.invoke).mockResolvedValueOnce(null)

    const result = await api.kill('t1')
    expect(result.success).toBe(true)
    expect(mockWs.invoke).toHaveBeenCalledWith('terminal_kill', { terminalId: 't1' })
  })

  it('getCwd returns cwd on valid invoke', async () => {
    vi.mocked(mockWs.invoke).mockResolvedValueOnce('/home/user')

    const result = await api.getCwd('t1')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('/home/user')
    }
  })

  it('getGitBranch returns branch on valid invoke', async () => {
    vi.mocked(mockWs.invoke).mockResolvedValueOnce('main')

    const result = await api.getGitBranch('t1')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('main')
    }
  })

  it('getGitStatus returns status on valid invoke', async () => {
    vi.mocked(mockWs.invoke).mockResolvedValueOnce({ modified: 1, staged: 0, untracked: 0, ahead: 0, behind: 0, hasChanges: true })

    const result = await api.getGitStatus('t1')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data?.hasChanges).toBe(true)
    }
  })

  it('getExitCode returns exit code on valid invoke', async () => {
    vi.mocked(mockWs.invoke).mockResolvedValueOnce(0)

    const result = await api.getExitCode('t1')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe(0)
    }
  })

  it('onData returns unsubscribe function', () => {
    const unsub = api.onData(() => {})
    expect(typeof unsub).toBe('function')
    expect(mockWs.listen).toHaveBeenCalledWith('terminal-data', expect.any(Function))
  })

  it('onData handles payload with "id" key correctly', () => {
    let receivedTerminalId = ''
    let receivedData = ''
    
    api.onData((termId, data) => {
      receivedTerminalId = termId
      receivedData = data
    })

    const handler = vi.mocked(mockWs.listen).mock.calls[0][1]
    
    handler({ id: 't1', data: 'hello' })
    expect(receivedTerminalId).toBe('t1')
    expect(receivedData).toBe('hello')

    handler({ terminalId: 't2', data: 'world' })
    expect(receivedTerminalId).toBe('t2')
    expect(receivedData).toBe('world')
  })

  it('onExit returns unsubscribe function', () => {
    const unsub = api.onExit(() => {})
    expect(typeof unsub).toBe('function')
    expect(mockWs.listen).toHaveBeenCalledWith('terminal-exit', expect.any(Function))
  })

  it('onExit handles payload with "id" key correctly', () => {
    let receivedTerminalId = ''
    let receivedExitCode = -1

    api.onExit((termId, exitCode) => {
      receivedTerminalId = termId
      receivedExitCode = exitCode
    })

    const handler = vi.mocked(mockWs.listen).mock.calls[0][1]

    handler({ id: 't1', exitCode: 0 })
    expect(receivedTerminalId).toBe('t1')
    expect(receivedExitCode).toBe(0)

    handler({ terminalId: 't2', exitCode: 1 })
    expect(receivedTerminalId).toBe('t2')
    expect(receivedExitCode).toBe(1)
  })

  it('onCwdChanged returns unsubscribe function', () => {
    const unsub = api.onCwdChanged(() => {})
    expect(typeof unsub).toBe('function')
    expect(mockWs.listen).toHaveBeenCalledWith('terminal-cwd-changed', expect.any(Function))
  })

  it('updateOrphanDetection returns success (no-op)', async () => {
    const result = await api.updateOrphanDetection(true, 30)
    expect(result.success).toBe(true)
  })
})
