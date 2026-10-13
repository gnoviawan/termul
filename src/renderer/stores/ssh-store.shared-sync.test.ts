import { PersistenceKeys } from '@shared/types/persistence.types'
import type { SSHProfile } from '@shared/types/ssh.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedFake } from '@/lib/__tests__/shared-watch-fake'

vi.mock('@/lib/api', async () => {
  const { sharedFake: fake } = await import('@/lib/__tests__/shared-watch-fake')
  return {
    persistenceApi: fake.api,
    sshApi: {
      listProfiles: async () => {
        const result = await fake.api.read(PersistenceKeys.sshProfiles)
        return result.success ? result : { success: true, data: [] }
      }
    }
  }
})
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { useSSHStore } from './ssh-store'

const profile = (id: string): SSHProfile =>
  ({ id, name: id, host: `${id}.example`, port: 22 }) as SSHProfile

describe('ssh profiles another device saved', () => {
  beforeEach(() => {
    sharedFake.reset(true)
  })

  it('replace the profile list once it was loaded, and an empty remote key clears it', async () => {
    sharedFake.seed(PersistenceKeys.sshProfiles, [profile('a')])
    await useSSHStore.getState().loadProfiles()
    expect(useSSHStore.getState().profiles.map((p) => p.id)).toEqual(['a'])

    sharedFake.remote(PersistenceKeys.sshProfiles, [profile('a'), profile('b')])
    expect(useSSHStore.getState().profiles.map((p) => p.id)).toEqual(['a', 'b'])

    sharedFake.remoteDelete(PersistenceKeys.sshProfiles)
    expect(useSSHStore.getState().profiles).toEqual([])
    expect(sharedFake.api.write).not.toHaveBeenCalled()
  })
})
