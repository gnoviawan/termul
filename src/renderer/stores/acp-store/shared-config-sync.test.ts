import { PersistenceKeys } from '@shared/types/persistence.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedFake } from '@/lib/__tests__/shared-watch-fake'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/api', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api')>()),
  persistenceApi: (await import('@/lib/__tests__/shared-watch-fake')).sharedFake.api
}))

import { useAcpStore } from '@/stores/acp-store'
import { rememberedAuthMethods } from './slices/agent'

const config = (id: string, command = 'agent') => ({ id, name: id, command, args: [], env: {} })

describe('shared agent configuration from another device', () => {
  beforeEach(() => {
    // The configs are watched once, on the first load, for the page's lifetime.
    sharedFake.reset(true)
    rememberedAuthMethods.clear()
  })

  it('replaces the agent configs with the remote list, normalized, without saving', async () => {
    sharedFake.seed(PersistenceKeys.acpAgents, [config('a')])
    await useAcpStore.getState().loadAgentConfigs()
    expect(useAcpStore.getState().agentConfigs.map((c) => c.id)).toEqual(['a'])

    sharedFake.remote(PersistenceKeys.acpAgents, [
      config('a'),
      config('b'),
      { id: '', name: 'bad' }
    ])

    const configs = useAcpStore.getState().agentConfigs
    expect(configs.map((c) => c.id)).toEqual(['a', 'b'])
    expect(configs[1]).toMatchObject({ configId: 'b', allowTerminal: false })
    expect(sharedFake.api.write).not.toHaveBeenCalled()
  })

  it('drops the cached options of a config whose command changed remotely', async () => {
    sharedFake.seed(PersistenceKeys.acpAgents, [config('a'), config('c')])
    await useAcpStore.getState().loadAgentConfigs()
    useAcpStore.setState({ agentOptionsCache: { a: {}, c: {} } as never })

    sharedFake.remote(PersistenceKeys.acpAgents, [config('a', 'other'), config('c')])

    expect(Object.keys(useAcpStore.getState().agentOptionsCache)).toEqual(['c'])
  })

  it('merges remembered auth methods another device saved', async () => {
    await useAcpStore.getState().loadAgentConfigs()

    sharedFake.remote(PersistenceKeys.acpAuthMethods, { a: 'oauth', '': 'x', b: 7 })

    expect(Object.fromEntries(rememberedAuthMethods)).toEqual({ a: 'oauth' })

    sharedFake.remoteDelete(PersistenceKeys.acpAuthMethods)
    expect(rememberedAuthMethods.size).toBe(0)
    expect(sharedFake.api.write).not.toHaveBeenCalled()
  })
})
