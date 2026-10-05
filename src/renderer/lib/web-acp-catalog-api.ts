/**
 * Fetch-based HTTP impl of the ACP catalog facade (CAP-6 / Story 8).
 *
 * Mirrors the desktop Tauri command impl over the two HTTP routes
 * registered in `src-tauri/src/web/catalog_api.rs`. Transport/parse failures
 * map to `IpcResult { success: false, code: 'NETWORK_ERROR' }` so the
 * renderer never sees a thrown exception from the network layer.
 *
 * Routes (same-origin under `termul-server`):
 * - `GET  /acp/catalog` — list (optional `?refresh=true`).
 * - `POST /acp/catalog/opt-in` — set opt-in.
 *
 * The `IpcBody<T>` shape the HTTP routes return matches the renderer-side
 * `IpcResult<T>` byte-for-byte — this adapter only maps a transport/parse
 * failure to `NETWORK_ERROR`; a structured `IpcBody` is parsed into the
 * success/failure body variant the route returned on ANY status (the web auth
 * gate's 401 UNAUTHORIZED keeps its code/message).
 */

import type { AcpCatalog, AcpCatalogApi } from '@shared/types/acp-catalog.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { cachedListCatalog, invalidateCatalogCache } from './acp-catalog-cache'
import { getJson, postJson } from './ipc/http'

/**
 * The fetch-backed impl of [`AcpCatalogApi`]. The singleton in
 * `acp-catalog-api.ts` picks this when `!isTauriContext()`.
 */
export const webAcpCatalogApi: AcpCatalogApi = {
  listCatalog(refresh?: boolean): Promise<IpcResult<AcpCatalog>> {
    // #844: in-flight dedupe + 2s staleness window around the HTTP read.
    // Re-render-driven repeat calls (the picker/launcher/settings hooks)
    // replay the cached response instead of re-fetching. `refresh=true`
    // (user-initiated "check for updates") bypasses the window.
    return cachedListCatalog(() => {
      const query = refresh ? '?refresh=true' : ''
      return getJson<AcpCatalog>(`/acp/catalog${query}`)
    }, refresh)
  },

  async setCatalogOptIn(enabled: boolean): Promise<IpcResult<void>> {
    // #844: the opt-in changes what the next catalog read returns — drop the
    // cached response so the immediate follow-up read re-fetches.
    invalidateCatalogCache()
    const result = await postJson<void>('/acp/catalog/opt-in', { enabled })
    // CodeRabbit: a fetch that raced the POST may still resolve pre-toggle
    // data; invalidate again once the mutation settles so nothing stale
    // re-enters the cache window.
    invalidateCatalogCache()
    return result
  },

  async isCatalogOptedIn(): Promise<IpcResult<boolean>> {
    // TODO(CAP-6 follow-up): see `tauri-acp-catalog-api.ts::isCatalogOptedIn` —
    // this infers the opt-in from catalog contents (any `source: 'registry'`
    // agent ⇒ opted-in), which conflates "opt-in is on" with "the CDN fetch
    // succeeded". A dedicated host endpoint (`GET /acp/catalog/opt-in`) is the
    // correct fix; deferred as a heavy lift (needs the endpoint across all
    // three transports + parity tests).
    const result = await getJson<AcpCatalog>('/acp/catalog')
    if (!result.success) {
      return result as IpcResult<boolean>
    }
    const optedIn = result.data?.agents.some((agent) => agent.source === 'registry') ?? false
    return { success: true, data: optedIn }
  }
}
