import { describe, expect, it, vi } from 'vitest'
import {
  currentPlatformArch,
  deriveAgentConfig,
  REGISTRY_AGENTS,
  type RegistryAgent
} from '@/lib/agents/acp-registry'

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'windows'),
  arch: vi.fn(() => 'x86_64')
}))

import { arch, platform } from '@tauri-apps/plugin-os'

function agent(distribution: RegistryAgent['distribution']): RegistryAgent {
  return { id: 'x', name: 'Agent X', version: '1.0.0', description: 'desc', distribution }
}

describe('currentPlatformArch', () => {
  it('renames macos to darwin and keeps arch token', () => {
    vi.mocked(platform).mockReturnValueOnce('macos')
    vi.mocked(arch).mockReturnValueOnce('aarch64')
    expect(currentPlatformArch()).toBe('darwin-aarch64')
  })

  it('keeps linux/windows os tokens as-is', () => {
    vi.mocked(platform).mockReturnValueOnce('linux')
    vi.mocked(arch).mockReturnValueOnce('x86_64')
    expect(currentPlatformArch()).toBe('linux-x86_64')
  })
})

describe('deriveAgentConfig', () => {
  it('derives an npx distribution with -y prefix', () => {
    const res = deriveAgentConfig(
      agent({ npx: { package: '@google/gemini-cli@0.45.0', args: ['--acp'] } }),
      'windows-x86_64'
    )
    expect(res).toEqual({
      kind: 'runnable',
      config: {
        name: 'Agent X',
        command: 'npx',
        args: ['-y', '@google/gemini-cli@0.45.0', '--acp'],
        env: {},
        allowTerminal: false
      }
    })
  })

  it('derives a uvx distribution without the -y prefix', () => {
    const res = deriveAgentConfig(
      agent({ uvx: { package: 'fast-agent-acp==0.7.15', args: ['-x'] } }),
      'linux-x86_64'
    )
    expect(res).toMatchObject({
      kind: 'runnable',
      config: { command: 'uvx', args: ['fast-agent-acp==0.7.15', '-x'] }
    })
  })

  it('carries launcher env into the derived config', () => {
    const res = deriveAgentConfig(
      agent({
        npx: { package: '@augmentcode/auggie@0.28.0', env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' } }
      }),
      'windows-x86_64'
    )
    expect(res).toMatchObject({
      kind: 'runnable',
      config: { env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' } }
    })
  })

  it('passes https archive URL into needs-install when present', () => {
    const res = deriveAgentConfig(
      agent({
        binary: {
          'windows-x86_64': {
            cmd: './amp-acp.exe',
            archive: 'https://example.com/amp.zip'
          }
        }
      }),
      'windows-x86_64'
    )
    expect(res).toMatchObject({
      kind: 'needs-install',
      archiveUrl: 'https://example.com/amp.zip'
    })
  })

  it('accepts .tar.gz / .tgz and ignores query strings', () => {
    const targz = deriveAgentConfig(
      agent({ binary: { 'linux-x86_64': { cmd: './x', archive: 'https://e.com/x.tar.gz?t=1' } } }),
      'linux-x86_64'
    )
    expect(targz).toMatchObject({ archiveUrl: 'https://e.com/x.tar.gz?t=1' })
  })

  it('rejects archive formats the installer cannot extract', () => {
    for (const archive of [
      'https://e.com/x.tar.bz2',
      'https://e.com/x.exe',
      'http://e.com/x.zip'
    ]) {
      const res = deriveAgentConfig(
        agent({ binary: { 'windows-x86_64': { cmd: './x.exe', archive } } }),
        'windows-x86_64'
      )
      expect(res).toMatchObject({ kind: 'needs-install', archiveUrl: undefined })
    }
  })

  it('returns needs-install for a binary present on the current platform-arch', () => {
    const res = deriveAgentConfig(
      agent({ binary: { 'windows-x86_64': { cmd: './stakpak.exe', args: ['acp'] } } }),
      'windows-x86_64'
    )
    expect(res).toEqual({
      kind: 'needs-install',
      cmd: './stakpak.exe',
      args: ['acp'],
      env: {},
      archiveUrl: undefined
    })
  })

  it('carries per-platform binary env into needs-install', () => {
    const res = deriveAgentConfig(
      agent({
        binary: {
          'windows-x86_64': { cmd: 'vtcode.exe', args: ['acp'], env: { VT_ACP_ENABLED: '1' } }
        }
      }),
      'windows-x86_64'
    )
    expect(res).toEqual({
      kind: 'needs-install',
      cmd: 'vtcode.exe',
      args: ['acp'],
      env: { VT_ACP_ENABLED: '1' },
      archiveUrl: undefined
    })
  })

  it('rejects a flag-like package and falls through to binary/unavailable', () => {
    const res = deriveAgentConfig(
      agent({ npx: { package: '--evil-flag' }, binary: { 'windows-x86_64': { cmd: './x.exe' } } }),
      'windows-x86_64'
    )
    // npx is skipped (unsafe package) -> falls through to the binary path.
    expect(res).toEqual({
      kind: 'needs-install',
      cmd: './x.exe',
      args: [],
      env: {},
      archiveUrl: undefined
    })
  })

  it('returns unavailable when no binary targets the current platform-arch', () => {
    const res = deriveAgentConfig(
      agent({ binary: { 'darwin-aarch64': { cmd: './x' } } }),
      'linux-aarch64'
    )
    expect(res).toEqual({ kind: 'unavailable' })
  })

  it('prefers npx over a co-present binary distribution', () => {
    const res = deriveAgentConfig(
      agent({
        npx: { package: '@zed-industries/codex-acp@0.15.0' },
        binary: { 'windows-x86_64': { cmd: './codex-acp.exe' } }
      }),
      'windows-x86_64'
    )
    expect(res).toMatchObject({ kind: 'runnable', config: { command: 'npx' } })
  })

  it('does not share env object references between calls', () => {
    const a = agent({ npx: { package: 'p' } })
    const r1 = deriveAgentConfig(a, 'windows-x86_64')
    const r2 = deriveAgentConfig(a, 'windows-x86_64')
    if (r1.kind !== 'runnable' || r2.kind !== 'runnable') throw new Error('expected runnable')
    expect(r1.config.env).not.toBe(r2.config.env)
  })
})

describe('REGISTRY_AGENTS snapshot', () => {
  it('exposes a non-empty, well-formed catalog', () => {
    expect(REGISTRY_AGENTS.length).toBeGreaterThan(0)
    for (const a of REGISTRY_AGENTS) {
      expect(typeof a.id).toBe('string')
      expect(a.id.length).toBeGreaterThan(0)
      expect(typeof a.name).toBe('string')
      expect(a.name.length).toBeGreaterThan(0)
      expect(typeof a.description).toBe('string')
      expect(a.distribution && typeof a.distribution).toBe('object')
    }
  })

  it('contains no duplicate ids', () => {
    const ids = REGISTRY_AGENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
