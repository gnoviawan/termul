import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(() => true)
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: isTauriMock }))

import { createTauriClaudeAgentApi } from './tauri-claude-agent-api'

describe('createTauriClaudeAgentApi', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReturnValue(true)
  })

  it('reads credential-free setup status through the desktop command', async () => {
    const status = {
      authMode: 'claude-code',
      apiKeyConfigured: false,
      cliInstalled: true,
      cliAuthenticated: true
    }
    invokeMock.mockResolvedValueOnce({ success: true, data: status })

    const result = await createTauriClaudeAgentApi().setupStatus()

    expect(invokeMock).toHaveBeenCalledWith('acp_claude_setup_status', undefined)
    expect(result).toEqual({ success: true, data: status })
  })

  it('persists the authentication preference without exposing a secret', async () => {
    invokeMock.mockResolvedValueOnce({ success: true, data: null })

    const result = await createTauriClaudeAgentApi().setAuthMode('api-key')

    expect(invokeMock).toHaveBeenCalledWith('acp_claude_set_auth_mode', { mode: 'api-key' })
    expect(result.success).toBe(true)
  })

  it('does not expose host credential management to browser clients', async () => {
    isTauriMock.mockReturnValue(false)

    const result = await createTauriClaudeAgentApi().setupStatus()

    expect(invokeMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false, code: 'UNSUPPORTED' })
  })
})
