import { useEffect } from 'react'
import { terminalApi } from '@/lib/api'
import { useTerminalStore, MAX_TRANSCRIPT_CHARS } from '@/stores/terminal-store'

const IS_DEV = import.meta.env.DEV

/**
 * Tracks transcript buffer sizes and logs warnings when they grow large.
 * Helps diagnose memory growth issues during development.
 */
function logTranscriptStats(ptyId: string, dataLen: number, totalTranscriptLen: number): void {
  if (!IS_DEV) return

  // Log at 100KB increments to avoid spam
  const kb = Math.floor(totalTranscriptLen / 1024)
  const prevKb = Math.floor((totalTranscriptLen - dataLen) / 1024)
  if (kb > 0 && kb !== prevKb && kb % 100 === 0) {
    console.debug(
      `[MemTrack] transcript pty=${ptyId.slice(0, 12)} size=${kb}KB ` +
      `(${(totalTranscriptLen / MAX_TRANSCRIPT_CHARS * 100).toFixed(1)}% of cap)`
    )
  }
}

/**
 * Captures PTY output only when a renderer-side replay buffer is actually needed.
 * This is exclusively for the detached-terminal case — when no ConnectedTerminal
 * renderer is mounted (e.g. project switch, pane removal). In that situation the
 * data is needed to reconstruct terminal continuity when the user returns.
 *
 * When a renderer IS attached (even if the app window is hidden/minimized), the
 * transcript should NOT capture because:
 *   - xterm.js already has the pre-hide buffer in its own internal state
 *   - replaying the transcript on restore is synchronous and blocks the main thread
 *   - the renderer resumes receiving live data immediately on restore
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

      // Only capture when truly detached — no renderer mounted.
      // Do NOT capture when the app is hidden but a renderer is attached.
      if (rendererAttachmentCount > 0) {
        return
      }

      store.appendTranscript(ptyId, data)

      if (IS_DEV) {
        const storeState = useTerminalStore.getState()
        const updatedTerminal = storeState.findTerminalByPtyId(ptyId)
        if (updatedTerminal?.transcript) {
          logTranscriptStats(ptyId, data.length, updatedTerminal.transcript.length)
        }
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])
}

