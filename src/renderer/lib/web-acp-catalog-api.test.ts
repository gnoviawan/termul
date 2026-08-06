import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock isTauriContext to return false so the adapter uses fetch
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => false
}))

import type { AcpCatalog } from '@shared/types/acp-catalog.types'
import { webAcpCatalogApi } from './web-acp-catalog-api'

describe('webAcpCatalogApi', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'http://localhost:8080' } })
  })

  it('listCatalog hits GET /acp/catalog and maps IpcBody success', async () => {
    const catalog: AcpCatalog = {
      host: {
        os: 'linux',
        arch: 'x86_64',
        runtimes: { npx: true, uvx: false, node: true, bun: false, python3: true }
      },
      agents: []
    }
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: catalog })
    })

    const result = await webAcpCatalogApi.listCatalog()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/acp/catalog',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result.success).toBe(true)
    expect(result.data).toEqual(catalog)
  })

  it('listCatalog appends ?refresh=true when refresh is true', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { host: {}, agents: [] } })
    })

    await webAcpCatalogApi.listCatalog(true)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/acp/catalog?refresh=true',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('listCatalog maps non-2xx HTTP to NETWORK_ERROR', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })

    const result = await webAcpCatalogApi.listCatalog()

    expect(result.success).toBe(false)
    expect(result.code).toBe('NETWORK_ERROR')
  })

  it('listCatalog maps fetch throw to NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    const result = await webAcpCatalogApi.listCatalog()

    expect(result.success).toBe(false)
    expect(result.code).toBe('NETWORK_ERROR')
  })

  it('setCatalogOptIn hits POST /acp/catalog/opt-in with enabled body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: null })
    })

    const result = await webAcpCatalogApi.setCatalogOptIn(true)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/acp/catalog/opt-in',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ enabled: true })
      })
    )
    expect(result.success).toBe(true)
  })

  it('setCatalogOptIn maps IpcBody error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: false,
        error: 'store unavailable',
        code: 'ACP_CATALOG_UNAVAILABLE'
      })
    })

    const result = await webAcpCatalogApi.setCatalogOptIn(false)

    expect(result.success).toBe(false)
    expect(result.code).toBe('ACP_CATALOG_UNAVAILABLE')
  })

  it('isCatalogOptedIn derives from listCatalog (registry entries present)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          host: {},
          agents: [
            { id: 'a', source: 'bundled' },
            { id: 'b', source: 'registry' }
          ]
        }
      })
    })

    const result = await webAcpCatalogApi.isCatalogOptedIn()

    expect(result.success).toBe(true)
    expect(result.data).toBe(true)
  })
})
