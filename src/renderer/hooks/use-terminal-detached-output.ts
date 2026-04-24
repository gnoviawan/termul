import { useEffect } from 'react'
import { terminalApi } from '@/lib/api'
import { useTerminalStore } from '@/stores/terminal-store'

/**
 * Captures PTY output even when no ConnectedTerminal renderer is mounted.
 * This preserves detached-period history across project switches.
 */
export function useTerminalDetachedOutput(): void {
  useEffect(() => {
    const unsubscribe = terminalApi.onData((ptyId: string, data: string) => {
      if (!data) {
        return
      }

      const store = useTerminalStore.getState()
      const terminal = store.findTerminalByPtyId(ptyId)
      if (!terminal) {
        return
      }

      if ((terminal.rendererAttachmentCount ?? 0) > 0) {
        return
      }

      store.appendDetachedOutput(ptyId, data)
    })

    return () => {
      unsubscribe()
    }
  }, [])
}
