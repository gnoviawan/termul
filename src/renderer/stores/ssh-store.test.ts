import type { SSHProfile } from '@shared/types/ssh.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sshApi, tauri } = vi.hoisted(() => ({
  sshApi: { saveProfile: vi.fn(async () => ({ success: true as const, data: undefined })) },
  tauri: { current: true }
}))
vi.mock('@/lib/api', () => ({ sshApi }))
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriContext: () => tauri.current
}))

import { useSSHStore } from './ssh-store'

const host = (overrides: Partial<SSHProfile> = {}): SSHProfile => ({
  id: 'p1',
  name: 'Web',
  host: 'web.example',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  portForwards: [],
  ...overrides
})

beforeEach(() => {
  useSSHStore.setState({ profiles: [] })
})

describe('saveProfile secret flags', () => {
  it('marks a typed password as saved in the desktop keychain', async () => {
    tauri.current = true
    await useSSHStore.getState().saveProfile(host({ password: 'pw' }))
    const saved = useSSHStore.getState().profiles[0]
    expect(saved.hasStoredPassword).toBe(true)
    expect(saved.password).toBeUndefined()
  })

  it('never claims a keychain secret in the web client, which stores none', async () => {
    tauri.current = false
    await useSSHStore.getState().saveProfile(host({ password: 'pw', hasStoredPassword: true }))
    const saved = useSSHStore.getState().profiles[0]
    expect(saved.hasStoredPassword).toBe(false)
    expect(saved.hasStoredPassphrase).toBe(false)
    expect(saved.password).toBeUndefined()
  })
})
