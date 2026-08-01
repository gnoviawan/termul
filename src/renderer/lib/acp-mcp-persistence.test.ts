import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  persistenceApi: { read: vi.fn(), write: vi.fn() }
}))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: vi.fn(() => true) }))
vi.mock('@/lib/web-server-api', () => ({
  webServerMcpServers: { get: vi.fn(), put: vi.fn() }
}))

import { persistenceApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { webServerMcpServers } from '@/lib/web-server-api'
import {
  ACP_MCP_KEY,
  buildMcpServers,
  loadMcpServers,
  normalizeMcpRegistry,
  type StoredMcpServer,
  saveMcpServers,
  selectMcpServersForAgent,
  transportOf,
  validateMcpServer
} from './acp-mcp-persistence'

const registry: StoredMcpServer[] = [
  { id: 'stdio', type: 'stdio', name: 'Files', command: 'npx', enabled: true },
  { id: 'http', type: 'http', name: 'HTTP API', url: 'https://example.com/mcp', enabled: true },
  { id: 'sse', type: 'sse', name: 'Events', url: 'https://example.com/sse', enabled: false }
]

describe('MCP registry helpers', () => {
  it('validates transport-specific required fields', () => {
    expect(validateMcpServer({ type: 'stdio', name: 'fs' }).valid).toBe(false)
    expect(validateMcpServer({ type: 'stdio', name: 'fs', command: 'npx' }).valid).toBe(true)
    expect(validateMcpServer({ type: 'http', name: 'api', url: 'not a url' }).valid).toBe(false)
    expect(validateMcpServer({ type: 'sse', name: 'api', url: 'https://x.test/sse' }).valid).toBe(
      true
    )
  })

  it('defaults omitted transport to stdio', () => {
    expect(transportOf({ name: 'fs', command: 'x' })).toBe('stdio')
  })

  it('normalizes legacy enabled state and skips malformed records', () => {
    expect(
      normalizeMcpRegistry([
        { id: 'legacy', name: 'Legacy', command: 'node' },
        { id: 'bad', name: 'Bad HTTP', type: 'http', url: 'not a url' },
        null
      ])
    ).toEqual([{ id: 'legacy', type: 'stdio', name: 'Legacy', command: 'node', enabled: true }])
  })

  it('selects enabled supported transports and reports unsupported servers', () => {
    expect(
      selectMcpServersForAgent(registry, { mcpCapabilities: { http: false, acp: true } })
    ).toEqual({
      servers: [{ type: 'stdio', name: 'Files', command: 'npx' }],
      skipped: [{ id: 'http', name: 'HTTP API', transport: 'http' }]
    })
    expect(selectMcpServersForAgent(registry, { mcpCapabilities: { http: true } }).servers).toEqual(
      [
        { type: 'stdio', name: 'Files', command: 'npx' },
        { type: 'http', name: 'HTTP API', url: 'https://example.com/mcp' }
      ]
    )
  })

  it('strips registry-only fields when building explicit selections', () => {
    expect(buildMcpServers(registry, ['http', 'stdio'])).toEqual([
      { type: 'http', name: 'HTTP API', url: 'https://example.com/mcp' },
      { type: 'stdio', name: 'Files', command: 'npx' }
    ])
  })
})

describe('registry persistence parity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauriContext).mockReturnValue(true)
  })

  it('uses desktop persistence in Tauri', async () => {
    vi.mocked(persistenceApi.read).mockResolvedValue({ success: true, data: registry })
    vi.mocked(persistenceApi.write).mockResolvedValue({ success: true, data: undefined })
    expect(await loadMcpServers()).toHaveLength(3)
    await saveMcpServers(registry)
    expect(persistenceApi.read).toHaveBeenCalledWith(ACP_MCP_KEY)
    expect(persistenceApi.write).toHaveBeenCalledWith(ACP_MCP_KEY, registry)
  })

  it('uses the shared web route outside Tauri', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    vi.mocked(webServerMcpServers.get).mockResolvedValue({ success: true, data: registry })
    vi.mocked(webServerMcpServers.put).mockResolvedValue({ success: true, data: undefined })
    expect(await loadMcpServers()).toHaveLength(3)
    await saveMcpServers(registry)
    expect(webServerMcpServers.get).toHaveBeenCalled()
    expect(webServerMcpServers.put).toHaveBeenCalledWith(registry)
  })

  it('returns an empty list for a missing desktop key and throws other failures', async () => {
    vi.mocked(persistenceApi.read).mockResolvedValue({
      success: false,
      code: 'KEY_NOT_FOUND',
      error: 'missing'
    })
    expect(await loadMcpServers()).toEqual([])
    vi.mocked(persistenceApi.read).mockResolvedValue({
      success: false,
      code: 'READ_ERROR',
      error: 'offline'
    })
    await expect(loadMcpServers()).rejects.toThrow('offline')
  })
})
