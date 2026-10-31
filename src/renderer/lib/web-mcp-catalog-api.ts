/** HTTP implementation of the MCP catalog facade (spine AD-1). */

import type {
  McpCatalogApi,
  McpCatalogPage,
  McpCatalogStatus
} from '@shared/types/mcp-catalog.types'
import { getJson, postJson } from './ipc/http'

export const webMcpCatalogApi: McpCatalogApi = {
  search(request) {
    const params = new URLSearchParams()
    if (request.query) params.set('query', request.query)
    if (request.cursor !== undefined) params.set('cursor', request.cursor)
    if (request.limit !== undefined) params.set('limit', String(request.limit))
    const query = params.toString()
    return getJson<McpCatalogPage>(`/mcp-catalog/search${query ? `?${query}` : ''}`)
  },
  status: () => getJson<McpCatalogStatus>('/mcp-catalog/status'),
  setSync: (enabled) => postJson<McpCatalogStatus>('/mcp-catalog/sync', { enabled })
}
