import { useEffect } from 'react'
import { isTauriContext } from '@/lib/tauri-runtime'
import { initAcpEventListeners } from '@/stores/acp-store'

/**
 * Wire the ACP store to backend events exactly once for the app lifetime.
 * Mirrors the other global listener hooks (e.g. use-menu-updater-listener).
 */
export function useAcpListeners(): void {
  useEffect(() => {
    if (!isTauriContext()) {
      return
    }
    const teardown = initAcpEventListeners()
    return () => {
      teardown()
    }
  }, [])
}
