import { useEffect } from 'react'
import { runHistoryWipeMigration } from '@/lib/acp-history-persistence'
import { getAcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Load the persisted chat-history index once at app mount. Payloads load lazily
 * when a chat is opened. The v2 wipe migration runs first (idempotent) so the
 * pre-`projectId` records are cleared before the index is read (ADR 0002).
 *
 * Web/remote: also subscribes to the `chat_history_changed` WS event so the
 * sidebar refetches the index when the desktop renderer pushes an update to the
 * server's in-memory cache (Epic-4 bridge). Desktop never receives this event
 * (no WS connection) — the subscription is a harmless no-op there.
 */
export function useAcpHistory(): void {
  const loadSessionIndex = useAcpStore((s) => s.loadSessionIndex)
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

    // Web/remote: refetch the session index when the server pushes a
    // `chat_history_changed` event (desktop renderer synced the cache).
    // Desktop never receives this WS event — the subscription is a no-op there.
    if (isTauriContext()) return
    const transport = getAcpTransport()
    const unsubscribe = transport.onEvent('acp:chat_history_changed', () => {
      void loadSessionIndex().catch((err) => {
        void logFrontendError({
          level: 'warn',
          source: 'useAcpHistory.chatHistoryChanged',
          message: `ACP history index refresh failed: ${String(err)}`
        })
      })
    })
    return () => {
      unsubscribe()
    }
  }, [loadSessionIndex])
}
