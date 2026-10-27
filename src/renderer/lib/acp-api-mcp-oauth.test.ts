import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/web-server-api', () => ({
  webServerMcpOAuth: { start: vi.fn(), status: vi.fn(), disconnect: vi.fn() }
}))

import { invoke } from '@tauri-apps/api/core'
import { isTauriContext } from '@/lib/tauri-runtime'
import { webServerMcpOAuth } from '@/lib/web-server-api'
import { MCP_UNSAFE_URL, McpOAuthError, startMcpOAuth } from './acp-api'

const refused = {
  success: false,
  error: 'refused an unsafe link: only https links are allowed',
  code: 'MCP_UNSAFE_URL'
} as const

async function startFailure(): Promise<McpOAuthError> {
  const error = await startMcpOAuth('proj-1', 'https://mcp.example.com').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(McpOAuthError)
  return error as McpOAuthError
}

describe('startMcpOAuth refusal of an unsafe sign-in link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('desktop: surfaces the host refusal as MCP_UNSAFE_URL', async () => {
    vi.mocked(isTauriContext).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue(refused)

    const error = await startFailure()

    expect(invoke).toHaveBeenCalledWith('acp_mcp_oauth_start', {
      serverUrl: 'https://mcp.example.com'
    })
    expect(error.code).toBe(MCP_UNSAFE_URL)
    expect(error.message).toBe('refused an unsafe link: only https links are allowed')
  })

  it('desktop: resolves once the host reports success', async () => {
    vi.mocked(isTauriContext).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue({ success: true, data: null })

    await expect(startMcpOAuth('proj-1', 'https://mcp.example.com')).resolves.toBeUndefined()
  })

  describe('web', () => {
    const popup = { close: vi.fn(), location: { href: 'about:blank' } }
    let openSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      vi.mocked(isTauriContext).mockReturnValue(false)
      popup.location.href = 'about:blank'
      openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    })

    afterEach(() => {
      openSpy.mockRestore()
    })

    it('surfaces the host refusal as MCP_UNSAFE_URL and never navigates the popup', async () => {
      vi.mocked(webServerMcpOAuth.start).mockResolvedValue(refused)

      const error = await startFailure()

      expect(webServerMcpOAuth.start).toHaveBeenCalledWith('proj-1', 'https://mcp.example.com')
      expect(error.code).toBe(MCP_UNSAFE_URL)
      expect(popup.close).toHaveBeenCalledTimes(1)
      expect(popup.location.href).toBe('about:blank')
    })
  })
})
