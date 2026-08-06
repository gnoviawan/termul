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
 * failure to `NETWORK_ERROR`; a successful HTTP response is parsed into the
 * success/failure body variant the route returned.
 */

import type { AcpCatalog, AcpCatalogApi } from '@shared/types/acp-catalog.types'
import type { IpcResult } from '@shared/types/ipc.types'

import { isTauriContext } from './tauri-runtime'

/**
 * Same-origin base for the embedded server. In web/remote mode the browser is
 * served by `termul-server` itself, so `window.location.origin` is the server.
 * Returns the empty string under Tauri (desktop build) so a misconfigured
 * call fails fast rather than hitting a phantom origin.
 */
function serverBase(): string {
  if (isTauriContext()) return ''
  if (typeof window === 'undefined' || !window.location) return ''
  return window.location.origin
}

/** Shape of the HTTP response body mirroring `IpcResult<T>`. */
type IpcBody<T> = { success: true; data: T } | { success: false; error: string; code: string }

/** Map any transport/parse failure to a uniform `IpcResult` failure. */
function networkError(detail: string): IpcResult<never> {
  return { success: false, error: detail, code: 'NETWORK_ERROR' }
}

/** Parse the `IpcBody<T>` JSON body into `IpcResult<T>`. */
async function parseBody<T>(res: Response): Promise<IpcResult<T>> {
  if (!res.ok) {
    return networkError(`HTTP ${res.status} ${res.statusText}`)
  }
  let body: IpcBody<T>
  try {
    body = (await res.json()) as IpcBody<T>
  } catch (err) {
    return networkError(err instanceof Error ? err.message : 'invalid JSON')
  }
  if (body.success) {
    return { success: true, data: body.data }
  }
  return { success: false, error: body.error, code: body.code }
}

/**
 * The fetch-backed impl of [`AcpCatalogApi`]. The singleton in
 * `acp-catalog-api.ts` picks this when `!isTauriContext()`.
 */
export const webAcpCatalogApi: AcpCatalogApi = {
  listCatalog(refresh?: boolean): Promise<IpcResult<AcpCatalog>> {
    const query = refresh ? '?refresh=true' : ''
    return getJson<AcpCatalog>(`/acp/catalog${query}`)
  },

  setCatalogOptIn(enabled: boolean): Promise<IpcResult<void>> {
    return postJson<void>('/acp/catalog/opt-in', { enabled })
  },

  async isCatalogOptedIn(): Promise<IpcResult<boolean>> {
    // Derive from listCatalog: if any agent has source 'registry', the
    // opt-in is on (the host only includes CDN entries when the opt-in is
    // set AND the fetch succeeded).
    const result = await getJson<AcpCatalog>('/acp/catalog')
    if (!result.success) {
      return result as IpcResult<boolean>
    }
    const optedIn = result.data?.agents.some((agent) => agent.source === 'registry') ?? false
    return { success: true, data: optedIn }
  }
}

/** GET and return the typed `IpcResult` body (or NETWORK_ERROR). */
async function getJson<T>(path: string): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, { method: 'GET' })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

/** POST JSON and return the typed `IpcResult` body (or NETWORK_ERROR). */
async function postJson<T>(path: string, body: unknown): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}
