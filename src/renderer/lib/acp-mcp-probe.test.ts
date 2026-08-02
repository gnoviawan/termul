import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true)
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))
vi.mock('@/lib/web-server-api', () => ({
  webServerMcpProbe: { post: vi.fn() }
}))

import { invoke } from '@tauri-apps/api/core'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { webServerMcpProbe } from '@/lib/web-server-api'
import { listMcpTools, probeMcpServer } from './acp-mcp-probe'

const stdioServer = {
  type: 'stdio' as const,
  name: 'Files',
  command: 'npx',
  args: [],
  env: []
}

const httpServer = {
  type: 'http' as const,
  name: 'Remote',
  url: 'https://example.com/mcp',
  headers: []
}

describe('acp-mcp-probe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauriContext).mockReturnValue(true)
  })

  it('invokes the Tauri command on desktop with the wire config', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 'connected', tools: [] })
    await probeMcpServer(stdioServer)
    expect(invoke).toHaveBeenCalledWith('acp_probe_mcp_server', { server: stdioServer })
  })

  it('returns the connected probe result from the Tauri command', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 'connected',
      tools: [{ name: 'read_file', description: 'read a file' }]
    })
    const result = await probeMcpServer(stdioServer)
    expect(result.status).toBe('connected')
    expect(result.tools).toEqual([{ name: 'read_file', description: 'read a file' }])
  })

  it('passes through a disconnected outcome without throwing (Tauri)', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 'disconnected',
      tools: [],
      error: 'spawn failed: ...'
    })
    const result = await probeMcpServer(stdioServer)
    expect(result.status).toBe('disconnected')
    expect(result.error).toBe('spawn failed: ...')
  })

  it('normalizes a Tauri invoke rejection to a disconnected result + logs it (canonical contract)', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('IPC transport down'))
    const result = await probeMcpServer(stdioServer)
    expect(result.status).toBe('disconnected')
    expect(result.tools).toEqual([])
    expect(result.error).toContain('IPC transport down')
    // The boundary log carries the server name but NO env/header values.
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'acp-mcp-probe.probeMcpServer',
        message: expect.stringContaining(stdioServer.name)
      })
    )
    const logged = vi.mocked(logFrontendError).mock.calls[0][0]
    expect(logged.message).toContain('IPC transport down')
  })

  it('POSTs to /mcp-servers/probe on web and unwraps the IpcBody', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    vi.mocked(webServerMcpProbe.post).mockResolvedValue({
      success: true,
      data: { status: 'connected', tools: [{ name: 'search' }] }
    })
    const result = await probeMcpServer(httpServer)
    expect(webServerMcpProbe.post).toHaveBeenCalledWith(httpServer)
    expect(result.status).toBe('connected')
    expect(result.tools).toEqual([{ name: 'search' }])
  })

  it('returns disconnected on a web transport failure (success:false) and logs it', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    vi.mocked(webServerMcpProbe.post).mockResolvedValue({
      success: false,
      code: 'NETWORK_ERROR',
      error: 'fetch failed'
    })
    const result = await probeMcpServer(httpServer)
    expect(result.status).toBe('disconnected')
    expect(result.error).toBe('fetch failed')
    // The boundary log carries the server name + code but NO env/header values.
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'acp-mcp-probe.probeMcpServer',
        message: expect.stringContaining(httpServer.name)
      })
    )
    const logged = vi.mocked(logFrontendError).mock.calls[0][0]
    expect(logged.message).toContain('NETWORK_ERROR')
    // Sanity: the log line must not echo the URL or header values (none here,
    // but the contract is enforced).
  })

  it('does NOT pass env/header values through the log path on a web failure', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    vi.mocked(webServerMcpProbe.post).mockResolvedValue({
      success: false,
      code: 'NETWORK_ERROR',
      error: 'fetch failed'
    })
    const secret = {
      type: 'stdio' as const,
      name: 'leaky',
      command: 'node',
      args: [],
      env: [{ name: 'API_KEY', value: 'super-secret-value' }]
    }
    await probeMcpServer(secret)
    const logged = vi.mocked(logFrontendError).mock.calls[0][0]
    expect(logged.message).not.toContain('super-secret-value')
  })

  it('listMcpTools returns just the tool list', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 'connected',
      tools: [{ name: 'a' }, { name: 'b' }]
    })
    const tools = await listMcpTools(stdioServer)
    expect(tools).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  it('listMcpTools returns an empty list when the probe disconnects', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 'disconnected',
      tools: [],
      error: 'unreachable'
    })
    const tools = await listMcpTools(stdioServer)
    expect(tools).toEqual([])
  })
})
