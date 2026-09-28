import { useEffect } from 'react'
import { terminalApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { MAX_TRANSCRIPT_CHARS, useTerminalStore } from '@/stores/terminal-store'

const IS_DEV = import.meta.env.DEV

const textDecoder = new TextDecoder()

/**
 * Schedule a flush callback; returns a cancel fn.
 *
 * `requestAnimationFrame` is the primary path (aligns PTY transcript appends
 * with the renderer's frame cadence — one store write per terminal per frame).
 * A 250ms `setTimeout` backstop runs alongside it: a HIDDEN webview never
 * paints, so rAF stays suspended indefinitely and the per-ptyId buffers would
 * grow unbounded without the timer (whichever fires first flushes; the flush
 * itself clears both). Environments without rAF (jsdom) use the timer alone
 * at one nominal frame (~16ms). The fallback must NOT be `queueMicrotask`: a
 * microtask flush fires before the current synchronous burst of
 * `terminalApi.onData` callbacks finishes, re-fragmenting the burst into
 * per-callback store writes and defeating the coalescing entirely.
 */
const FLUSH_BACKSTOP_MS = 250

function scheduleFlush(callback: () => void): () => void {
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : null
  // Whichever fires first wins: `flushPending` invokes `cancelFlush` at flush
  // start, cancelling the loser arm of this same pair.
  const timer = setTimeout(callback, raf === null ? 16 : FLUSH_BACKSTOP_MS)
  return () => {
    if (raf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(raf)
    }
    clearTimeout(timer)
  }
}

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
        `(${((totalTranscriptLen / MAX_TRANSCRIPT_CHARS) * 100).toFixed(1)}% of cap)`
    )
  }
}

interface PendingBuffer {
  /** Decoded chunks in strict arrival order. */
  chunks: string[]
  /**
   * True once a chunk was captured while the terminal record existed and was
   * detached. Such chunks were provably not displayed live anywhere (no
   * renderer was mounted when they arrived), so they must reach the
   * transcript even if a renderer attaches before the flush — dropping them
   * would lose data the pre-coalescing code captured synchronously.
   */
  capturedDetached: boolean
}

/**
 * Push a chunk into a pending buffer, keeping the buffered char count at or
 * below the store's transcript cap (`MAX_TRANSCRIPT_CHARS`): when the cap
 * would be exceeded, the OLDEST chunks drop from the head — a hidden-window
 * burst between (backstopped) flushes must not grow the buffer unbounded,
 * and the transcript itself truncates head-first the same way.
 */
