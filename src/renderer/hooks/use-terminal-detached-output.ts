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

  // Log at every crossed 100KB increment to avoid missing milestones
  const kb = Math.floor(totalTranscriptLen / 1024)
  const prevKb = Math.floor((totalTranscriptLen - dataLen) / 1024)
  if (kb > 0 && Math.floor(kb / 100) !== Math.floor(prevKb / 100)) {
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
    // Buffer for PTY data that arrives before the store has the terminal record
    // (e.g. between spawn and setTerminalPtyId populating the ptyIdIndex).
    const pendingDetachedBuffer = new Map<string, string[]>()

    const unsubscribe = terminalApi.onData((ptyId: string, data: Uint8Array) => {
      if (!data || data.length === 0) {
        return
      }

      // Decode binary data to string for transcript storage
      const dataString = new TextDecoder().decode(data)

      // Flush any previously buffered data for this PTY
      // Decode data to string for transcript operations
      const dataStr = new TextDecoder().decode(data)

      const buffered = pendingDetachedBuffer.get(ptyId)
      if (buffered) {
        pendingDetachedBuffer.delete(ptyId)
        const store = useTerminalStore.getState()
        const terminal = store.findTerminalByPtyId(ptyId)
        if (terminal && (terminal.rendererAttachmentCount ?? 0) === 0) {
          const allData = buffered.join('') + dataStr
          store.appendTranscript(ptyId, allData)
          if (IS_DEV && terminal.transcript !== undefined) {
            logTranscriptStats(ptyId, allData.length, terminal.transcript.length + allData.length)
          }
          return
        }
        // Terminal exists but has renderer attached — drop buffered data
      }

      const store = useTerminalStore.getState()
      const terminal = store.findTerminalByPtyId(ptyId)
      if (!terminal) {
        // Store record not yet available — buffer data until it is
        if (IS_DEV) {
          console.debug(
            `[DetachedOutput] Buffering data for unknown PTY pty=${ptyId.slice(0, 12)} len=${dataStr.length}`
          )
        }
        const existing = pendingDetachedBuffer.get(ptyId)
        if (existing) {
          existing.push(dataStr)
        } else {
          pendingDetachedBuffer.set(ptyId, [dataStr])
        }
        return
      }

      const rendererAttachmentCount = terminal.rendererAttachmentCount ?? 0

      // Only capture when truly detached — no renderer mounted.
      // Do NOT capture when the app is hidden but a renderer is attached.
      if (rendererAttachmentCount > 0) {
        return
      }

      store.appendTranscript(ptyId, dataStr)

      if (IS_DEV && terminal.transcript !== undefined) {
        // Compute new length directly from terminal object instead of re-querying store
        logTranscriptStats(ptyId, dataStr.length, terminal.transcript.length + dataStr.length)
      }
    })

    return () => {
      unsubscribe()
      pendingDetachedBuffer.clear()
    }
  }, [])
}
