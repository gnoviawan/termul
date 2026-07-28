import { useEffect } from 'react'
import { initAcpEventListeners } from '@/stores/acp-store'

/**
 * Wire the ACP store to backend events exactly once for the app lifetime.
 * Transport-agnostic (Story 1.6): Tauri IPC on desktop, WS on web — both go
 * through `acpApi.onEvent` / `getAcpTransport().onEvent`.
 */
export function useAcpListeners(): void {
  useEffect(() => {
    const teardown = initAcpEventListeners()
    return () => {
      teardown()
    }
  }, [])
}
