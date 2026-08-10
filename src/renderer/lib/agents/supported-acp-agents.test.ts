import { describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import {
  buildSupportedAcpAgents,
  installedBinaryConfig,
  isCustomAgentEntry,
  isSupportedAcpConfigId,
  manualBinaryConfig,
  registryConfigId,
  resolveSupportedAcpAgents,
  type SupportedAcpAgentEntry
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

describe('isCustomAgentEntry', () => {
  // Distinguish a custom (pasted) agent row from a catalog/registry row so the
  // "Copy JSON" action only appears on custom agents (spec: "per saved custom
  // agent row"). The check keys off the config's id, NOT the entry's id —
  // catalog entries use `entry.id = agent.id` (no `acp-registry:` prefix).
  function entryWith(config: StoredAgentConfig | null): SupportedAcpAgentEntry {
    return {
      id: 'any',
      configId: config?.configId ?? 'any',
      agent: agent('any', {}),
      config,
      status: 'ready',
      install: null,
      manualInstall: null,
      runtimeLauncher: null,
      unavailableReason: null
    }
  }
  it('returns TRUE for a custom agent (config.id = custom-<uuid8>)', () => {
    const custom: StoredAgentConfig = {
      id: 'custom-abc12345',
      configId: 'custom-abc12345',
      name: 'H',
      command: 'node',
      args: [],
      env: {},
      allowTerminal: false
    }
    expect(isCustomAgentEntry(entryWith(custom))).toBe(true)
  })
  it('returns FALSE for a catalog override (config.id = acp-registry:<id>)', () => {
    const override: StoredAgentConfig = {
      id: 'acp-registry:gemini',
      configId: 'acp-registry:gemini',
      name: 'Gemini Override',
      command: 'gemini',
      args: [],
      env: {},
      allowTerminal: false
    }
    expect(isCustomAgentEntry(entryWith(override))).toBe(false)
  })
  it('returns FALSE for a catalog agent with a derived/hostInstalled config', () => {
    // A host-installed catalog agent carries a config whose id IS
    // `acp-registry:<id>` (from `toStoredConfig`), so it's NOT a custom agent.
    const derived = installedBinaryConfig(agent('gemini', { binary: {} }, 'Gemini'), {
      command: '/abs/gemini',
      args: ['acp']
    })
    expect(isCustomAgentEntry(entryWith(derived))).toBe(false)
  })
  it('returns FALSE when no config is present (unavailable catalog agent)', () => {
    expect(isCustomAgentEntry(entryWith(null))).toBe(false)
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
      configId: 'acp-registry:legacy',
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
      configId: 'acp-registry:opencode',
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

  it('surfaces a persisted custom agent alongside catalog agents (CAP-5)', async () => {
    listCatalogMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: { os: 'linux', arch: 'x86_64', runtimes: {} },
        agents: [
          {
            id: 'gemini',
            name: 'Gemini',
            version: '1.0.0',
            description: 'd',
            source: 'bundled',
            distribution: { npx: { package: 'gemini' } },
            runtimeRequirements: ['npx'],
            status: 'needs-runtime',
            platformTargets: []
          }
        ]
      }
    })
    const custom: StoredAgentConfig = {
      id: 'custom-abc',
      configId: 'custom-abc',
      name: 'Internal Helper',
      command: 'node',
      args: ['/path/to/agent.js'],
      env: { API_KEY: '$INTERNAL_API_KEY' },
      allowTerminal: false
    }

    const entries = await resolveSupportedAcpAgents([custom])

    const customEntry = entries.find((e) => e.id === 'custom-abc')
    expect(customEntry).toBeDefined()
    expect(customEntry?.configId).toBe('custom-abc')
    expect(customEntry?.status).toBe('ready')
    expect(customEntry?.config).toBe(custom)
    // Catalog agent still present.
    expect(entries.some((e) => e.id === 'gemini')).toBe(true)
  })

  it('persisted custom agent wins on configId collision with a registry agent (CAP-5)', async () => {
    // A persisted custom agent whose `configId` == a registry agent's configId
    // (`acp-registry:<id>`) must win over the catalog version (status 'ready',
    // the user's command/args/env). Persisted-wins is the inverse of the
    // terminal-native "built-ins win".
    listCatalogMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: { os: 'linux', arch: 'x86_64', runtimes: {} },
        agents: [
          {
            id: 'gemini',
            name: 'Gemini',
            version: '1.0.0',
            description: 'catalog version',
            source: 'bundled',
            distribution: { npx: { package: 'gemini' } },
            runtimeRequirements: ['npx'],
            status: 'needs-runtime',
            platformTargets: []
          }
        ]
      }
    })
    const overriding: StoredAgentConfig = {
      // custom agent (id NOT acp-registry:) but configId collides with the
      // registry agent's configId on purpose.
      id: 'custom-override',
      configId: registryConfigId('gemini'),
      name: 'Internal Helper',
      command: 'node',
      args: ['/path/to/internal.js'],
      env: { API_KEY: '$API_KEY' },
      allowTerminal: false
    }

    const entries = await resolveSupportedAcpAgents([overriding])

    // Exactly one entry for the colliding configId — the persisted custom one
    // wins (status 'ready', the user's command/args/env). The catalog loop
    // consumes the custom config via its configId-keyed lookup, so the entry
    // carries the catalog agent's id ('gemini') but the custom config. The
    // custom agent is NOT double-appended as a separate row (seenConfigIds
    // blocks it).
    const matching = entries.filter((e) => e.configId === registryConfigId('gemini'))
    expect(matching).toHaveLength(1)
    expect(matching[0]?.status).toBe('ready')
    expect(matching[0]?.config).toBe(overriding)
    // The custom config is surfaced (Copy JSON keys off config.id, NOT
    // entry.id, so it still identifies as a custom agent row).
    expect(matching[0]?.config?.id).toBe('custom-override')
    // No separate 'custom-override' entry — it merged into the gemini slot.
    expect(entries.filter((e) => e.id === 'custom-override')).toHaveLength(0)
  })

  it('surfaces persisted custom agents when the catalog fetch fails (degrade-mode)', async () => {
    listCatalogMock.mockResolvedValueOnce({
      success: false,
      error: 'store unavailable',
      code: 'ACP_CATALOG_UNAVAILABLE'
    })
    const custom: StoredAgentConfig = {
      id: 'custom-down',
      configId: 'custom-down',
      name: 'Offline Helper',
      command: 'node',
      args: [],
      env: {},
      allowTerminal: false
    }

    const entries = await resolveSupportedAcpAgents([custom])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('custom-down')
    expect(entries[0]?.configId).toBe('custom-down')
    expect(entries[0]?.status).toBe('ready')
    expect(entries[0]?.config).toBe(custom)
  })

  it('custom record wins over a registry override on configId collision regardless of input order', async () => {
    // CodeRabbit: precedence must be deterministic, not input-order-dependent.
    // A registry-backed override (id starts with `acp-registry:`) listed BEFORE
    // a custom agent sharing the same configId must NOT shadow the custom one.
    listCatalogMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: { os: 'linux', arch: 'x86_64', runtimes: {} },
        agents: [
          {
            id: 'gemini',
            name: 'Gemini',
            version: '1.0.0',
            description: 'catalog',
            source: 'bundled',
            distribution: { npx: { package: 'gemini' } },
            runtimeRequirements: ['npx'],
            status: 'needs-runtime',
            platformTargets: []
          }
        ]
      }
    })
    const registryOverride: StoredAgentConfig = {
      id: registryConfigId('gemini'),
      configId: registryConfigId('gemini'),
      name: 'Gemini Override',
      command: 'gemini-bin',
      args: [],
      env: {},
      allowTerminal: false
    }
    const custom: StoredAgentConfig = {
      id: 'custom-wins',
      configId: registryConfigId('gemini'),
      name: 'Internal Helper',
      command: 'node',
      args: ['/agent.js'],
      env: {},
      allowTerminal: false
    }

    // Registry override FIRST, custom SECOND — custom must still win.
    const entriesSecond = await resolveSupportedAcpAgents([registryOverride, custom])
    const matchSecond = entriesSecond.find((e) => e.configId === registryConfigId('gemini'))
    expect(matchSecond?.config).toBe(custom)

    // Custom FIRST, registry override SECOND — custom still wins.
    listCatalogMock.mockResolvedValueOnce({
      success: true,
      data: {
        host: { os: 'linux', arch: 'x86_64', runtimes: {} },
        agents: [
          {
            id: 'gemini',
            name: 'Gemini',
            version: '1.0.0',
            description: 'catalog',
            source: 'bundled',
            distribution: { npx: { package: 'gemini' } },
            runtimeRequirements: ['npx'],
            status: 'needs-runtime',
            platformTargets: []
          }
        ]
      }
    })
    const entriesFirst = await resolveSupportedAcpAgents([custom, registryOverride])
    const matchFirst = entriesFirst.find((e) => e.configId === registryConfigId('gemini'))
    expect(matchFirst?.config).toBe(custom)
  })
})
