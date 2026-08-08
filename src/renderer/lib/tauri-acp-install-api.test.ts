import { beforeEach, describe, expect, it, vi } from 'vitest'

// Use vi.hoisted so the mock fn is available when vi.mock factory runs
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

import { createTauriAcpInstallApi } from './tauri-acp-install-api'

describe('createTauriAcpInstallApi', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('installAgent invokes acp_install_agent with { request: { agentId } } and maps IpcResult success', async () => {
    const outcome = { command: '/path/to/opencode', args: ['acp'] }
    invokeMock.mockResolvedValueOnce({ success: true, data: outcome })

    const api = createTauriAcpInstallApi()
    const result = await api.installAgent('opencode')

    expect(invokeMock).toHaveBeenCalledWith('acp_install_agent', {
      request: { agentId: 'opencode' }
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual(outcome)
  })

  it('installAgent maps IpcResult failure (ACP_INSTALL_UNAVAILABLE)', async () => {
    invokeMock.mockResolvedValueOnce({
      success: false,
      error: 'acp install store is unavailable',
      code: 'ACP_INSTALL_UNAVAILABLE'
    })

    const api = createTauriAcpInstallApi()
    const result = await api.installAgent('opencode')

    expect(result.success).toBe(false)
    expect(result.code).toBe('ACP_INSTALL_UNAVAILABLE')
  })

  it('installAgent maps invoke failure to INVOKE_ERROR', async () => {
    invokeMock.mockRejectedValueOnce(new Error('IPC panic'))

    const api = createTauriAcpInstallApi()
    const result = await api.installAgent('opencode')

    expect(result.success).toBe(false)
    expect(result.code).toBe('INVOKE_ERROR')
    expect(result.error).toContain('IPC panic')
  })
})
