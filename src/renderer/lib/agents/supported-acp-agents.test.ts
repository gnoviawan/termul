import { describe, expect, it } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import {
  buildSupportedAcpAgents,
  installedBinaryConfig,
  registryConfigId,
  SUPPORTED_ACP_AGENT_IDS
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
  it('returns only the fixed supported ACP ids in product order', () => {
    const registry = [
      agent('extra', { npx: { package: 'extra' } }),
      ...SUPPORTED_ACP_AGENT_IDS.map((id) => agent(id, { npx: { package: id } }))
    ]

    const entries = buildSupportedAcpAgents([], 'windows-x86_64', registry)

    expect(entries.map((entry) => entry.id)).toEqual([...SUPPORTED_ACP_AGENT_IDS])
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
