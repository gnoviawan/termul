import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_ACP_AGENT,
  ANTIGRAVITY_ACP_ID,
  ANTIGRAVITY_ACP_RELEASE,
  ANTIGRAVITY_ACP_RELEASE_TARGETS,
  getAntigravityAcpReleaseTarget,
  mergeAppOwnedAcpAgents
} from '@/lib/agents/antigravity-acp'

describe('Antigravity ACP catalog', () => {
  it('pins all six v1.0.0 release targets with checksums', () => {
    expect(ANTIGRAVITY_ACP_RELEASE).toBe('1.0.0')
    expect(Object.keys(ANTIGRAVITY_ACP_RELEASE_TARGETS)).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-aarch64',
      'linux-x86_64',
      'windows-aarch64',
      'windows-x86_64'
    ])

    for (const target of Object.values(ANTIGRAVITY_ACP_RELEASE_TARGETS)) {
      expect(target.downloadUrl).toContain('/releases/download/v1.0.0/')
      expect(target.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('derives manual binary distributions for every target', () => {
    expect(ANTIGRAVITY_ACP_AGENT).toMatchObject({
      id: ANTIGRAVITY_ACP_ID,
      name: 'Antigravity',
      version: '1.0.0'
    })
    expect(Object.keys(ANTIGRAVITY_ACP_AGENT.distribution.binary ?? {})).toHaveLength(6)
    expect(ANTIGRAVITY_ACP_AGENT.distribution.npx).toBeUndefined()
    expect(ANTIGRAVITY_ACP_AGENT.distribution.uvx).toBeUndefined()
  })

  it('returns no target for an unsupported platform', () => {
    expect(getAntigravityAcpReleaseTarget('freebsd-x86_64')).toBeNull()
  })

  it('keeps app-owned agents when a remote registry is applied', () => {
    const remote = [
      { ...ANTIGRAVITY_ACP_AGENT, name: 'Remote replacement' },
      {
        id: 'remote-agent',
        name: 'Remote agent',
        version: '1.0.0',
        description: '',
        distribution: { npx: { package: 'remote-agent' } }
      }
    ]

    const merged = mergeAppOwnedAcpAgents(remote)

    expect(merged.map((agent) => agent.id)).toEqual(['remote-agent', ANTIGRAVITY_ACP_ID])
    expect(merged.find((agent) => agent.id === ANTIGRAVITY_ACP_ID)?.name).toBe('Antigravity')
  })
})
