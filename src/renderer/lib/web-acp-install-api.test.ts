import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock isTauriContext to return false so the adapter uses fetch
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => false
}))

import { webAcpInstallApi } from './web-acp-install-api'

describe('webAcpInstallApi', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'http://localhost:8080' } })
  })

  it('installAgent hits POST /acp/install with { agentId } body and maps IpcBody success', async () => {
    const outcome = { command: '/path/to/opencode', args: ['acp'] }
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: outcome })
    })

    const result = await webAcpInstallApi.installAgent('opencode')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/acp/install',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ agentId: 'opencode' })
      })
    )
    expect(result.success).toBe(true)
    expect(result.data).toEqual(outcome)
  })

  it('installAgent maps non-2xx HTTP to NETWORK_ERROR', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    })

    const result = await webAcpInstallApi.installAgent('opencode')

    expect(result.success).toBe(false)
    expect(result.code).toBe('NETWORK_ERROR')
  })

  it('installAgent maps fetch throw to NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    const result = await webAcpInstallApi.installAgent('opencode')

    expect(result.success).toBe(false)
    expect(result.code).toBe('NETWORK_ERROR')
  })

  it('installAgent maps IpcBody error (INTEGRITY_MISMATCH)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: false,
        error: 'downloaded archive sha256 does not match the catalog digest',
        code: 'INTEGRITY_MISMATCH'
      })
    })

    const result = await webAcpInstallApi.installAgent('tampered')

    expect(result.success).toBe(false)
    expect(result.code).toBe('INTEGRITY_MISMATCH')
  })
})
