import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  persistenceApi: { read: vi.fn(), write: vi.fn() }
}))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: vi.fn(() => true) }))
vi.mock('@/lib/web-server-api', () => ({
  webServerMcpServers: { get: vi.fn(), put: vi.fn() }
}))
vi.mock('@/lib/tauri-remote-api', () => ({
  syncMcpRegistryToProject: vi.fn()
}))
vi.mock('./log-api', () => ({
  logFrontendError: vi.fn().mockResolvedValue(undefined)
}))

import { persistenceApi } from '@/lib/api'
import { syncMcpRegistryToProject } from '@/lib/tauri-remote-api'
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
import { logFrontendError } from './log-api'

const registry: StoredMcpServer[] = [
  { id: 'stdio', type: 'stdio', name: 'Files', command: 'npx', enabled: true },
  { id: 'http', type: 'http', name: 'HTTP API', url: 'https://example.com/mcp', enabled: true },
  { id: 'sse', type: 'sse', name: 'Events', url: 'https://example.com/sse', enabled: true }
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

  it('normalizes legacy enabled state and warns when malformed records are skipped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      normalizeMcpRegistry([
        { id: 'legacy', name: 'Legacy', command: 'node' },
        { id: 'bad', name: 'Bad HTTP', type: 'http', url: 'not a url' },
        null
      ])
    ).toEqual([{ id: 'legacy', type: 'stdio', name: 'Legacy', command: 'node', enabled: true }])
    expect(warn).toHaveBeenCalledWith('[mcp] discarded 2 malformed registry entries')
    warn.mockRestore()
  })

  it('selects enabled supported transports and reports unsupported servers', () => {
    expect(
      selectMcpServersForAgent(registry, { mcpCapabilities: { http: false, acp: true } })
    ).toEqual({
      servers: [{ type: 'stdio', name: 'Files', command: 'npx', args: [], env: [] }],
      skipped: [
        { id: 'http', name: 'HTTP API', transport: 'http' },
        { id: 'sse', name: 'Events', transport: 'sse' }
      ],
      pending: false
    })
    expect(selectMcpServersForAgent(registry, { mcpCapabilities: { http: true } }).servers).toEqual(
      [
        { type: 'stdio', name: 'Files', command: 'npx', args: [], env: [] },
        {
          type: 'http',
          name: 'HTTP API',
          url: 'https://example.com/mcp',
          headers: []
        }
      ]
    )
  })

  it('keeps enabled transports while capabilities are still pending', () => {
    expect(selectMcpServersForAgent(registry, null)).toEqual({
      servers: [
        { type: 'stdio', name: 'Files', command: 'npx', args: [], env: [] },
        {
          type: 'http',
          name: 'HTTP API',
          url: 'https://example.com/mcp',
          headers: []
        },
        {
          type: 'sse',
          name: 'Events',
          url: 'https://example.com/sse',
          headers: []
        }
      ],
      skipped: [],
      pending: true
    })
  })

  it('strips registry-only fields when building explicit selections', () => {
    expect(buildMcpServers(registry, ['http', 'stdio', 'sse'])).toEqual([
      { type: 'http', name: 'HTTP API', url: 'https://example.com/mcp', headers: [] },
      { type: 'stdio', name: 'Files', command: 'npx', args: [], env: [] },
      { type: 'sse', name: 'Events', url: 'https://example.com/sse', headers: [] }
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

describe('desktop → project-file sync (CAP-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauriContext).mockReturnValue(true)
    vi.mocked(persistenceApi.write).mockResolvedValue({ success: true, data: undefined })
    vi.mocked(syncMcpRegistryToProject).mockResolvedValue({ success: true })
  })

  it('calls syncMcpRegistryToProject after the app-store write succeeds on desktop', async () => {
    await saveMcpServers(registry)

    // The app-store write must happen first (the source of truth).
    expect(persistenceApi.write).toHaveBeenCalledWith(ACP_MCP_KEY, registry)
    // Then the best-effort mirror to the project file (CAP-7), with the same
    // normalized registry.
    expect(syncMcpRegistryToProject).toHaveBeenCalledTimes(1)
    expect(syncMcpRegistryToProject).toHaveBeenCalledWith(registry)
  })

  it('does not call syncMcpRegistryToProject on the web path', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    vi.mocked(webServerMcpServers.put).mockResolvedValue({ success: true, data: undefined })

    await saveMcpServers(registry)

    expect(webServerMcpServers.put).toHaveBeenCalledWith(registry)
    expect(syncMcpRegistryToProject).not.toHaveBeenCalled()
  })

  it('logs and does not throw when the sync fails (non-fatal)', async () => {
    vi.mocked(syncMcpRegistryToProject).mockResolvedValue({
      success: false,
      error: 'write failed',
      code: 'MCP_REGISTRY_WRITE_ERROR'
    })

    // The app-store save must still succeed — sync is non-fatal.
    await expect(saveMcpServers(registry)).resolves.toBeUndefined()
    expect(persistenceApi.write).toHaveBeenCalledTimes(1)
    expect(syncMcpRegistryToProject).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'acp-mcp-persistence.syncMcpRegistryToProject',
        message: expect.stringContaining('MCP registry project-file sync failed')
      })
    )
  })

  it('does not call sync when the app-store write fails (throws before sync)', async () => {
    vi.mocked(persistenceApi.write).mockResolvedValue({
      success: false,
      error: 'disk full',
      code: 'WRITE_ERROR'
    })

    await expect(saveMcpServers(registry)).rejects.toThrow('disk full')
    expect(persistenceApi.write).toHaveBeenCalledTimes(1)
    // The sync must NOT run when the source-of-truth write failed — the
    // app-store is the canonical store, so mirroring a failed write would
    // desync the project file from what the app store actually holds.
    expect(syncMcpRegistryToProject).not.toHaveBeenCalled()
  })
})
