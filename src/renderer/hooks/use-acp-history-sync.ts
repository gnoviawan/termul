import { useEffect } from 'react'
import { toPersistedSessionSummaries } from '@/lib/acp-history-persistence'
import { syncChatHistory } from '@/lib/tauri-remote-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useRemoteStatusStore } from '@/stores/remote-status-store'

/**
 * Monotonic revision stamped on each index push so `ChatHistoryCache::set_index`
 * can reject a delayed older index that would otherwise replace a newer
 * snapshot (CodeRabbit fix: stale-index replacement race). The seed in
 * `RemoteAccessPopover` uses revision `0` (omitted); this counter pre-increments
 * from `0` so every live index push carries a revision strictly greater than
 * the seed and strictly greater than every prior live push (1, 2, 3, …). The
 * counter is intentionally NOT reset on server stop — staying strictly
 * increasing across server sessions means a delayed push from a prior session
 * is still rejected as stale, and `clear()` resets the cache's own revision to
 * `0` on stop so the next seed (revision `0`) is accepted.
 */
let chatHistoryRevision = 0
function nextChatHistoryRevision(): number {
  chatHistoryRevision += 1
  return chatHistoryRevision
}

/**
 * Desktop-side live push of the chat-history index to the desktop-hosted
 * server's in-memory `ChatHistoryCache` (Epic-4 bridge). Mirrors
 * `useProjectsAutoSave`: subscribes to the acp store; on any `sessionIndex`
 * change, **when `useRemoteStatusStore` reports the server running**, fire-and-
 * forgets `syncChatHistory` (the full index — idempotent, replaces the mirror).
 * No secrets, permission tickets, or auth data cross the wire.
 *
 * Per-session payloads are pushed separately by `persistSession` (which has the
 * full transcript in scope); this hook only mirrors the lightweight index so the
 * web sidebar stays in sync without waiting for a payload push.
 *
 * Desktop-only: web/remote mode never pushes (it is the consumer, not the
 * source). When the server is stopped the push is a silent no-op.
 */
export function useAcpHistorySync(): void {
  useEffect(() => {
    // Web/remote mode is the consumer of the server cache, never the source.
    if (!isTauriContext()) return

    const unsubscribe = useAcpStore.subscribe((state, prevState) => {
      // Only push when the shared-live server is running.
      if (!useRemoteStatusStore.getState().status?.running) return
      // Skip when the index did not change.
      if (state.sessionIndex === prevState.sessionIndex) return

      // Fire-and-forget (replaces the snapshot — idempotent); no env-var values.
      // Stamp an increasing revision so the server rejects a stale older index.
      syncChatHistory(
        toPersistedSessionSummaries(state.sessionIndex),
        undefined,
        nextChatHistoryRevision()
      )
        .then((result) => {
          if (!result.success) {
            console.warn('[acp] remote history sync unsuccessful:', result.error)
          }
        })
        .catch((err: unknown) => {
          console.debug('[acp] remote history sync failed', err)
        })
    })

    return () => {
      unsubscribe()
    }
  }, [])
}
