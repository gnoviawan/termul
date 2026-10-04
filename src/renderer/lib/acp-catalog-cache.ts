/**
 * In-flight dedupe + short staleness window for the ACP catalog read (#844).
 *
 * QA on 2026-10-04 found the web UI requesting `GET /acp/catalog` ~15k/min
 * (~400/s peak) while a turn streams: several components call `listCatalog()`
 * on their own schedule (`useResolvedSupportedAcpAgents` consumers —
 * AgentSwitchPicker, AgentLauncher, AcpAgentsSettings; `DirectoryPicker`'s
 * host-OS seed; `agent-update-orchestration`), and transcript-driven
 * re-renders re-fire those call sites in a loop. The renderer-side fix is
 * shared-state memoization at the facade boundary:
 *
 * - **In-flight dedupe**: concurrent callers share ONE network request
 *   (boot: five components resolving at once → one fetch).
 * - **Staleness window** (`CATALOG_CACHE_TTL_MS`, 2s): a successful response
 *   is replayed without a refetch. This is what breaks the re-render →
 *   refetch loop — N transcript events re-rendering a picker inside the
 *   window produce ZERO additional catalog fetches. The host already serves
 *   the catalog from a 60s TTL cache server-side, so a 2s client window
 *   cannot surface meaningfully stale data.
 * - **Explicit refresh** bypasses the window (the registry "check for
 *   updates" flow passes `refresh: true`).
 * - **Invalidation**: `setCatalogOptIn` clears the cached response so an
 *   opt-in toggle is visible to the very next read (the registry-catalog
 *   hook reads the catalog right after toggling).
 *
 * Failures are NOT cached: a transient error must be retried on the next
 * call, so only `success: true` results enter the cache.
 */

import type { AcpCatalog } from '@shared/types/acp-catalog.types'
import type { IpcResult } from '@shared/types/ipc.types'

/** How long a successful catalog response is replayed without a refetch. */
export const CATALOG_CACHE_TTL_MS = 2_000

interface CatalogCacheEntry {
  result: IpcResult<AcpCatalog>
  cachedAt: number
}

/**
 * Module-scoped cache + in-flight promise. Every consumer of the
 * `acpCatalogApi` facade (web transport) shares these — that sharing is the
 * fix: per-component caches would still multiply requests.
 */
const catalogCache: { entry: CatalogCacheEntry | null } = { entry: null }
let inflightCatalog: Promise<IpcResult<AcpCatalog>> | null = null

/** Test seam: reset the cache + in-flight state between tests. */
export function _resetCatalogCacheForTesting(): void {
  catalogCache.entry = null
  inflightCatalog = null
}

/** Invalidate the cached response (call after a mutation, e.g. opt-in). */
export function invalidateCatalogCache(): void {
  catalogCache.entry = null
}

/** Whether the cache holds a fresh-enough entry. Internal + tests. */
export function hasFreshCatalogCache(now = Date.now()): boolean {
  const { entry } = catalogCache
  return entry !== null && now - entry.cachedAt < CATALOG_CACHE_TTL_MS
}

/**
 * `listCatalog(refresh?)` with in-flight dedupe + staleness window.
 *
 * @param fetchCatalog the underlying transport call (the web adapter's
 *   `getJson<AcpCatalog>('/acp/catalog…')`).
 * @param refresh `true` bypasses the window and forces a network call —
 *   callers performing an explicit user refresh keep their semantics.
 */
export async function cachedListCatalog(
  fetchCatalog: () => Promise<IpcResult<AcpCatalog>>,
  refresh = false
): Promise<IpcResult<AcpCatalog>> {
  if (!refresh && hasFreshCatalogCache()) {
    // Replay the cached success — the re-render → refetch loop ends here.
    return catalogCache.entry!.result
  }
  if (inflightCatalog) {
    // Dedupe concurrent callers onto the in-flight request.
    return inflightCatalog
  }
  const request = (async () => {
    try {
      const result = await fetchCatalog()
      if (result.success) {
        catalogCache.entry = { result, cachedAt: Date.now() }
      } else {
        // A failure must not poison the window — drop any stale entry so
        // the next call re-attempts rather than replaying old data.
        catalogCache.entry = null
      }
      return result
    } finally {
      inflightCatalog = null
    }
  })()
  inflightCatalog = request
  return request
}
