/**
 * Desktop implementation of the MCP catalog facade (spine AD-1, AD-5). The
 * desktop has no HTTP server, so every call travels as a `/ws` request over
 * the Tauri channel: `search_mcp_catalog`, `describe_mcp_install`,
 * `plan_mcp_install`, `commit_mcp_install` and `cancel_mcp_install`. The host
 * answers with the same payloads and codes as the `/mcp-catalog/...` routes
 * (`web-mcp-catalog-api.ts`). A plan is bound to the channel connection.
 */

import type { McpCatalogApi } from '@shared/types/mcp-catalog.types'
import { getAcpTransport } from './acp-transport'
import { ipcResultFromTransport } from './ipc/transport-result'

export function createDesktopMcpCatalogApi(): McpCatalogApi {
  return {
    search: (request) => ipcResultFromTransport(() => getAcpTransport().searchMcpCatalog(request)),
    describeInstall: (request) =>
      ipcResultFromTransport(() => getAcpTransport().describeMcpInstall(request)),
    planInstall: (request) =>
      ipcResultFromTransport(() => getAcpTransport().planMcpInstall(request)),
    commitInstall: (request) =>
      ipcResultFromTransport(() => getAcpTransport().commitMcpInstall(request)),
    cancelInstall: (request) =>
      ipcResultFromTransport(() => getAcpTransport().cancelMcpInstall(request))
  }
}
