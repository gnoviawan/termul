import type { McpCatalogPage } from '@shared/types/mcp-catalog.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { transport } = vi.hoisted(() => ({
  transport: { searchMcpCatalog: vi.fn() }
}))

vi.mock('./acp-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acp-transport')>()),
  getAcpTransport: () => transport
}))

import { AcpTransportError } from './acp-transport/types'
import { createDesktopMcpCatalogApi } from './desktop-mcp-catalog-api'
import { webMcpCatalogApi } from './web-mcp-catalog-api'

const page: McpCatalogPage = {
  items: [
    {
      name: 'to.hooka/mcp',
      title: null,
      description: 'Hooka MCP server',
      version: '0.1.2',
      status: 'active',
      state: 'needs-runtime',
      reason: { code: 'needs-runtime', runtime: 'npx' },
      defaultOption: { kind: 'package', index: 0 },
      repositoryUrl: 'https://github.com/hooka/mcp'
    }
  ],
  nextCursor: '1',
  total: 2,
  snapshotFetchedAt: '2026-10-27T03:13:14.559Z'
}

const fetchMock = vi.fn()

function hostAnswers(body: unknown) {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body })
}

describe('MCP catalog facades', () => {
  beforeEach(() => {
    transport.searchMcpCatalog.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'http://localhost:8080' } })
  })

  it('web search sends the query, cursor and limit to GET /mcp-catalog/search', async () => {
    hostAnswers({ success: true, data: page })

    const result = await webMcpCatalogApi.search({ query: 'git & hub', cursor: '50', limit: 25 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/search?query=git+%26+hub&cursor=50&limit=25',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result).toEqual({ success: true, data: page })
  })

  it('web search with no parameters requests the first page', async () => {
    hostAnswers({ success: true, data: page })

    await webMcpCatalogApi.search({})

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/search',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('web search maps a failed fetch to NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))

    const result = await webMcpCatalogApi.search({})

    expect(result).toMatchObject({ success: false, code: 'NETWORK_ERROR' })
  })

  it('desktop search sends search_mcp_catalog over the transport', async () => {
    transport.searchMcpCatalog.mockResolvedValueOnce(page)

    const result = await createDesktopMcpCatalogApi().search({ query: 'hooka', limit: 5 })

    expect(transport.searchMcpCatalog).toHaveBeenCalledWith({ query: 'hooka', limit: 5 })
    expect(result).toEqual({ success: true, data: page })
  })

  it('desktop and web return the same result for the same host answer', async () => {
    transport.searchMcpCatalog.mockResolvedValueOnce(page)
    hostAnswers({ success: true, data: page })
    expect(await createDesktopMcpCatalogApi().search({})).toEqual(await webMcpCatalogApi.search({}))

    const message = 'limit must be between 1 and 100'
    transport.searchMcpCatalog.mockRejectedValueOnce(
      new AcpTransportError('VALIDATION_ERROR', message)
    )
    hostAnswers({ success: false, error: message, code: 'VALIDATION_ERROR' })
    const desktop = await createDesktopMcpCatalogApi().search({ limit: 500 })
    expect(desktop).toEqual({ success: false, error: message, code: 'VALIDATION_ERROR' })
    expect(desktop).toEqual(await webMcpCatalogApi.search({ limit: 500 }))
  })
})
