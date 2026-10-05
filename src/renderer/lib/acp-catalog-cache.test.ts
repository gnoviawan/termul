import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock isTauriContext to return false so the adapter uses fetch
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => false
}))

import type { AcpCatalog } from '@shared/types/acp-catalog.types'
import { _resetCatalogCacheForTesting, CATALOG_CACHE_TTL_MS } from './acp-catalog-cache'
import { webAcpCatalogApi } from './web-acp-catalog-api'

const catalog: AcpCatalog = {
  host: {
    os: 'linux',
    arch: 'x86_64',
    runtimes: { npx: true, uvx: false, node: true, bun: false, python3: true }
  },
  agents: []
}

function okResponse(): Response {
  return { ok: true, json: async () => ({ success: true, data: catalog }) } as Response
}

describe('webAcpCatalogApi listCatalog caching (#844)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'http://localhost:8080' } })
    _resetCatalogCacheForTesting()
  })

  it('replays the cached response within the staleness window', async () => {
    fetchMock.mockResolvedValue(okResponse())

    // N re-render-driven calls inside the window (the 400/s QA loop).
    const N = 25
    for (let i = 0; i < N; i++) {
      const result = await webAcpCatalogApi.listCatalog()
      expect(result.success).toBe(true)
      expect(result.data).toEqual(catalog)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1, 'N calls inside the TTL → 1 fetch')
  })

  it('dedupes CONCURRENT callers onto one in-flight request', async () => {
    let release: (() => void) | null = null
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(okResponse())
        })
    )

    const calls = Array.from({ length: 5 }, () => webAcpCatalogApi.listCatalog())
    // Release the in-flight fetch BEFORE awaiting the callers — otherwise
    // the await blocks forever on the unresolved mock.
    await Promise.resolve()
    release?.()
    const result = await Promise.all(calls)
    expect(result.every((r) => r.success)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1, '5 concurrent callers → 1 fetch')
  })

  it('refetches after the staleness window expires', async () => {
    const now = vi.spyOn(Date, 'now')
    fetchMock.mockResolvedValue(okResponse())
    await webAcpCatalogApi.listCatalog()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now.mockReturnValue(Date.now() + CATALOG_CACHE_TTL_MS + 1)
    try {
      await webAcpCatalogApi.listCatalog()
      expect(fetchMock).toHaveBeenCalledTimes(2, 'expired window → refetch')
    } finally {
      now.mockRestore()
    }
  })

  it('bypasses the cache when refresh is true', async () => {
    fetchMock.mockResolvedValue(okResponse())
    await webAcpCatalogApi.listCatalog()
    await webAcpCatalogApi.listCatalog(true)
    expect(fetchMock).toHaveBeenCalledTimes(2, 'refresh=true → always a network call')
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://localhost:8080/acp/catalog?refresh=true',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('does not cache failures — the next call re-attempts', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'boom' } as Response)
    const first = await webAcpCatalogApi.listCatalog()
    expect(first.success).toBe(false)

    fetchMock.mockResolvedValueOnce(okResponse())
    const second = await webAcpCatalogApi.listCatalog()
    expect(second.success).toBe(true, 'failure must not poison the window')
  })

  it('setCatalogOptIn invalidates the cached response', async () => {
    fetchMock.mockResolvedValue(okResponse())
    await webAcpCatalogApi.listCatalog()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: null })
    } as Response)

    await webAcpCatalogApi.setCatalogOptIn(true)

    fetchMock.mockResolvedValueOnce(okResponse())
    await webAcpCatalogApi.listCatalog()
    expect(fetchMock).toHaveBeenCalledTimes(3, 'post-opt-in read must re-fetch, not replay')
  })
})

// ---------------------------------------------------------------------------
// CodeRabbit: invalidation racing an in-flight fetch. The generation gate
// means a request that started before a mutation POST must never write
// pre-mutation data back into the cache window.
// ---------------------------------------------------------------------------
