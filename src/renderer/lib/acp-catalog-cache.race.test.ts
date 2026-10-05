import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => false }))

import type { AcpCatalog } from '@shared/types/acp-catalog.types'
import type { IpcResult } from '@shared/types/ipc.types'
import {
  _resetCatalogCacheForTesting,
  cachedListCatalog,
  hasFreshCatalogCache,
  invalidateCatalogCache
} from './acp-catalog-cache'

const ok = (): IpcResult<AcpCatalog> => ({ success: true, data: {} as AcpCatalog })

describe('catalog cache invalidation racing an in-flight fetch (CodeRabbit)', () => {
  beforeEach(() => {
    _resetCatalogCacheForTesting()
  })

  it('a pre-invalidation in-flight fetch must not repopulate the cache', async () => {
    let release!: (value: IpcResult<AcpCatalog>) => void
    const gate = new Promise<IpcResult<AcpCatalog>>((resolve) => {
      release = resolve
    })
    const inflight = cachedListCatalog(() => gate)
    // Invalidation lands while the fetch is still in flight (the opt-in POST).
    invalidateCatalogCache()
    release(ok())
    await inflight

    // The stale request must NOT have committed into the cache window.
    expect(hasFreshCatalogCache()).toBe(false)
  })

  it('clearing the in-flight handle makes the next caller start a new request', async () => {
    let release!: (value: IpcResult<AcpCatalog>) => void
    const gate = new Promise<IpcResult<AcpCatalog>>((resolve) => {
      release = resolve
    })
    const stale = cachedListCatalog(() => gate)
    invalidateCatalogCache()

    let fetches = 0
    const fresh = cachedListCatalog(() => {
      fetches += 1
      return Promise.resolve(ok())
    })
    expect(fetches).toBe(1)
    release(ok())
    await stale
    await fresh
  })

  it('a normal fetch still caches (generation unchanged)', async () => {
    let fetches = 0
    const fetchOnce = () => {
      fetches += 1
      return Promise.resolve(ok())
    }
    await cachedListCatalog(fetchOnce)
    await cachedListCatalog(fetchOnce)
    expect(fetches).toBe(1)
    expect(hasFreshCatalogCache()).toBe(true)
  })
})
