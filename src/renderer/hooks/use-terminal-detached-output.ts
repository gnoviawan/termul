import { useEffect } from 'react'
import { terminalApi } from '@/lib/api'
import { useTerminalStore } from '@/stores/terminal-store'

/**
 * Captures PTY output only when a renderer-side replay buffer is actually needed.
 * Visible terminals with an attached renderer should not accumulate a second copy.
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

      const rendererAttachmentCount = terminal.rendererAttachmentCount ?? 0
      const shouldCaptureReplayHistory = terminal.isAppHidden === true || rendererAttachmentCount === 0

      if (!shouldCaptureReplayHistory) {
        return
      }

      store.appendTranscript(ptyId, data)
    })

    return () => {
      unsubscribe()
    }
  }, [])
}
