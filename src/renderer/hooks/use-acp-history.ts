import { useEffect } from 'react'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Load the persisted chat-history index once at app mount. Payloads load lazily
 * when a chat is opened.
 */
export function useAcpHistory(): void {
  const loadSessionIndex = useAcpStore((s) => s.loadSessionIndex)
  useEffect(() => {
    void loadSessionIndex()
  }, [loadSessionIndex])
}
