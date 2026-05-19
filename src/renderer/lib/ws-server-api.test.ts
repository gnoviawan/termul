import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockInvoke, mockListen, mockIsTauriContext } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
  mockIsTauriContext: vi.fn(() => true)
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen
}))

vi.mock('./tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext,
  cleanupTauriListener: vi.fn()
}))

import { wsServerApi } from './ws-server-api'

describe('wsServerApi', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockListen.mockReset()
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValue(undefined)
    mockListen.mockResolvedValue(() => {})
  })

  it('maps methods to the expected commands', async () => {
    await wsServerApi.start(9876, 'test-token')
    await wsServerApi.stop()
    await wsServerApi.generateToken()
    await wsServerApi.rotateToken()
    await wsServerApi.getAuditLog()
    await wsServerApi.setActiveProject('My Project', '/path/to/project', '/bin/bash', 'blue')
    await wsServerApi.setProjects([{ id: '1', name: 'Proj' }], '1')

    expect(mockInvoke).toHaveBeenCalledWith('ws_server_start', { port: 9876, authToken: 'test-token', useHttps: false })
    expect(mockInvoke).toHaveBeenCalledWith('ws_server_stop')
    expect(mockInvoke).toHaveBeenCalledWith('ws_server_get_token')
    expect(mockInvoke).toHaveBeenCalledWith('ws_rotate_token')
    expect(mockInvoke).toHaveBeenCalledWith('ws_get_audit_log')
    expect(mockInvoke).toHaveBeenCalledWith('ws_server_set_active_project', {
      projectName: 'My Project',
      projectPath: '/path/to/project',
      defaultShell: '/bin/bash',
      color: 'blue'
    })
    expect(mockInvoke).toHaveBeenCalledWith('ws_server_set_projects', {
      projects: [{ id: '1', name: 'Proj' }],
      activeProjectId: '1'
    })
  })

  it('returns safe defaults when status lookup fails', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Not available'))

    await expect(wsServerApi.getStatus()).resolves.toEqual({
      isRunning: false,
      port: 9876,
      clientCount: 0,
      sessionId: '',
      activeProjectId: null,
      tokenTtlSecs: 900,
      httpUrl: '',
      wsUrl: '',
      useHttps: false
    })
  })

  it('registers listeners and forwards payloads', () => {
    let handler: ((event: { payload: unknown }) => void) | undefined
    mockListen.mockImplementation(async (_event: string, cb: (event: { payload: unknown }) => void) => {
      handler = cb
      return () => {}
    })

    const onStatusChanged = vi.fn()
    const unsubscribe = wsServerApi.onStatusChanged(onStatusChanged)

    handler?.({ payload: { isRunning: true, port: 9876, clientCount: 2 } })

    expect(onStatusChanged).toHaveBeenCalledWith({ isRunning: true, port: 9876, clientCount: 2 })
    unsubscribe()
  })
})
