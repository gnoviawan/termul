/**
 * Desktop implementation of the MCP catalog facade (spine AD-1). The desktop
 * has no HTTP server, so each call travels as its `/ws` request
 * (`search_mcp_catalog`, `get_mcp_catalog_status`, `set_mcp_catalog_sync`)
 * over the Tauri channel. The host answers with the same payloads and codes as
 * the `/mcp-catalog/` routes (`web-mcp-catalog-api.ts`).
 */

import type { McpCatalogApi } from '@shared/types/mcp-catalog.types'
import { getAcpTransport } from './acp-transport'
import { ipcResultFromTransport } from './ipc/transport-result'

export function createDesktopMcpCatalogApi(): McpCatalogApi {
  return {
    search: (request) => ipcResultFromTransport(() => getAcpTransport().searchMcpCatalog(request)),
    status: () => ipcResultFromTransport(() => getAcpTransport().getMcpCatalogStatus()),
    setSync: (enabled) => ipcResultFromTransport(() => getAcpTransport().setMcpCatalogSync(enabled))
  }
}
