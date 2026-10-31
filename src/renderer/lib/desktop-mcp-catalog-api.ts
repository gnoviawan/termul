/** Desktop implementation of the MCP catalog facade (spine AD-1). */

import type { McpCatalogApi, McpCatalogIconUrl } from '@shared/types/mcp-catalog.types'
import { getAcpTransport } from './acp-transport'
import { ipcResultFromTransport } from './ipc/transport-result'

export function createDesktopMcpCatalogApi(): McpCatalogApi {
  return {
    search: (request) => ipcResultFromTransport(() => getAcpTransport().searchMcpCatalog(request)),
    status: () => ipcResultFromTransport(() => getAcpTransport().getMcpCatalogStatus()),
    setSync: (enabled) =>
      ipcResultFromTransport(() => getAcpTransport().setMcpCatalogSync(enabled)),
    describeInstall: (request) =>
      ipcResultFromTransport(() => getAcpTransport().describeMcpInstall(request)),
    planInstall: (request) =>
      ipcResultFromTransport(() => getAcpTransport().planMcpInstall(request)),
    commitInstall: (request) =>
      ipcResultFromTransport(() => getAcpTransport().commitMcpInstall(request)),
    cancelInstall: (request) =>
      ipcResultFromTransport(() => getAcpTransport().cancelMcpInstall(request)),
    icon: (name) =>
      ipcResultFromTransport(async (): Promise<McpCatalogIconUrl> => {
        const icon = await getAcpTransport().getMcpCatalogIcon(name)
        return `data:${icon.contentType};base64,${icon.base64}`
      })
  }
}
