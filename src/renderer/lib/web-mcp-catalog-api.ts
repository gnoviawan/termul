/** HTTP implementation of the MCP catalog facade (spine AD-1). */

import type { IpcResult } from '@shared/types/ipc.types'
import type {
  McpCatalogApi,
  McpCatalogPage,
  McpCatalogStatus
} from '@shared/types/mcp-catalog.types'
import { bodyToResult, getJson, postJson, serverBase } from './ipc/http'
import { authHeader } from './web-auth-token'

/** `GET /mcp-catalog/icon/<name>` sends the bearer token, so it goes through `fetch`, not `<img src>`. */
async function icon(name: string): Promise<IpcResult<Blob>> {
  try {
    const response = await fetch(`${serverBase()}/mcp-catalog/icon/${encodeURIComponent(name)}`, {
      headers: authHeader()
    })
    if (response.ok) return { success: true, data: await response.blob() }
    const failure = bodyToResult<Blob>(await response.json().catch(() => null))
    return failure && !failure.success
      ? failure
      : { success: false, error: `HTTP ${response.status}`, code: 'NETWORK_ERROR' }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'NETWORK_ERROR'
    }
  }
}

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
  setSync: (enabled) => postJson<McpCatalogStatus>('/mcp-catalog/sync', { enabled }),
  icon
}
