import { PersistenceKeys } from '@shared/types/persistence.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedFake } from '@/lib/__tests__/shared-watch-fake'

vi.mock('@/lib/api', async () => ({
  persistenceApi: (await import('@/lib/__tests__/shared-watch-fake')).sharedFake.api
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { getAgentById, loadCustomAgents } from './custom-agents'

const agent = (id: string) => ({
  id,
  name: id,
  command: id,
  baseArgs: [],
  promptMode: 'positional' as const,
  isBuiltIn: true
})

describe('custom agents another device saved', () => {
  beforeEach(() => {
    sharedFake.reset(true)
  })

  it('enter and leave the launch cache; a remote entry can never claim to be built in', async () => {
    await loadCustomAgents()
    expect(getAgentById('mine')).toBeUndefined()

    sharedFake.remote(PersistenceKeys.customAgents, { agents: [agent('mine')] })
    expect(getAgentById('mine')).toMatchObject({ id: 'mine', isBuiltIn: false })

    sharedFake.remoteDelete(PersistenceKeys.customAgents)
    expect(getAgentById('mine')).toBeUndefined()
    expect(sharedFake.api.write).not.toHaveBeenCalled()
  })
})
