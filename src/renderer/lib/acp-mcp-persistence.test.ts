import { PersistenceKeys } from '@shared/types/persistence.types'
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
    expect(await loadMcpServers('p1')).toHaveLength(3)
    await saveMcpServers(registry, 'p1')
    expect(persistenceApi.read).toHaveBeenCalledWith(PersistenceKeys.acpMcpServers)
    expect(persistenceApi.write).toHaveBeenCalledWith(PersistenceKeys.acpMcpServers, registry)
  })

  it('uses the shared web route outside Tauri', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    vi.mocked(webServerMcpServers.get).mockResolvedValue({ success: true, data: registry })
    vi.mocked(webServerMcpServers.put).mockResolvedValue({ success: true, data: undefined })
    expect(await loadMcpServers('p1')).toHaveLength(3)
    await saveMcpServers(registry, 'p1')
    expect(webServerMcpServers.get).toHaveBeenCalledWith('p1')
    expect(webServerMcpServers.put).toHaveBeenCalledWith('p1', registry)
  })

  it('web with no project selected loads nothing and refuses to save', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    expect(await loadMcpServers('')).toEqual([])
    await expect(saveMcpServers(registry, '')).rejects.toThrow('Select a project')
    expect(webServerMcpServers.get).not.toHaveBeenCalled()
    expect(webServerMcpServers.put).not.toHaveBeenCalled()
  })

  it('returns an empty list for a missing desktop key and throws other failures', async () => {
    vi.mocked(persistenceApi.read).mockResolvedValue({
      success: false,
      code: 'KEY_NOT_FOUND',
      error: 'missing'
    })
    expect(await loadMcpServers('p1')).toEqual([])
    vi.mocked(persistenceApi.read).mockResolvedValue({
      success: false,
      code: 'READ_ERROR',
      error: 'offline'
    })
    await expect(loadMcpServers('p1')).rejects.toThrow('offline')
  })
})

describe('legacy canvas-mcp-* migration', () => {
  const legacy = [
    {
      id: 'canvas-mcp-proj-7',
      type: 'http',
      name: 'OpenPencil Canvas',
      url: 'http://127.0.0.1:5199/canvas/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t0k' }],
      enabled: true
    },
    { id: 'canvas-mcp-proj-8', type: 'http', name: 'OpenPencil Canvas' }
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauriContext).mockReturnValue(true)
    vi.mocked(persistenceApi.write).mockResolvedValue({ success: true, data: undefined })
    vi.mocked(syncMcpRegistryToProject).mockResolvedValue({ success: true })
  })

  it('drops persisted canvas-mcp-* entries on load, keeps the rest, logs the count and writes back', async () => {
    vi.mocked(persistenceApi.read).mockResolvedValue({
      success: true,
      data: [...legacy, ...registry]
    })

    expect(await loadMcpServers('p1')).toEqual(registry)

    expect(persistenceApi.write).toHaveBeenCalledTimes(1)
    expect(persistenceApi.write).toHaveBeenCalledWith(PersistenceKeys.acpMcpServers, registry)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        message: 'removed 2 legacy canvas-mcp-* MCP registry entries'
      })
    )
  })

  it('migrates a web project file the same way', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    vi.mocked(webServerMcpServers.get).mockResolvedValue({
      success: true,
      data: [...registry, legacy[0]]
    })
    vi.mocked(webServerMcpServers.put).mockResolvedValue({ success: true, data: undefined })

    expect(await loadMcpServers('p1')).toEqual(registry)
    expect(webServerMcpServers.put).toHaveBeenCalledWith('p1', registry)
  })

  it('writes nothing and logs nothing when no canvas-mcp-* entry is present', async () => {
    vi.mocked(persistenceApi.read).mockResolvedValue({ success: true, data: registry })

    expect(await loadMcpServers('p1')).toEqual(registry)

    expect(persistenceApi.write).not.toHaveBeenCalled()
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it('still returns the cleaned registry when the write-back fails, and retries on the next load', async () => {
    vi.mocked(persistenceApi.read).mockResolvedValue({
      success: true,
      data: [...legacy, ...registry]
    })
    vi.mocked(persistenceApi.write).mockResolvedValue({
      success: false,
      error: 'disk full'
    })

    expect(await loadMcpServers('p1')).toEqual(registry)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('disk full') })
    )

    expect(await loadMcpServers('p1')).toEqual(registry)
    expect(persistenceApi.write).toHaveBeenCalledTimes(2)
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
    await saveMcpServers(registry, 'p1')

    // The app-store write must happen first (the source of truth).
    expect(persistenceApi.write).toHaveBeenCalledWith(PersistenceKeys.acpMcpServers, registry)
    // Then the best-effort mirror to the named project's file (CAP-7), with
    // the same normalized registry.
    expect(syncMcpRegistryToProject).toHaveBeenCalledTimes(1)
    expect(syncMcpRegistryToProject).toHaveBeenCalledWith('p1', registry)
  })

  it('does not call syncMcpRegistryToProject on the web path', async () => {
    vi.mocked(isTauriContext).mockReturnValue(false)
    vi.mocked(webServerMcpServers.put).mockResolvedValue({ success: true, data: undefined })

    await saveMcpServers(registry, 'p1')

    expect(webServerMcpServers.put).toHaveBeenCalledWith('p1', registry)
    expect(syncMcpRegistryToProject).not.toHaveBeenCalled()
  })

  it('logs and does not throw when the sync fails (non-fatal)', async () => {
    vi.mocked(syncMcpRegistryToProject).mockResolvedValue({
      success: false,
      error: 'write failed',
      code: 'MCP_REGISTRY_WRITE_ERROR'
    })

    // The app-store save must still succeed — sync is non-fatal.
    await expect(saveMcpServers(registry, 'p1')).resolves.toBeUndefined()
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

  it('mirrors nothing without a project, and an unregistered project is only noted', async () => {
    await saveMcpServers(registry, '')
    expect(syncMcpRegistryToProject).not.toHaveBeenCalled()

    vi.mocked(syncMcpRegistryToProject).mockResolvedValue({
      success: false,
      error: 'project not found or not available',
      code: 'NOT_FOUND'
    })
    await expect(saveMcpServers(registry, 'unregistered')).resolves.toBeUndefined()
    expect(syncMcpRegistryToProject).toHaveBeenCalledWith('unregistered', registry)
    // The host does not hold the project (e.g. shared-live never started): an
    // info note, not an error.
    expect(logFrontendError).toHaveBeenCalledWith(expect.objectContaining({ level: 'info' }))
  })

  it('does not call sync when the app-store write fails (throws before sync)', async () => {
    vi.mocked(persistenceApi.write).mockResolvedValue({
      success: false,
      error: 'disk full',
      code: 'WRITE_ERROR'
    })

    await expect(saveMcpServers(registry, 'p1')).rejects.toThrow('disk full')
    expect(persistenceApi.write).toHaveBeenCalledTimes(1)
    // The sync must NOT run when the source-of-truth write failed — the
    // app-store is the canonical store, so mirroring a failed write would
    // desync the project file from what the app store actually holds.
    expect(syncMcpRegistryToProject).not.toHaveBeenCalled()
  })
})
