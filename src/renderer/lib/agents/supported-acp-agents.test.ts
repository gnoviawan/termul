import { describe, expect, it } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import { ANTIGRAVITY_ACP_AGENT } from '@/lib/agents/antigravity-acp'
import {
  buildSupportedAcpAgents,
  installedBinaryConfig,
  isSupportedAcpConfigId,
  manualBinaryConfig,
  pickDefaultSupportedAgent,
  registryConfigId
} from '@/lib/agents/supported-acp-agents'

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

  it('does not select Antigravity as an implicit default', () => {
    const entries = buildSupportedAcpAgents([], 'windows-x86_64', [ANTIGRAVITY_ACP_AGENT])

    expect(entries[0]?.status).toBe('manual-install')
    expect(pickDefaultSupportedAgent(entries)).toBeNull()
  })
})

describe('isSupportedAcpConfigId', () => {
  it('accepts bundled registry ids with or without the acp-registry prefix', () => {
    expect(isSupportedAcpConfigId('acp-registry:claude-acp')).toBe(true)
    expect(isSupportedAcpConfigId('claude-acp')).toBe(true)
    expect(isSupportedAcpConfigId('acp-registry:not-in-registry')).toBe(false)
  })

  it('accepts the app-owned Antigravity ACP id', () => {
    expect(isSupportedAcpConfigId(ANTIGRAVITY_ACP_AGENT.id)).toBe(true)
    expect(isSupportedAcpConfigId(`acp-registry:${ANTIGRAVITY_ACP_AGENT.id}`)).toBe(true)
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
