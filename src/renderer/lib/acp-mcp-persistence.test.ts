import { PersistenceKeys } from '@shared/types/persistence.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  persistenceApi: { read: vi.fn(), write: vi.fn() }
}))
vi.mock('./log-api', () => ({
  logFrontendError: vi.fn().mockResolvedValue(undefined)
}))

import { persistenceApi } from '@/lib/api'
import {
  buildMcpServers,
  catalogInstallEntry,
  loadMcpServers,
  normalizeMcpRegistry,
  type StoredMcpServer,
  sameLaunch,
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

const NPX_PROVENANCE = {
  source: 'mcp-registry',
  name: 'io.github.example/files',
  version: '2.0.1',
  kind: 'package',
  index: 0,
  repositoryId: null,
  launchDigest: 'abc123'
} as const

describe('catalog install entries', () => {
  const committed = {
    name: 'files',
    config: {
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@example/files@2.0.1'],
      env: [{ name: 'FILES_ROOT', isSecret: false }]
    },
    secrets: [{ slot: 'env' as const, name: 'FILES_ROOT', value: '/srv/data' }],
    provenance: {
      name: 'io.github.example/files',
      version: '2.0.1',
      kind: 'package' as const,
      index: 0,
      repositoryId: null
    },
    launchDigest: 'abc123'
  }

  it('builds an enabled global entry with inline values and its provenance', () => {
    expect(catalogInstallEntry(committed, new Set(['github']), 'id-1')).toEqual({
      id: 'id-1',
      type: 'stdio',
      name: 'files',
      command: 'npx',
      args: ['-y', '@example/files@2.0.1'],
      env: [{ name: 'FILES_ROOT', value: '/srv/data' }],
      enabled: true,
      catalog: NPX_PROVENANCE
    })
  })

  it('makes the proposed name unique against the names already in the list', () => {
    expect(catalogInstallEntry(committed, new Set(['files', 'files-2']), 'id-1').name).toBe(
      'files-3'
    )
  })

  it('refuses a result missing a value the config names', () => {
    expect(() => catalogInstallEntry({ ...committed, secrets: [] }, new Set(), 'id-1')).toThrow(
      'The install result has no value for env FILES_ROOT'
    )
  })

  it('keeps catalog provenance through a load and drops a malformed one', () => {
    expect(
      normalizeMcpRegistry([
        { id: 'a', name: 'files', command: 'npx', catalog: NPX_PROVENANCE },
        { id: 'b', name: 'other', command: 'npx', catalog: { ...NPX_PROVENANCE, index: '0' } }
      ])
    ).toEqual([
      {
        id: 'a',
        type: 'stdio',
        name: 'files',
        command: 'npx',
        enabled: true,
        catalog: NPX_PROVENANCE
      },
      { id: 'b', type: 'stdio', name: 'other', command: 'npx', enabled: true }
    ])
  })

  it('leaves provenance out of what reaches an agent', () => {
    const entry = catalogInstallEntry(committed, new Set(), 'id-1')
    expect(buildMcpServers([entry], ['id-1'])).toEqual([
      {
        type: 'stdio',
        name: 'files',
        command: 'npx',
        args: ['-y', '@example/files@2.0.1'],
        env: [{ name: 'FILES_ROOT', value: '/srv/data' }]
      }
    ])
  })
})

describe('sameLaunch', () => {
  const remote = {
    type: 'http' as const,
    name: 'weather',
    url: 'https://weather.example/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer old' }]
  }

  it('ignores the name and header values but not the url or header names', () => {
    expect(
      sameLaunch(remote, {
        ...remote,
        name: 'renamed',
        headers: [{ name: 'Authorization', value: 'Bearer new' }]
      })
    ).toBe(true)
    expect(sameLaunch(remote, { ...remote, url: 'https://other.example/mcp' })).toBe(false)
    expect(sameLaunch(remote, { ...remote, headers: [{ name: 'X-Key', value: 'k' }] })).toBe(false)
    expect(sameLaunch(remote, { ...remote, type: 'sse' })).toBe(false)
  })
})

describe('registry persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads and writes the one host store key', async () => {
    vi.mocked(persistenceApi.read).mockResolvedValue({ success: true, data: registry })
    vi.mocked(persistenceApi.write).mockResolvedValue({ success: true, data: undefined })
    expect(await loadMcpServers()).toEqual(registry)
    await saveMcpServers(registry)
    expect(persistenceApi.read).toHaveBeenCalledWith(PersistenceKeys.acpMcpServers)
    expect(persistenceApi.write).toHaveBeenCalledWith(PersistenceKeys.acpMcpServers, registry)
  })

  it('returns an empty list for a missing key and throws other failures', async () => {
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

  it('throws when the write fails', async () => {
    vi.mocked(persistenceApi.write).mockResolvedValue({
      success: false,
      error: 'disk full',
      code: 'WRITE_ERROR'
    })
    await expect(saveMcpServers(registry)).rejects.toThrow('disk full')
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
    vi.mocked(persistenceApi.write).mockResolvedValue({ success: true, data: undefined })
  })

  it('drops persisted canvas-mcp-* entries on load, keeps the rest, logs the count and writes back', async () => {
    vi.mocked(persistenceApi.read).mockResolvedValue({
      success: true,
      data: [...legacy, ...registry]
    })

    expect(await loadMcpServers()).toEqual(registry)

    expect(persistenceApi.write).toHaveBeenCalledTimes(1)
    expect(persistenceApi.write).toHaveBeenCalledWith(PersistenceKeys.acpMcpServers, registry)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        message: 'removed 2 legacy canvas-mcp-* MCP registry entries'
      })
    )
  })

  it('writes nothing and logs nothing when no canvas-mcp-* entry is present', async () => {
    vi.mocked(persistenceApi.read).mockResolvedValue({ success: true, data: registry })

    expect(await loadMcpServers()).toEqual(registry)

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

    expect(await loadMcpServers()).toEqual(registry)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('disk full') })
    )

    expect(await loadMcpServers()).toEqual(registry)
    expect(persistenceApi.write).toHaveBeenCalledTimes(2)
  })
})
