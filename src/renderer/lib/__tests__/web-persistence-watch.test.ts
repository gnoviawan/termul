import type { StoreWatchState } from '@shared/types/web-protocol.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchHandlers } from '../acp-transport/watch-client'

const { mockTransport } = vi.hoisted(() => ({
  mockTransport: { watches: undefined as unknown }
}))
vi.mock('../acp-transport', async () => {
  const actual = await vi.importActual<typeof import('../acp-transport')>('../acp-transport')
  return { ...actual, getAcpTransport: () => mockTransport }
})
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { watchStoreKey } from '../web-persistence-api'

describe('watchStoreKey', () => {
  let handlers: WatchHandlers<StoreWatchState, StoreWatchState> | null = null
  const release = vi.fn()
  const subscribe = vi.fn(
    (_watch: string, h: WatchHandlers<StoreWatchState, StoreWatchState>, _scope?: string) => {
      handlers = h
      return release
    }
  )

  beforeEach(() => {
    handlers = null
    release.mockClear()
    subscribe.mockClear()
    mockTransport.watches = { subscribe }
  })

  it('watches the key as its scope and reports the stored data, unwrapping the version envelope', () => {
    const seen: unknown[] = []
    const unsubscribe = watchStoreKey<{ cols: number }>('layout', (change) => seen.push(change))
    expect(subscribe).toHaveBeenCalledWith('store', expect.any(Object), 'layout')

    handlers?.onState({ exists: false })
    handlers?.onDelta?.({ exists: true, value: { _version: 1, data: { cols: 3 } } })
    handlers?.onDelta?.({ exists: true, value: 'raw' })
    handlers?.onDelta?.({ exists: false })

    expect(seen).toEqual([
      { exists: false },
      { exists: true, data: { cols: 3 } },
      { exists: true, data: 'raw' },
      { exists: false }
    ])
    unsubscribe()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('is a no-op without a host watch (desktop)', () => {
    mockTransport.watches = undefined
    const onChange = vi.fn()
    const unsubscribe = watchStoreKey('layout', onChange)
    expect(unsubscribe).not.toThrow()
    expect(onChange).not.toHaveBeenCalled()
  })
})
