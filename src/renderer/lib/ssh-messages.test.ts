import type { SSHProfile } from '@shared/types/ssh.types'
import { describe, expect, it } from 'vitest'
import {
  addressLabel,
  describeSessionEnd,
  describeSSHError,
  hostLabel,
  SSH_STAGES,
  stageLabel
} from './ssh-messages'

const profile: SSHProfile = {
  id: 'p1',
  name: 'Web',
  host: 'web.example',
  port: 2222,
  username: 'deploy',
  authMethod: 'password',
  portForwards: []
}

/** Every code the backend can return (`ConnectErrorKind::code`) plus renderer ones. */
const CODES = [
  'SSH_INVALID_TARGET',
  'SSH_DNS_FAILED',
  'SSH_CONNECTION_REFUSED',
  'SSH_TIMEOUT',
  'SSH_UNREACHABLE',
  'SSH_HANDSHAKE_FAILED',
  'SSH_HOST_KEY_REJECTED',
  'SSH_HOST_KEY_CHANGED',
  'SSH_HOST_KEY_UNKNOWN',
  'SSH_PASSWORD_REQUIRED',
  'SSH_PASSPHRASE_REQUIRED',
  'SSH_PASSPHRASE_INCORRECT',
  'SSH_AUTH_FAILED',
  'SSH_AUTH_METHOD_UNAVAILABLE',
  'SSH_KEY_NOT_FOUND',
  'SSH_KEY_INVALID',
  'SSH_AGENT_UNAVAILABLE',
  'SSH_CANCELLED',
  'SSH_SHELL_FAILED',
  'SSH_TERMINAL_LIMIT',
  'SSH_PROFILE_NOT_FOUND',
  'WEB_UNSUPPORTED'
]

describe('describeSSHError', () => {
  it('has specific copy (title + next step) for every known code', () => {
    const generic = describeSSHError('SOMETHING_NEW', profile)
    for (const code of CODES) {
      const message = describeSSHError(code, profile)
      expect(message.title, code).not.toBe(generic.title)
      expect(message.body.length, code).toBeGreaterThan(10)
      expect(message.title.endsWith('.'), code).toBe(false)
    }
  })

  it('names the host and port where it helps', () => {
    expect(describeSSHError('SSH_CONNECTION_REFUSED', profile).body).toContain('2222')
    expect(describeSSHError('SSH_DNS_FAILED', profile).title).toContain('web.example')
  })

  it('tailors auth failures to the method', () => {
    expect(describeSSHError('SSH_AUTH_FAILED', profile).title).toMatch(/password/i)
    expect(describeSSHError('SSH_AUTH_FAILED', { ...profile, authMethod: 'key' }).title).toMatch(
      /key/i
    )
    expect(describeSSHError('SSH_AUTH_FAILED', { ...profile, authMethod: 'agent' }).body).toMatch(
      /ssh-add/
    )
  })

  it('suggests editing the host only when the fix is there', () => {
    expect(describeSSHError('SSH_KEY_NOT_FOUND', profile).suggestEdit).toBe(true)
    expect(describeSSHError('SSH_TIMEOUT', profile).suggestEdit).toBe(false)
  })
})

describe('labels', () => {
  it('omits the default port', () => {
    expect(hostLabel({ host: 'a', port: 22 })).toBe('a')
    expect(addressLabel(profile)).toBe('deploy@web.example:2222')
  })

  it('labels every stage', () => {
    expect(SSH_STAGES.map((stage) => stageLabel(stage, profile))).toEqual([
      'Connect to web.example:2222',
      'Verify server identity',
      'Sign in as deploy',
      'Open shell'
    ])
  })
})

describe('describeSessionEnd', () => {
  it('explains each way a session ends', () => {
    expect(describeSessionEnd({ reason: 'lost', exitCode: null, detail: 'x' }, profile).title).toBe(
      'Connection lost'
    )
    expect(
      describeSessionEnd({ reason: 'exited', exitCode: 3, detail: null }, profile).body
    ).toContain('code 3')
    expect(describeSessionEnd({ reason: 'exited', exitCode: 0, detail: null }, profile).body).toBe(
      'The remote shell exited.'
    )
  })
})
