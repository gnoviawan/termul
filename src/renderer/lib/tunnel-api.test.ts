import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockInvoke, mockListen, mockIsTauriContext, mockCleanupTauriListener } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListen: vi.fn(),
  mockIsTauriContext: vi.fn(() => true),
  mockCleanupTauriListener: vi.fn((unlisten: Promise<() => void> | (() => void) | null | undefined) => {
    if (typeof unlisten === 'function') {
      unlisten()
    }
  })
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen
}))

vi.mock('./tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext,
  cleanupTauriListener: mockCleanupTauriListener
}))

import { tunnelApi } from './tunnel-api'

describe('tunnelApi', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockListen.mockReset()
    mockCleanupTauriListener.mockClear()
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValue({ success: true, data: [] })
    mockListen.mockImplementation(async () => () => {})
  })

  it('maps commands to the expected tunnel IPC calls', async () => {
    await tunnelApi.start({ id: 't1', name: 'Termul', localPort: 3000 })
    await tunnelApi.stop('t1')
    await tunnelApi.getStatus('t1')
    await tunnelApi.list()

    expect(mockInvoke).toHaveBeenCalledWith('tunnel_start', { config: { id: 't1', name: 'Termul', localPort: 3000 } })
    expect(mockInvoke).toHaveBeenCalledWith('tunnel_stop', { tunnelId: 't1' })
    expect(mockInvoke).toHaveBeenCalledWith('tunnel_get_status', { tunnelId: 't1' })
    expect(mockInvoke).toHaveBeenCalledTimes(4)
  })

  it('forwards tunnel status and log events to listeners', () => {
    let statusHandler: ((event: { payload: unknown }) => void) | undefined
    let logHandler: ((event: { payload: unknown }) => void) | undefined

    mockListen.mockImplementation(async (_event: string, handler: (event: { payload: unknown }) => void) => {
      if (statusHandler === undefined) statusHandler = handler
      else logHandler = handler
      return () => {}
    })

    const onStatusChanged = vi.fn()
    const onLog = vi.fn()

    const removeStatus = tunnelApi.onStatusChanged(onStatusChanged)
    const removeLog = tunnelApi.onLog(onLog)

    statusHandler?.({ payload: { tunnelId: 't1', status: 'running', publicUrl: 'https://example.com' } })
    logHandler?.({ payload: { tunnelId: 't1', line: 'connected' } })

    expect(onStatusChanged).toHaveBeenCalledWith({
      tunnelId: 't1',
      status: 'running',
      publicUrl: 'https://example.com'
    })
    expect(onLog).toHaveBeenCalledWith({ tunnelId: 't1', line: 'connected' })

    removeStatus()
    removeLog()
  })

  it('wraps invoke failures into INVOKE_ERROR results', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'))

    const result = await tunnelApi.list()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('INVOKE_ERROR')
      expect(result.error).toBe('boom')
    }
  })
})
