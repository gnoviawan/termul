/**
 * HTTP implementation of the MCP catalog facade (spine AD-1, AD-5): `GET
 * /mcp-catalog/search` and `POST /mcp-catalog/install/{form,plan,commit,
 * cancel}` on the host serving this client. Network and parse failures map
 * to `NETWORK_ERROR`; the route's own `IpcBody` passes through.
 *
 * The install mutations carry this tab's `clientInstanceId`: the host binds
 * a plan to it, so only the tab that planned can commit or cancel.
 */

import type {
  McpCatalogApi,
  McpCatalogPage,
  McpInstallCommitResult,
  McpInstallFormReply,
  McpInstallPlanReply
} from '@shared/types/mcp-catalog.types'
import { getJson, postJson } from './ipc/http'
import { getClientInstanceId } from './web-client-identity'

export const webMcpCatalogApi: McpCatalogApi = {
  search(request) {
    const params = new URLSearchParams()
    if (request.query) params.set('query', request.query)
    if (request.cursor) params.set('cursor', request.cursor)
    if (request.limit !== undefined) params.set('limit', String(request.limit))
    const query = params.toString()
    return getJson<McpCatalogPage>(`/mcp-catalog/search${query ? `?${query}` : ''}`)
  },
  describeInstall(request) {
    return postJson<McpInstallFormReply>('/mcp-catalog/install/form', request)
  },
  planInstall(request) {
    return postJson<McpInstallPlanReply>('/mcp-catalog/install/plan', {
      ...request,
      clientInstanceId: getClientInstanceId()
    })
  },
  commitInstall(request) {
    return postJson<McpInstallCommitResult>('/mcp-catalog/install/commit', {
      ...request,
      clientInstanceId: getClientInstanceId()
    })
  },
  cancelInstall(request) {
    return postJson<Record<string, never>>('/mcp-catalog/install/cancel', {
      ...request,
      clientInstanceId: getClientInstanceId()
    })
  }
}
