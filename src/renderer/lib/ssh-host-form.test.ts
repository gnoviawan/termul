import type { SSHProfile } from '@shared/types/ssh.types'
import { describe, expect, it } from 'vitest'
import {
  type HostFormValues,
  initialHostFormValues,
  parsePort,
  parseTags,
  splitAddress,
  toProfile,
  validateHostForm
} from './ssh-host-form'

const base: HostFormValues = {
  ...initialHostFormValues(null),
  host: 'example.com',
  username: 'deploy'
}

const existing: SSHProfile = {
  id: 'p1',
  name: 'Web',
  host: 'web.example',
  port: 2222,
  username: 'root',
  authMethod: 'password',
  portForwards: [],
  tags: ['prod'],
  group: 'Production',
  favorite: true,
  hasStoredPassword: true,
  lastConnected: '2026-01-01T00:00:00Z'
}

describe('validateHostForm', () => {
  it('accepts the minimal host', () => {
    expect(validateHostForm(base)).toEqual({})
  })

  it('requires an address and a username', () => {
    const errors = validateHostForm({ ...base, host: ' ', username: '' })
    expect(errors.host).toBe('Enter a hostname or IP address.')
    expect(errors.username).toBe('Enter the username to sign in with.')
  })

  it('rejects spaces and out-of-range ports', () => {
    expect(validateHostForm({ ...base, host: 'my host' }).host).toMatch(/spaces/)
    expect(validateHostForm({ ...base, username: 'a b' }).username).toMatch(/spaces/)
    for (const port of ['0', '65536', 'abc', '', '22.5']) {
      expect(validateHostForm({ ...base, port }).port).toBe('Use a port from 1 to 65535.')
    }
  })

  it('requires a key file for key authentication only', () => {
    expect(validateHostForm({ ...base, authMethod: 'key' }).privateKeyPath).toBeDefined()
    expect(
      validateHostForm({ ...base, authMethod: 'key', privateKeyPath: '~/.ssh/id_ed25519' })
    ).toEqual({})
    expect(validateHostForm({ ...base, authMethod: 'agent' })).toEqual({})
  })
})

describe('parsePort', () => {
  it('parses whole ports in range', () => {
    expect(parsePort(' 22 ')).toBe(22)
    expect(parsePort('65535')).toBe(65535)
    expect(parsePort('70000')).toBeNull()
  })
})

describe('splitAddress', () => {
  it('moves user@ and :port into their fields', () => {
    const split = splitAddress({ ...base, host: 'admin@db.internal:2200', username: '' })
    expect(split).toMatchObject({ host: 'db.internal', username: 'admin', port: '2200' })
  })

  it('keeps a username that was typed separately', () => {
    const split = splitAddress({ ...base, host: 'admin@db.internal', username: 'ops' })
    expect(split).toMatchObject({ host: 'db.internal', username: 'ops' })
  })

  it('keeps a port that was edited separately', () => {
    const values = { ...base, host: 'db.internal:2200', port: '2022' }
    expect(splitAddress(values, true)).toMatchObject({ host: 'db.internal', port: '2022' })
    expect(splitAddress(values)).toMatchObject({ host: 'db.internal', port: '2200' })
  })

  it('leaves IPv6 literals alone and reads bracketed ports', () => {
    expect(splitAddress({ ...base, host: 'fe80::1' }).host).toBe('fe80::1')
    expect(splitAddress({ ...base, host: '[fe80::1]:2222' })).toMatchObject({
      host: 'fe80::1',
      port: '2222'
    })
  })
})

describe('parseTags', () => {
  it('trims, drops empties and de-duplicates', () => {
    expect(parseTags(' prod, web ,, prod ')).toEqual(['prod', 'web'])
  })
})

describe('toProfile', () => {
  it('defaults the label to the address and sends no empty secrets', () => {
    const profile = toProfile({ ...base, password: '' }, null)
    expect(profile.name).toBe('example.com')
    expect(profile.password).toBeUndefined()
    expect(profile.id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
  })

  it('keeps metadata of an existing host and sends only the new secret', () => {
    const values = { ...initialHostFormValues(existing), password: 'n3w', group: ' ', tags: '' }
    const profile = toProfile(values, existing)
    expect(profile).toMatchObject({
      id: 'p1',
      port: 2222,
      password: 'n3w',
      favorite: true,
      lastConnected: '2026-01-01T00:00:00Z'
    })
    expect(profile.group).toBeUndefined()
    expect(profile.tags).toBeUndefined()
  })

  it('drops the key path and passphrase when not using a key', () => {
    const profile = toProfile(
      { ...base, authMethod: 'agent', privateKeyPath: '/k', passphrase: 'x' },
      null
    )
    expect(profile.privateKeyPath).toBeUndefined()
    expect(profile.passphrase).toBeUndefined()
  })

  it('never reads secrets back into the form', () => {
    const values = initialHostFormValues({ ...existing, password: 'leak' })
    expect(values.password).toBe('')
    expect(values.tags).toBe('prod')
    expect(values.port).toBe('2222')
  })
})
