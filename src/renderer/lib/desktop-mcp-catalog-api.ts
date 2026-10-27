/**
 * Desktop implementation of the MCP catalog facade (spine AD-1). The desktop
 * has no HTTP server, so search travels as the `search_mcp_catalog` request
 * of the `/ws` contract over the Tauri channel. The host answers with the same
 * payload and codes as `GET /mcp-catalog/search` (`web-mcp-catalog-api.ts`).
 */

import type { McpCatalogApi } from '@shared/types/mcp-catalog.types'
import { getAcpTransport } from './acp-transport'
import { ipcResultFromTransport } from './ipc/transport-result'

export function createDesktopMcpCatalogApi(): McpCatalogApi {
  return {
    search: (request) => ipcResultFromTransport(() => getAcpTransport().searchMcpCatalog(request))
  }
}
