/** Desktop implementation of the MCP catalog facade (spine AD-1). */

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
