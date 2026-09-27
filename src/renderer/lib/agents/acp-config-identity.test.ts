import { describe, expect, it } from 'vitest'
import { agentConfigIdentityKey, agentEnvIdentity } from './acp-config-identity'

describe('agentConfigIdentityKey', () => {
  it('is stable across env insertion order', () => {
    expect(
      agentConfigIdentityKey({
        command: 'npx',
        args: ['-y', 'droid'],
        env: { A: '1', B: '2' },
        allowTerminal: false
      })
    ).toBe(
      agentConfigIdentityKey({
        command: 'npx',
        args: ['-y', 'droid'],
        env: { B: '2', A: '1' },
        allowTerminal: false
      })
    )
  })

  it('sorts env keys deterministically (Object.keys().sort())', () => {
    const key = agentConfigIdentityKey({
      command: 'npx',
      args: [],
      env: { B: '2', A: '1', C: '3' },
      allowTerminal: false
    })
    expect(key).toBe(
      JSON.stringify({
        command: 'npx',
        args: [],
        env: { A: '1', B: '2', C: '3' },
        allowTerminal: false
      })
    )
  })

  it('distinguishes command, args, env values, and allowTerminal', () => {
    const base = { command: 'npx', args: ['-y', 'x'], env: {}, allowTerminal: false }
    expect(agentConfigIdentityKey(base)).not.toBe(
      agentConfigIdentityKey({ ...base, command: 'uvx' })
    )
    expect(agentConfigIdentityKey(base)).not.toBe(
      agentConfigIdentityKey({ ...base, args: ['-y', 'y'] })
    )
    expect(agentConfigIdentityKey(base)).not.toBe(
      agentConfigIdentityKey({ ...base, env: { K: 'v' } })
    )
    expect(agentConfigIdentityKey(base)).not.toBe(
      agentConfigIdentityKey({ ...base, allowTerminal: true })
    )
  })

  it('treats an absent allowTerminal as false', () => {
    expect(
      agentConfigIdentityKey({ command: 'npx', args: [], env: {}, allowTerminal: false })
    ).toBe(agentConfigIdentityKey({ command: 'npx', args: [], env: {} }))
  })
})

describe('agentEnvIdentity', () => {
  it('is stable across insertion order and distinguishes values', () => {
    expect(agentEnvIdentity({ A: '1', B: '2' })).toBe(agentEnvIdentity({ B: '2', A: '1' }))
    expect(agentEnvIdentity({ A: '1' })).not.toBe(agentEnvIdentity({ A: '2' }))
    expect(agentEnvIdentity({})).toBe('{}')
  })
})
