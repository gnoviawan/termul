import type { McpCatalogPage, McpCatalogStatus } from '@shared/types/mcp-catalog.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { transport } = vi.hoisted(() => ({
  transport: {
    searchMcpCatalog: vi.fn(),
    getMcpCatalogStatus: vi.fn(),
    setMcpCatalogSync: vi.fn()
  }
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
  updatedAt: '2026-10-27T03:13:14.559Z',
  sample: false
}

const status: McpCatalogStatus = {
  updatedAt: '2026-10-27T03:13:14.559Z',
  sample: false,
  servers: 54_210,
  sync: { state: 'syncing', full: false, fetched: 0 }
}

const disabled: McpCatalogStatus = { ...status, sync: { state: 'disabled' } }

const forbidden = {
  success: false,
  error: 'Only the host can change MCP catalog sync',
  code: 'FORBIDDEN'
}

const fetchMock = vi.fn()

function hostAnswers(body: unknown) {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body })
}

describe('MCP catalog facades', () => {
  beforeEach(() => {
    transport.searchMcpCatalog.mockReset()
    transport.getMcpCatalogStatus.mockReset()
    transport.setMcpCatalogSync.mockReset()
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

  it('web search forwards an empty cursor for the host to reject, as the desktop path does', async () => {
    hostAnswers({ success: true, data: page })

    await webMcpCatalogApi.search({ cursor: '' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/search?cursor=',
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

  it('web status reads GET /mcp-catalog/status', async () => {
    hostAnswers({ success: true, data: status })

    const result = await webMcpCatalogApi.status()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/status',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result).toEqual({ success: true, data: status })
  })

  it('web setSync posts { enabled } to /mcp-catalog/sync and returns the new status', async () => {
    hostAnswers({ success: true, data: disabled })

    const result = await webMcpCatalogApi.setSync(false)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/mcp-catalog/sync',
      expect.objectContaining({ method: 'POST', body: '{"enabled":false}' })
    )
    expect(result).toEqual({ success: true, data: disabled })
  })

  it('web setSync passes a FORBIDDEN refusal through', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => forbidden })

    expect(await webMcpCatalogApi.setSync(true)).toEqual(forbidden)
  })

  it('desktop status and setSync send their requests over the transport', async () => {
    transport.getMcpCatalogStatus.mockResolvedValueOnce(status)
    transport.setMcpCatalogSync.mockResolvedValueOnce(disabled)
    const api = createDesktopMcpCatalogApi()

    expect(await api.status()).toEqual({ success: true, data: status })
    expect(await api.setSync(false)).toEqual({ success: true, data: disabled })
    expect(transport.setMcpCatalogSync.mock.calls).toEqual([[false]])
  })

  it('desktop setSync passes a FORBIDDEN refusal through like the web path', async () => {
    transport.setMcpCatalogSync.mockRejectedValueOnce(
      new AcpTransportError('FORBIDDEN', forbidden.error)
    )

    expect(await createDesktopMcpCatalogApi().setSync(true)).toEqual(forbidden)
  })
})
