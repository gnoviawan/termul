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