function pushChunk(buffer: PendingBuffer, chunk: string): void {
  buffer.chunks.push(chunk)
  let total = 0
  for (const part of buffer.chunks) total += part.length
  while (buffer.chunks.length > 1 && total > MAX_TRANSCRIPT_CHARS) {
    total -= buffer.chunks.shift()!.length
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
 *
 * Chunks are coalesced into per-ptyId string buffers and flushed with a single
 * `appendTranscript` per ptyId per animation frame, so a frame's chunk burst
 * costs one `set()` + subscriber fan-out per terminal instead of one per chunk.
 * `appendTranscript` itself keeps its synchronous store semantics.
 *
 * The same buffers also serve the pre-store path (data arriving before the store
 * knows the ptyId): those chunks accumulate in order and are only flushed once
 * the terminal record exists, preserving the historical `pendingDetachedBuffer`
 * ordering semantics.
 *
 * Same-frame approximation (accepted, documented): capture eligibility is
 * decided when a chunk ARRIVES, exactly as before batching. If a renderer
 * attaches after a detached chunk was buffered but before the frame flush, the
 * buffer is still appended — those chunks arrived while no renderer existed, so
 * nobody displayed them live and dropping them would lose data. They surface on
 * the next replay instead of the current one (the pre-change code appended them
 * synchronously, so its replay could show them immediately). Pre-store chunks
 * (buffered while the ptyId was unknown) are the exception: if the terminal
 * turns out to have an attached renderer at flush time they are dropped, because
 * the renderer was writing that data into xterm live while the record was
 * missing — appending would double-display it on a later replay.
 */
export function useTerminalDetachedOutput(): void {
  useEffect(() => {
    const pendingBuffers = new Map<string, PendingBuffer>()
    let cancelFlush: (() => void) | null = null

    const flushPending = (): void => {
      // First flush wins: drop this pair's remaining arm so the loser (a
      // 250ms backstop timer surviving a frame flush, or a frame callback
      // surviving a backstop flush) cannot fire a second early flush.
      if (cancelFlush) {
        cancelFlush()
        cancelFlush = null
      }
      if (pendingBuffers.size === 0) return

      const store = useTerminalStore.getState()
      for (const [ptyId, buffer] of pendingBuffers) {
        const terminal = store.findTerminalByPtyId(ptyId)
        if (!terminal) {
          // Store record still not available — keep buffering. Delivery is
          // retried when the next chunk arrives (the original
          // pendingDetachedBuffer semantics), so no timer loop is needed.
          continue
        }

        if ((terminal.rendererAttachmentCount ?? 0) > 0 && !buffer.capturedDetached) {
          // Pure pre-store data for a terminal with a live renderer: xterm has
          // been displaying this stream since before the store record existed,
          // so the buffer is redundant — drop it rather than double-capture.
          pendingBuffers.delete(ptyId)
          continue
        }

        const joined = buffer.chunks.join('')
        pendingBuffers.delete(ptyId)

        store.appendTranscript(ptyId, joined)

        if (IS_DEV && terminal.transcript !== undefined) {
          // terminal is the pre-append snapshot; joined.length is this flush's
          // merged delta — same accounting the per-chunk version used.
          logTranscriptStats(ptyId, joined.length, terminal.transcript.length + joined.length)
        }
      }
    }

    const unsubscribe = terminalApi.onData((ptyId: string, data: Uint8Array) => {
      if (!data || data.length === 0) {
        return
      }

      // Decode binary data to string for transcript operations
      const dataStr = textDecoder.decode(data)

      const store = useTerminalStore.getState()
      const terminal = store.findTerminalByPtyId(ptyId)

      if (!terminal) {
        // Store record not yet available — buffer data until it is
        if (IS_DEV) {
          console.debug(
            `[DetachedOutput] Buffering data for unknown PTY pty=${ptyId.slice(0, 12)} len=${dataStr.length}`
          )
        }
        const buffer = pendingBuffers.get(ptyId)
        if (buffer) {
          pushChunk(buffer, dataStr)
        } else {
          pendingBuffers.set(ptyId, { chunks: [dataStr], capturedDetached: false })
        }
        return
      }

      const rendererAttachmentCount = terminal.rendererAttachmentCount ?? 0

      // Only capture when truly detached — no renderer mounted.
      // Do NOT capture when the app is hidden but a renderer is attached.
      if (rendererAttachmentCount > 0) {
        // A renderer is attached: it writes data into xterm.js directly, so
        // this chunk is redundant with the live view. Any purely pre-store
        // buffer for this pty is likewise redundant — drop it now (matching
        // the pre-coalescing behavior). A buffer holding chunks captured
        // while detached is left alone: it still flushes this frame.
        const buffer = pendingBuffers.get(ptyId)
        if (buffer && !buffer.capturedDetached) {
          pendingBuffers.delete(ptyId)
        }
        return
      }

      const buffer = pendingBuffers.get(ptyId)
      if (buffer) {
        pushChunk(buffer, dataStr)
        buffer.capturedDetached = true
      } else {
        pendingBuffers.set(ptyId, { chunks: [dataStr], capturedDetached: true })
      }
      if (!cancelFlush) {
        cancelFlush = scheduleFlush(flushPending)
      }
    })

    return () => {
      // Synchronous drain on unmount so no chunk is lost: flush everything
      // still buffered before tearing down the subscription. Cancelling the
      // pending frame callback first also guarantees a scheduled flush never
      // fires after unmount (no leaked rAF holding stale buffers).
      if (cancelFlush) {
        cancelFlush()
        cancelFlush = null
      }
      try {
        flushPending()
      } catch (err) {
        // Boundary log for the unmount drain failing (spec CAP-5): the
        // teardown must still complete — never rethrow out of an effect
        // cleanup. No transcript content is logged.
        void logFrontendError({
          level: 'warn',
          source: 'terminal.detachedOutput',
          message: `Unmount flush failed while draining buffered PTY output: ${String(err)}`
        })
      }
      pendingBuffers.clear()
      unsubscribe()
    }
  }, [])
}
