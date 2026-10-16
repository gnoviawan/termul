import { useEffect } from 'react'
import { terminalApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { MAX_TRANSCRIPT_CHARS, useTerminalStore } from '@/stores/terminal-store'

const IS_DEV = import.meta.env.DEV

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

/**
 * How long an exited pty's buffer waits for its terminal record. A record can
 * legitimately arrive long after the exit: restore seeds a preserved pty's
 * exit from its attach snapshot, then registers every terminal only after its
 * serial attach loop (one step per terminal, each bounded by a 30s spawn
 * timeout). Five minutes covers ten timed-out steps.
 */
const EXITED_PTY_GRACE_MS = 5 * 60_000

/** Exited ptyIds remembered so late chunks never re-create a decoder. */
const MAX_REMEMBERED_EXITS = 1024

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
   * Running sum of `chunks` lengths — kept in sync on push and trim so the
   * cap check never rescans the whole chunk array (a 10k-chunk burst would
   * otherwise cost ~50M length additions before the flush).
   */
  totalChars: number
  /**
   * True once a chunk was captured while the terminal record existed and was
   * detached. Such chunks were provably not displayed live anywhere (no
   * renderer was mounted when they arrived), so they must reach the
   * transcript even if a renderer attaches before the flush — dropping them
   * would lose data the pre-coalescing code captured synchronously.
   */
  capturedDetached: boolean
  dropTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Push a chunk into a pending buffer, keeping the buffered char count at or
 * below the store's transcript cap (`MAX_TRANSCRIPT_CHARS`). Trim semantics
 * preserve the NEWEST characters within the cap, mirroring the store's own
 * head-first transcript truncation: whole head chunks drop while two or more
 * remain, then the residual overflow is clipped at the exact position — a
 * 1.49M-char chunk followed by a 20k-char chunk keeps the newest 1.5M chars,
 * and a single oversized chunk is clipped from its head too.
 */
function pushChunk(buffer: PendingBuffer, chunk: string): void {
  buffer.chunks.push(chunk)
  buffer.totalChars += chunk.length
  // Whole-chunk drops while at least two chunks remain (cheap, common path).
  while (
    buffer.chunks.length > 1 &&
    buffer.totalChars - buffer.chunks[0].length >= MAX_TRANSCRIPT_CHARS
  ) {
    buffer.totalChars -= buffer.chunks.shift()!.length
  }
  // Clip the residual overflow at the exact position: keep the newest
  // MAX_TRANSCRIPT_CHARS chars of the buffered stream.
  if (buffer.totalChars > MAX_TRANSCRIPT_CHARS) {
    const excess = buffer.totalChars - MAX_TRANSCRIPT_CHARS
    buffer.chunks[0] = buffer.chunks[0].slice(excess)
    buffer.totalChars = MAX_TRANSCRIPT_CHARS
  }
}

/** Synchronous drain of the mounted hook's coalescing buffers; null when unmounted. */
let flushDetachedOutputHandle: (() => void) | null = null

/**
 * Append every buffered detached chunk to the store transcript right now
 * instead of on the next frame. A remounting renderer calls this before it
 * reads the transcript: otherwise chunks captured while it was detached would
 * land in the transcript after it attached, and be replayed on a later remount
 * behind newer output. No-op when the hook is not mounted.
 */
export function flushDetachedOutputNow(): void {
  flushDetachedOutputHandle?.()
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
    const decoders = new Map<string, TextDecoder>()
    const exited = new Set<string>()
    let cancelFlush: (() => void) | null = null

    const dropBuffer = (ptyId: string): void => {
      const buffer = pendingBuffers.get(ptyId)
      if (buffer?.dropTimer) clearTimeout(buffer.dropTimer)
      pendingBuffers.delete(ptyId)
    }

    const dropIfStillUnregistered = (ptyId: string, buffer: PendingBuffer): void => {
      buffer.dropTimer = null
      if (useTerminalStore.getState().findTerminalByPtyId(ptyId)) return
      pendingBuffers.delete(ptyId)
      if (IS_DEV) {
        console.debug(
          `[DetachedOutput] Dropped ${buffer.totalChars} chars buffered for exited pty=${ptyId} that never got a terminal record`
        )
      }
    }

    const armExitedDrop = (ptyId: string, buffer: PendingBuffer): void => {
      if (!exited.has(ptyId)) return
      buffer.dropTimer ??= setTimeout(
        () => dropIfStillUnregistered(ptyId, buffer),
        EXITED_PTY_GRACE_MS
      )
    }

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
          armExitedDrop(ptyId, buffer)
          continue
        }

        if ((terminal.rendererAttachmentCount ?? 0) > 0 && !buffer.capturedDetached) {
          // Pure pre-store data for a terminal with a live renderer: xterm has
          // been displaying this stream since before the store record existed,
          // so the buffer is redundant — drop it rather than double-capture.
          dropBuffer(ptyId)
          continue
        }

        const joined = buffer.chunks.join('')
        dropBuffer(ptyId)

        store.appendTranscript(ptyId, joined)

        if (IS_DEV && terminal.transcript !== undefined) {
          // terminal is the pre-append snapshot; joined.length is this flush's
          // merged delta — same accounting the per-chunk version used.
          logTranscriptStats(ptyId, joined.length, terminal.transcript.length + joined.length)
        }
      }
    }

    // Drain trigger for pre-store buffers: the Tauri spawn adapter can emit
    // output before spawn() resolves and setTerminalPtyId binds the ptyId
    // (the unknown-PTY branch returns without scheduling a flush, and a
    // running flush retains still-unknown buffers). Re-running flushPending
    // on every store change delivers those buffers as soon as the record
    // appears — no new chunk required.
    const unsubscribeStore = useTerminalStore.subscribe(flushPending)
    flushDetachedOutputHandle = flushPending

    const capture = (ptyId: string, dataStr: string): void => {
      const store = useTerminalStore.getState()
      const terminal = store.findTerminalByPtyId(ptyId)

      if (!terminal) {
        // Store record not yet available — buffer data until it is
        if (IS_DEV) {
          console.debug(
            `[DetachedOutput] Buffering data for unknown PTY pty=${ptyId.slice(0, 12)} len=${dataStr.length}`
          )
        }
        let buffer = pendingBuffers.get(ptyId)
        if (!buffer) {
          // Create via pushChunk so the very first chunk is cap-checked and
          // clipped (a lone oversized chunk must not bypass the bound).
          buffer = { chunks: [], totalChars: 0, capturedDetached: false, dropTimer: null }
          pendingBuffers.set(ptyId, buffer)
        }
        pushChunk(buffer, dataStr)
        armExitedDrop(ptyId, buffer)
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
          dropBuffer(ptyId)
        }
        return
      }

      const buffer = pendingBuffers.get(ptyId)
      if (buffer) {
        pushChunk(buffer, dataStr)
        buffer.capturedDetached = true
      } else {
        // Create via pushChunk so the very first chunk is cap-checked and
        // clipped (a lone oversized chunk must not bypass the bound).
        const buffer: PendingBuffer = {
          chunks: [],
          totalChars: 0,
          capturedDetached: true,
          dropTimer: null
        }
        pendingBuffers.set(ptyId, buffer)
        pushChunk(buffer, dataStr)
      }
      if (!cancelFlush) {
        cancelFlush = scheduleFlush(flushPending)
      }
    }

    const unsubscribe = terminalApi.onData((ptyId: string, data: Uint8Array) => {
      if (!data || data.length === 0) {
        return
      }
      if (exited.has(ptyId)) {
        // Desktop sends the exit before the reader's final batch.
        capture(ptyId, new TextDecoder().decode(data))
        return
      }
      let decoder = decoders.get(ptyId)
      if (!decoder) {
        decoder = new TextDecoder()
        decoders.set(ptyId, decoder)
      }
      const dataStr = decoder.decode(data, { stream: true })
      if (dataStr) capture(ptyId, dataStr)
    })

    const unsubscribeExit = terminalApi.onExit((ptyId: string) => {
      exited.delete(ptyId)
      exited.add(ptyId)
      if (exited.size > MAX_REMEMBERED_EXITS) {
        exited.delete(exited.values().next().value as string)
      }
      const tail = decoders.get(ptyId)?.decode()
      decoders.delete(ptyId)
      if (tail) capture(ptyId, tail)
      const buffer = pendingBuffers.get(ptyId)
      if (buffer) armExitedDrop(ptyId, buffer)
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
      for (const ptyId of [...pendingBuffers.keys()]) dropBuffer(ptyId)
      decoders.clear()
      if (flushDetachedOutputHandle === flushPending) flushDetachedOutputHandle = null
      unsubscribeStore()
      unsubscribe()
      unsubscribeExit()
    }
  }, [])
}
