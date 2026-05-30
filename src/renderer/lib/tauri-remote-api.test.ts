import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { IpcResult, RemoteProjectTree, RemoteStatus } from '@shared/types/ipc.types'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

import { remoteServerApi } from './tauri-remote-api'

describe('remoteServerApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('start() forwards the Rust IpcResult unchanged (no double-wrap)', async () => {
    const status: RemoteStatus = {
      running: true,
      url: 'http://127.0.0.1:5180',
      port: 5180
    }
    const ipc: IpcResult<RemoteStatus> = { success: true, data: status }
    mockInvoke.mockResolvedValueOnce(ipc)

    const result = await remoteServerApi.start()

    expect(mockInvoke).toHaveBeenCalledWith('remote_server_start', undefined)
    expect(result).toEqual(ipc)
  })

  it('stop() calls the remote_server_stop command', async () => {
    const ipc: IpcResult<RemoteStatus> = {
      success: true,
      data: { running: false, url: null, port: null }
    }
    mockInvoke.mockResolvedValueOnce(ipc)

    const result = await remoteServerApi.stop()

    expect(mockInvoke).toHaveBeenCalledWith('remote_server_stop', undefined)
    expect(result.success).toBe(true)
  })

  it('status() calls the remote_server_status command', async () => {
    const ipc: IpcResult<RemoteStatus> = {
      success: true,
      data: { running: false, url: null, port: null }
    }
    mockInvoke.mockResolvedValueOnce(ipc)

    await remoteServerApi.status()

    expect(mockInvoke).toHaveBeenCalledWith('remote_server_status', undefined)
  })

  it('publishProjects() forwards the tree as the `tree` arg', async () => {
    const tree: RemoteProjectTree = {
      projects: [
        {
          id: 'p1',
          name: 'Proj 1',
          terminals: [{ ptyId: 'terminal-1', name: 'zsh', cwd: '/home/u' }]
        }
      ]
    }
    const ipc: IpcResult<void> = { success: true, data: undefined }
    mockInvoke.mockResolvedValueOnce(ipc)

    const result = await remoteServerApi.publishProjects(tree)

    expect(mockInvoke).toHaveBeenCalledWith('remote_publish_projects', { tree })
    expect(result.success).toBe(true)
  })

  it('wraps a thrown invoke error into a failed IpcResult', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('backend unavailable'))

    const result = await remoteServerApi.start()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('backend unavailable')
      expect(result.code).toBe('INVOKE_ERROR')
    }
  })

  it('propagates a Rust-side failure IpcResult', async () => {
    const ipc: IpcResult<RemoteStatus> = {
      success: false,
      error: 'Remote server is already running',
      code: 'REMOTE_START_FAILED'
    }
    mockInvoke.mockResolvedValueOnce(ipc)

    const result = await remoteServerApi.start()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('REMOTE_START_FAILED')
    }
  })
})
