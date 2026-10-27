/**
 * HTTP implementation of the MCP catalog facade (spine AD-1): `GET
 * /mcp-catalog/search` on the host serving this client. Network and parse
 * failures map to `NETWORK_ERROR`; the route's own `IpcBody` passes through.
 */

import type { McpCatalogApi, McpCatalogPage } from '@shared/types/mcp-catalog.types'
import { getJson } from './ipc/http'

export const webMcpCatalogApi: McpCatalogApi = {
  search(request) {
    const params = new URLSearchParams()
    if (request.query) params.set('query', request.query)
    if (request.cursor !== undefined) params.set('cursor', request.cursor)
    if (request.limit !== undefined) params.set('limit', String(request.limit))
    const query = params.toString()
    return getJson<McpCatalogPage>(`/mcp-catalog/search${query ? `?${query}` : ''}`)
  }
}
