/**
 * In-flight dedupe + short staleness window for the ACP catalog read (#844).
 *
 * QA on 2026-10-04 found the web UI requesting `GET /acp/catalog` ~15k/min
 * (~400/s peak) while a turn streams: several components call `listCatalog()`
 * on their own schedule (`useResolvedSupportedAcpAgents` consumers —
 * the composer agent selector, AgentLauncher, AcpAgentsSettings; `DirectoryPicker`'s
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
/**
 * Generation counter for invalidation (CodeRabbit): a fetch that was
 * already in flight — or one that starts while a mutation POST is pending —
 * must not write pre-mutation data back into the cache. Each invalidation
 * bumps the generation; a settling request only commits when its generation
 * still matches the current one.
 */
let cacheGeneration = 0

/** Test seam: reset the cache + in-flight state between tests. */
export function _resetCatalogCacheForTesting(): void {
  catalogCache.entry = null
  inflightCatalog = null
  cacheGeneration += 1
}

/** Invalidate the cached response (call after a mutation, e.g. opt-in). */
export function invalidateCatalogCache(): void {
  catalogCache.entry = null
  cacheGeneration += 1
  // A request that started before the invalidation may still resolve with
  // pre-mutation data; dropping the in-flight handle makes the NEXT caller
  // start a fresh request instead of joining it. The stale request itself
  // is generation-gated, so it cannot repopulate the cache.
  inflightCatalog = null
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
  // Capture the handle via a mutable local so the finally block can compare
  // without referencing the not-yet-assigned `request` binding.
  let pendingRequest: Promise<IpcResult<AcpCatalog>> | null = null
  const request: Promise<IpcResult<AcpCatalog>> = (async () => {
    const generation = cacheGeneration
    try {
      const result = await fetchCatalog()
      // Commit only when no invalidation happened while this request was
      // in flight (CodeRabbit: pre-toggle data must not repopulate).
      if (generation === cacheGeneration) {
        if (result.success) {
          catalogCache.entry = { result, cachedAt: Date.now() }
        } else {
          // A failure must not poison the window — drop any stale entry so
          // the next call re-attempts rather than replaying old data.
          catalogCache.entry = null
        }
      }
      return result
    } finally {
      // Only clear the in-flight handle if it is still THIS request; an
      // invalidation may have already nulled it (and a newer request may
      // have taken the slot).
      if (inflightCatalog !== null && inflightCatalog === pendingRequest) {
        inflightCatalog = null
      }
    }
  })()
  pendingRequest = request
  inflightCatalog = request
  return request
}
