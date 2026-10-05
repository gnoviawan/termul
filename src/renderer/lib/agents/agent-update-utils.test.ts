import { describe, expect, it } from 'vitest'

import type { RegistryAgent } from '@/lib/agents/acp-registry'
import {
  deriveAgentUpdates,
  deriveSpawnBasis,
  pinnedVersionFromLauncherArgs,
  type SupportedAcpAgentEntryLike
} from '@/lib/agents/agent-update-utils'

function npxAgent(id: string, version: string): RegistryAgent {
  return {
    id,
    name: 'Factory Droid',
    version,
    description: '',
    distribution: {
      npx: { package: `droid@${version}`, args: ['exec', '--output-format', 'acp'] }
    }
  }
}

function binaryAgent(id: string, version: string): RegistryAgent {
  return {
    id,
    name: 'Some Agent',
    version,
    description: '',
    distribution: { binary: { 'darwin-aarch64': { cmd: './someagent', args: ['acp'] } } }
  }
}

describe('pinnedVersionFromLauncherArgs', () => {
  it('extracts the pinned version from an npx -y launcher invocation', () => {
    expect(pinnedVersionFromLauncherArgs('npx', ['-y', 'droid@0.218.1', 'exec', '--acp'])).toBe(
      '0.218.1'
    )
  })

  it('extracts the version from a scoped package pin', () => {
    expect(pinnedVersionFromLauncherArgs('npx', ['-y', '@scope/agent@1.2.3'])).toBe('1.2.3')
  })

  it('returns undefined for an unpinned package', () => {
    expect(pinnedVersionFromLauncherArgs('npx', ['-y', 'droid'])).toBeUndefined()
  })

  it('returns undefined for non-package-manager commands', () => {
    expect(pinnedVersionFromLauncherArgs('/abs/path/to/someagent', ['acp'])).toBeUndefined()
  })
})

describe('deriveSpawnBasis', () => {
  it('derives the npx spawn version from the persisted config pin', () => {
    const entry = {
      id: 'factory-droid',
      configId: 'acp-registry:factory-droid',
      config: {
        id: 'acp-registry:factory-droid',
        name: 'Factory Droid',
        command: 'npx',
        args: ['-y', 'droid@0.218.1', 'exec', '--output-format', 'acp'],
        env: {},
        allowTerminal: false
      }
    } satisfies SupportedAcpAgentEntryLike

    expect(deriveSpawnBasis([entry])).toEqual([
      { agentId: 'factory-droid', spawnVersion: '0.218.1' }
    ])
  })

  it('derives the binary spawn version from the host-installed manifest version', () => {
    const entry = {
      id: 'someagent',
      configId: 'acp-registry:someagent',
      installedVersion: '0.9.5',
      config: {
        id: 'acp-registry:someagent',
        name: 'Some Agent',
        command: '/abs/someagent/0.9.5/someagent',
        args: ['acp'],
        env: {},
        allowTerminal: false
      }
    } satisfies SupportedAcpAgentEntryLike

    expect(deriveSpawnBasis([entry])).toEqual([{ agentId: 'someagent', spawnVersion: '0.9.5' }])
  })

  it('omits agents with no persisted config (they derive fresh from the registry at spawn)', () => {
    const entry = {
      id: 'factory-droid',
      configId: 'acp-registry:factory-droid',
      config: null
    } satisfies SupportedAcpAgentEntryLike

    expect(deriveSpawnBasis([entry])).toEqual([])
  })

  it('omits custom agents outside the registry', () => {
    const entry = {
      id: 'custom-abc123',
      configId: 'custom-abc123',
      config: {
        id: 'custom-abc123',
        name: 'My Agent',
        command: 'npx',
        args: ['-y', 'my-agent@1.0.0'],
        env: {},
        allowTerminal: false
      }
    } satisfies SupportedAcpAgentEntryLike

    expect(deriveSpawnBasis([entry])).toEqual([])
  })
})

describe('deriveAgentUpdates', () => {
  it('flags an npx agent whose spawn pin is older than the registry version', () => {
    const updates = deriveAgentUpdates({
      registry: [npxAgent('factory-droid', '0.219.0')],
      spawnBasis: [{ agentId: 'factory-droid', spawnVersion: '0.218.1' }]
    })

    expect(updates).toEqual([
      {
        agentId: 'factory-droid',
        configId: 'acp-registry:factory-droid',
        fromVersion: '0.218.1',
        toVersion: '0.219.0'
      }
    ])
  })

  it('flags a host-installed binary agent by its installed version, not the registry version', () => {
    const updates = deriveAgentUpdates({
      registry: [binaryAgent('someagent', '1.1.0')],
      spawnBasis: [{ agentId: 'someagent', spawnVersion: '0.9.5' }]
    })

    expect(updates).toEqual([
      {
        agentId: 'someagent',
        configId: 'acp-registry:someagent',
        fromVersion: '0.9.5',
        toVersion: '1.1.0'
      }
    ])
  })

  it('does not flag an agent whose spawn version already matches the registry', () => {
    const updates = deriveAgentUpdates({
      registry: [npxAgent('factory-droid', '0.219.0')],
      spawnBasis: [{ agentId: 'factory-droid', spawnVersion: '0.219.0' }]
    })

    expect(updates).toEqual([])
  })

  it('does not flag a registry version that is older or unparseable', () => {
    expect(
      deriveAgentUpdates({
        registry: [npxAgent('factory-droid', '0.218.0')],
        spawnBasis: [{ agentId: 'factory-droid', spawnVersion: '0.219.0' }]
      })
    ).toEqual([])
    expect(
      deriveAgentUpdates({
        registry: [npxAgent('factory-droid', '1.0.0-beta')],
        spawnBasis: [{ agentId: 'factory-droid', spawnVersion: '0.9.0' }]
      })
    ).toEqual([])
  })

  it('flags a newer dotted version, including values above the safe integer range', () => {
    expect(
      deriveAgentUpdates({
        registry: [npxAgent('codex-acp', '1.10.0')],
        spawnBasis: [{ agentId: 'codex-acp', spawnVersion: '1.9.0' }]
      })
    ).toEqual([
      {
        agentId: 'codex-acp',
        configId: 'acp-registry:codex-acp',
        fromVersion: '1.9.0',
        toVersion: '1.10.0'
      }
    ])
    expect(
      deriveAgentUpdates({
        registry: [npxAgent('codex-acp', '9007199254740993')],
        spawnBasis: [{ agentId: 'codex-acp', spawnVersion: '9007199254740992' }]
      })
    ).toEqual([
      {
        agentId: 'codex-acp',
        configId: 'acp-registry:codex-acp',
        fromVersion: '9007199254740992',
        toVersion: '9007199254740993'
      }
    ])
  })

  it('does not flag agents absent from the registry', () => {
    const updates = deriveAgentUpdates({
      registry: [npxAgent('factory-droid', '0.219.0')],
      spawnBasis: [{ agentId: 'brand-new-agent', spawnVersion: '1.0.0' }]
    })

    expect(updates).toEqual([])
  })
})
