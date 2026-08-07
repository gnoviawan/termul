import { describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import {
  buildSupportedAcpAgents,
  installedBinaryConfig,
  isSupportedAcpConfigId,
  manualBinaryConfig,
  registryConfigId,
  resolveSupportedAcpAgents
} from '@/lib/agents/supported-acp-agents'

// CAP-6 / Story 8: `resolveSupportedAcpAgents` calls `acpCatalogApi.listCatalog()`
// (the host-resolved catalog). Mock the facade so the wrapper is unit-tested in
// isolation. The mock is hoisted + file-scoped; the existing
// `buildSupportedAcpAgents` tests don't touch `acpCatalogApi`, so they're
// unaffected.
const { listCatalogMock } = vi.hoisted(() => ({ listCatalogMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ acpCatalogApi: { listCatalog: listCatalogMock } }))

function agent(id: string, distribution: RegistryAgent['distribution'], name = id): RegistryAgent {
  return { id, name, version: '1.0.0', description: `${name} desc`, distribution }
}

function persisted(id: string, name = id): StoredAgentConfig {
  return {
    id: registryConfigId(id),
    templateId: id,
    name,
    command: 'custom',
    args: ['--persisted'],
    env: { FROM_DISK: '1' },
    allowTerminal: false
  }
}

describe('buildSupportedAcpAgents', () => {
  it('returns every registry agent sorted by display name', () => {
    const registry = [
      agent('zebra-id', { npx: { package: 'zebra' } }, 'Zebra'),
      agent('alpha-id', { npx: { package: 'alpha' } }, 'Alpha'),
      agent('middle-id', { npx: { package: 'middle' } }, 'Middle')
    ]

    const entries = buildSupportedAcpAgents([], 'windows-x86_64', registry)

    expect(entries.map((entry) => entry.id)).toEqual(['alpha-id', 'middle-id', 'zebra-id'])
    expect(entries.every((entry) => entry.status === 'ready')).toBe(true)
  })

  it('uses persisted configs before registry-derived defaults', () => {
    const saved = persisted('claude-acp', 'Claude Override')
    const entries = buildSupportedAcpAgents([saved], 'windows-x86_64', [
      agent('claude-acp', { npx: { package: 'claude-default' } })
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.status).toBe('ready')
    expect(entries[0]?.config).toBe(saved)
  })

  it('marks installable binary agents as install-required without a config', () => {
    const entries = buildSupportedAcpAgents([], 'windows-x86_64', [
      agent('opencode', {
        binary: {
          'windows-x86_64': {
            cmd: './opencode.exe',
            archive: 'https://example.com/opencode.zip',
            args: ['acp'],
            env: { OPENCODE: '1' }
          }
        }
      })
    ])

    expect(entries[0]).toMatchObject({
      id: 'opencode',
      configId: 'acp-registry:opencode',
      config: null,
      status: 'install-required',
      install: {
        archiveUrl: 'https://example.com/opencode.zip',
        cmd: './opencode.exe',
        args: ['acp'],
        env: { OPENCODE: '1' }
      }
    })
  })

  it('marks npx agents as needs-runtime when npx is missing', () => {
    const entries = buildSupportedAcpAgents(
      [],
      'windows-x86_64',
      [agent('claude-acp', { npx: { package: 'claude-default' } })],
      { npx: false, uvx: true }
    )

    expect(entries[0]).toMatchObject({
      id: 'claude-acp',
      status: 'needs-runtime',
      runtimeLauncher: 'npx',
      config: null
    })
  })

  it('marks uvx agents as needs-runtime when uvx is missing', () => {
    const entries = buildSupportedAcpAgents(
      [],
      'windows-x86_64',
      [agent('fast-agent', { uvx: { package: 'fast-agent-acp' } })],
      { npx: true, uvx: false }
    )

    expect(entries[0]).toMatchObject({
      id: 'fast-agent',
      status: 'needs-runtime',
      runtimeLauncher: 'uvx'
    })
  })

  it('keeps npx agents ready while runtime probe is still pending', () => {
    const entries = buildSupportedAcpAgents(
      [],
      'windows-x86_64',
      [agent('claude-acp', { npx: { package: 'claude-default' } })],
      null
    )

    expect(entries[0]?.status).toBe('ready')
  })

  it('marks binary agents without archives as manual-install', () => {
    const entries = buildSupportedAcpAgents([], 'windows-x86_64', [
      agent('legacy', {
        binary: {
          'windows-x86_64': {
            cmd: './legacy.exe',
            args: ['acp']
          }
        }
      })
    ])

    expect(entries[0]).toMatchObject({
      id: 'legacy',
      status: 'manual-install',
      manualInstall: {
        cmd: './legacy.exe',
        args: ['acp'],
        env: {}
      }
    })
  })
})

describe('isSupportedAcpConfigId', () => {
  it('accepts bundled registry ids with or without the acp-registry prefix', () => {
    expect(isSupportedAcpConfigId('acp-registry:claude-acp')).toBe(true)
    expect(isSupportedAcpConfigId('claude-acp')).toBe(true)
    expect(isSupportedAcpConfigId('acp-registry:not-in-registry')).toBe(false)
  })
})

describe('manualBinaryConfig', () => {
  it('persists a user-provided binary path with registry args and env', () => {
    const config = manualBinaryConfig(
      agent('legacy', { binary: {} }, 'Legacy Agent'),
      'C:/tools/legacy.exe',
      { cmd: './legacy.exe', args: ['acp'], env: { LEGACY: '1' } }
    )

    expect(config).toEqual({
      id: 'acp-registry:legacy',
      templateId: 'legacy',
      name: 'Legacy Agent',
      command: 'C:/tools/legacy.exe',
      args: ['acp'],
      env: { LEGACY: '1' },
      allowTerminal: false
    })
  })
})

describe('installedBinaryConfig', () => {
  it('converts installer output into a persisted registry config', () => {
    const config = installedBinaryConfig(
      agent('opencode', { binary: {} }, 'OpenCode'),
      { command: 'C:/termul/opencode.exe', args: ['acp'] },
      { env: { OPENCODE: '1' } }
    )

    expect(config).toEqual({
      id: 'acp-registry:opencode',
      templateId: 'opencode',
      name: 'OpenCode',
      command: 'C:/termul/opencode.exe',
      args: ['acp'],
      env: { OPENCODE: '1' },
      allowTerminal: false
    })
  })
})

// CAP-6 / Story 8: the host-resolved catalog wrapper. `resolveSupportedAcpAgents`
// calls `acpCatalogApi.listCatalog()` and maps `CatalogAgent` →
// `SupportedAcpAgentEntry`, consuming the host's `host.os`/`host.arch` (NOT the
// renderer's `currentPlatformArch()` / `@tauri-apps/plugin-os`).
describe('resolveSupportedAcpAgents', () => {
  it('maps a host-resolved catalog agent to a supported entry', async () => {
    listCatalogMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: {
          os: 'linux',
          arch: 'x86_64',
          runtimes: { npx: true, uvx: false, node: true, bun: false, python3: true }
        },
        agents: [
          {
            id: 'test',
            name: 'Test',
            version: '1.0.0',
            description: 'test agent',
            source: 'bundled',
            distribution: { npx: { package: 'test@1.0.0' } },
            runtimeRequirements: ['npx'],
            status: 'ready',
            platformTargets: []
          }
        ]
      }
    })

    const entries = await resolveSupportedAcpAgents([])

    expect(listCatalogMock).toHaveBeenCalledTimes(1)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'test',
      configId: 'acp-registry:test',
      status: 'ready'
    })
  })

  it('prefers a persisted config and marks it ready', async () => {
    listCatalogMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: { os: 'linux', arch: 'x86_64', runtimes: {} },
        agents: [
          {
            id: 'claude-acp',
            name: 'Claude',
            version: '1.0.0',
            description: 'd',
            source: 'bundled',
            distribution: { npx: { package: 'claude' } },
            runtimeRequirements: ['npx'],
            status: 'needs-runtime',
            platformTargets: []
          }
        ]
      }
    })
    const saved = persisted('claude-acp', 'Claude Override')

    const entries = await resolveSupportedAcpAgents([saved])

    expect(entries[0]?.config).toBe(saved)
    // Persisted configs are always 'ready' regardless of the host's status.
    expect(entries[0]?.status).toBe('ready')
  })

  it('sets install info only when the host reports install-required', async () => {
    listCatalogMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: {
          os: 'linux',
          arch: 'x86_64',
          runtimes: { npx: true, uvx: false, node: true, bun: false, python3: true }
        },
        agents: [
          {
            id: 'opencode',
            name: 'Opencode',
            version: '1.0.0',
            description: 'd',
            source: 'bundled',
            distribution: {
              binary: {
                'linux-x86_64': {
                  cmd: './opencode',
                  archive: 'https://example.com/opencode.zip',
                  sha256: 'a'.repeat(64),
                  args: ['acp'],
                  env: { OPENCODE: '1' }
                }
              }
            },
            runtimeRequirements: [],
            status: 'install-required',
            platformTargets: []
          }
        ]
      }
    })

    const entries = await resolveSupportedAcpAgents([])

    expect(entries[0]?.status).toBe('install-required')
    expect(entries[0]?.install).toMatchObject({
      archiveUrl: 'https://example.com/opencode.zip',
      cmd: './opencode',
      args: ['acp'],
      env: { OPENCODE: '1' }
    })
    expect(entries[0]?.manualInstall).toBeNull()
  })

  it('sets manualInstall (not install) when the host reports manual-install for a no-archive binary', async () => {
    // The host reports `manual-install` only for a binary target WITHOUT an
    // HTTPS archive (a no-sha256 archive is `install-required` now — the
    // trusted Zed catalog makes the install available without verification).
    // The renderer gates on the host's status so the install info reflects the
    // host's resolution: `manualInstall` carries cmd/args/env (no download).
    listCatalogMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: {
          os: 'linux',
          arch: 'x86_64',
          runtimes: { npx: true, uvx: false, node: true, bun: false, python3: true }
        },
        agents: [
          {
            id: 'no-archive',
            name: 'NoArchive',
            version: '1.0.0',
            description: 'd',
            source: 'bundled',
            distribution: {
              binary: {
                'linux-x86_64': {
                  cmd: './no-archive',
                  // NOTE: no `archive` — the host reports `manual-install`.
                  args: ['acp'],
                  env: { NO_ARCHIVE: '1' }
                }
              }
            },
            runtimeRequirements: [],
            status: 'manual-install',
            platformTargets: []
          }
        ]
      }
    })

    const entries = await resolveSupportedAcpAgents([])

    expect(entries[0]?.status).toBe('manual-install')
    // `install` must be null (the host offers no download).
    expect(entries[0]?.install).toBeNull()
    // `manualInstall` carries the cmd/args/env (no archiveUrl — manual install
    // does not download).
    expect(entries[0]?.manualInstall).toMatchObject({
      cmd: './no-archive',
      args: ['acp'],
      env: { NO_ARCHIVE: '1' }
    })
  })

  it('builds a spawn config from host `installed` when a host-installed agent is ready (no renderer persistence)', async () => {
    // The host overlays installed state: a host-installed binary agent is
    // reported `ready` with an `installed` block carrying the host-resolved
    // absolute `command`/`args`. The web client (no renderer persistence)
    // must build a spawn config from that `installed` block — without it, the
    // web could not reuse a host install.
    listCatalogMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: {
          os: 'linux',
          arch: 'x86_64',
          runtimes: { npx: true, uvx: false, node: true, bun: false, python3: true }
        },
        agents: [
          {
            id: 'host-installed',
            name: 'HostInstalled',
            version: '1.0.0',
            description: 'd',
            source: 'bundled',
            distribution: {
              binary: {
                'linux-x86_64': {
                  cmd: './host-installed',
                  archive: 'https://example.com/host-installed.zip',
                  args: ['acp'],
                  env: { HOST: '1' }
                }
              }
            },
            runtimeRequirements: [],
            status: 'ready',
            platformTargets: [],
            installed: {
              command: '/abs/acp-registry-binaries/host-installed/host-installed',
              args: ['acp']
            }
          }
        ]
      }
    })

    const entries = await resolveSupportedAcpAgents([])

    expect(entries[0]?.status).toBe('ready')
    // The config is built from the host's installed command/args (NOT the
    // distribution cmd), so the web can spawn the host-installed binary.
    expect(entries[0]?.config).toMatchObject({
      command: '/abs/acp-registry-binaries/host-installed/host-installed',
      args: ['acp'],
      env: { HOST: '1' }
    })
    expect(entries[0]?.install).toBeNull()
    expect(entries[0]?.manualInstall).toBeNull()
  })

  it('degrades to an empty list when the catalog is unavailable', async () => {
    listCatalogMock.mockResolvedValueOnce({
      success: false,
      error: 'store unavailable',
      code: 'ACP_CATALOG_UNAVAILABLE'
    })

    const entries = await resolveSupportedAcpAgents([])
    expect(entries).toEqual([])
  })
})
