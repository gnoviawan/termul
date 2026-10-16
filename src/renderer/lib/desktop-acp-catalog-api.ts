/**
 * Desktop implementation of the ACP catalog facade (CAP-6 / Story 8).
 *
 * The desktop has no HTTP server, so the catalog travels the same way every
 * other host request does: the `list_acp_catalog` / `set_catalog_opt_in`
 * requests of the `/ws` contract, over the Tauri IPC channel carrier. The host
 * answers with the SAME payloads and error codes as the HTTP routes the web
 * client uses (`web-acp-catalog-api.ts`), so both implementations return the
 * same `IpcResult<...>` shape byte-for-byte — the `parity-checklist.test.ts`
 * pins this.
 */

import type { AcpCatalog, AcpCatalogApi } from '@shared/types/acp-catalog.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { cachedListCatalog, invalidateCatalogCache } from './acp-catalog-cache'
import { getAcpTransport } from './acp-transport'
import { ipcResultFromTransport } from './ipc/transport-result'

/**
 * Build the desktop impl of [`AcpCatalogApi`]. The singleton in
 * `acp-catalog-api.ts` picks this when `isTauriContext()` is true.
 */
export function createDesktopAcpCatalogApi(): AcpCatalogApi {
  return {
    listCatalog(refresh?: boolean): Promise<IpcResult<AcpCatalog>> {
      // #844: in-flight dedupe + 2s staleness window. The catalog request
      // shares the ONE ordered channel with the live event stream, so
      // re-render-driven repeat calls replay the cached response instead of
      // queueing another request. `refresh=true` bypasses the window.
      return cachedListCatalog(
        () => ipcResultFromTransport(() => getAcpTransport().listCatalog(refresh ?? false)),
        refresh
      )
    },

    async setCatalogOptIn(enabled: boolean): Promise<IpcResult<void>> {
      // The opt-in changes what the next catalog read returns: drop the cached
      // response before and after the mutation so nothing stale re-enters the
      // cache window (a read that raced the request may resolve pre-toggle).
      invalidateCatalogCache()
      const result = await ipcResultFromTransport(() => getAcpTransport().setCatalogOptIn(enabled))
      invalidateCatalogCache()
      return result
    },

    async isCatalogOptedIn(): Promise<IpcResult<boolean>> {
      // Best-effort probe: any `source: 'registry'` agent means the opt-in is
      // on. See `web-acp-catalog-api.ts::isCatalogOptedIn` for why this is
      // inferred from the catalog and not read from a dedicated host endpoint.
      const result = await ipcResultFromTransport(() => getAcpTransport().listCatalog(false))
      if (!result.success) return result
      const optedIn = result.data.agents.some((agent) => agent.source === 'registry')
      return { success: true, data: optedIn }
    }
  }
}
