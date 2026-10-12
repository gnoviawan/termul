import type { PersistedSessionSummary } from '@shared/types/web-protocol.types'
import { useEffect } from 'react'
import { fromPersistedSessionSummary, runHistoryWipeMigration } from '@/lib/acp-history-persistence'
import { getAcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Load the persisted chat-history index once at app mount. Payloads load lazily
 * when a chat is opened. The v2 wipe migration runs first (idempotent) so the
 * pre-`projectId` records are cleared before the index is read (ADR 0002).
 *
 * Web/remote: also watches the host's `chat_history` index. The watch sends
 * the full index on every (re)subscribe (first connect, reconnect, a missed
 * delta) and a `{ changed }` delta on each change, which the sidebar answers by
 * refetching. Desktop has no WS connection — the subscription is a no-op there.
 */
export function useAcpHistory(): void {
  const loadSessionIndex = useAcpStore((s) => s.loadSessionIndex)
  const applySessionIndexSnapshot = useAcpStore((s) => s.applySessionIndexSnapshot)
  useEffect(() => {
    void (async () => {
      try {
        // Desktop Tauri Store migration is a no-op for server/live-only providers.
        await runHistoryWipeMigration()
      } catch (err) {
        void logFrontendError({
          level: 'warn',
          source: 'useAcpHistory.migration',
          message: `ACP history wipe migration failed: ${String(err)}`
        })
      }
      await loadSessionIndex().catch((err) => {
        void logFrontendError({
          level: 'warn',
          source: 'useAcpHistory.initialLoad',
          message: `ACP history index refresh failed: ${String(err)}`
        })
      })
    })()

    // Web/remote: the `chat_history` watch rebuilds the index from the host's
    // full state and refetches on a delta. Desktop never receives it.
    if (isTauriContext()) return
    const unsubscribe = getAcpTransport().watches?.subscribe<PersistedSessionSummary[], unknown>(
      'chat_history',
      {
        onState: (summaries) => {
          if (!Array.isArray(summaries)) return
          void applySessionIndexSnapshot(summaries.map(fromPersistedSessionSummary)).catch(
            (err) => {
              void logFrontendError({
                level: 'warn',
                source: 'useAcpHistory.chatHistoryState',
                message: `ACP history index install failed: ${String(err)}`
              })
            }
          )
        },
        onDelta: () => {
          void loadSessionIndex().catch((err) => {
            void logFrontendError({
              level: 'warn',
              source: 'useAcpHistory.chatHistoryChanged',
              message: `ACP history index refresh failed: ${String(err)}`
            })
          })
        }
      }
    )
    return () => {
      unsubscribe?.()
    }
  }, [loadSessionIndex, applySessionIndexSnapshot])
}
