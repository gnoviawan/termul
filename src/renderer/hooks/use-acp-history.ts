import { useEffect } from 'react'
import { runHistoryWipeMigration } from '@/lib/acp-history-persistence'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Load the persisted chat-history index once at app mount. Payloads load lazily
 * when a chat is opened. The v2 wipe migration runs first (idempotent) so the
 * pre-`projectId` records are cleared before the index is read (ADR 0002).
 */
export function useAcpHistory(): void {
  const loadSessionIndex = useAcpStore((s) => s.loadSessionIndex)
  useEffect(() => {
    void (async () => {
      try {
        await runHistoryWipeMigration()
      } catch (err) {
        console.error('[acp] history wipe migration failed', err)
      }
      await loadSessionIndex()
    })()
  }, [loadSessionIndex])
}
