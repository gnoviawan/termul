/**
 * Tiered flush clock for the transcript coalescing buffer (Conventions ›
 * Render clocks):
 *
 * - the WATCHED session (the one on screen) flushes at most every
 *   {@link WATCHED_FLUSH_MS} on `requestAnimationFrame`;
 * - every BACKGROUND session flushes on a {@link BACKGROUND_FLUSH_MS} timer;
 * - the {@link FLUSH_BACKSTOP_MS} timer drains everything when rAF is
 *   suspended (an occluded/minimized WebView keeps the callback armed but never
 *   fires it — without it a hidden-but-streaming session buffers unboundedly);
 * - approvals/questions and `visibilitychange` flush immediately through the
 *   owner's `flushNow` (see `transcript.ts`), which also cancels this clock.
 *
 * The clock owns scheduling only: what is buffered, and how a flush applies it,
 * stays with the host.
 */

export type FlushTier = 'watched' | 'background' | 'all'

export const WATCHED_FLUSH_MS = 30
export const BACKGROUND_FLUSH_MS = 100
export const FLUSH_BACKSTOP_MS = 250

export interface FlushClockHost {
  /** True while `sessionId` is the session on screen. Re-evaluated at fire time. */
  isWatched: (sessionId: string) => boolean
  /** Apply and remove the buffered updates of `tier`. */
  flush: (tier: FlushTier) => void
  /** True while buffered updates of `tier` remain. */
  hasPending: (tier: FlushTier) => boolean
}

export interface FlushClock {
  /** An update for `sessionId` was buffered: arm the clock for its tier. */
  note: (sessionId: string) => void
  /** Cancel every armed timer/frame (the owner is flushing synchronously). */
  cancel: () => void
  /** True while any frame or timer is armed. */
  isArmed: () => boolean
}

export function createFlushClock(host: FlushClockHost): FlushClock {
  let rafId: number | null = null
  let watchedTimerId: ReturnType<typeof setTimeout> | undefined
  let backgroundTimerId: ReturnType<typeof setTimeout> | undefined
  let backstopTimerId: ReturnType<typeof setTimeout> | undefined
  let lastWatchedFlushAt = Number.NEGATIVE_INFINITY

  const hasRaf = (): boolean => typeof requestAnimationFrame === 'function'
  const nowMs = (): number => performance.now()

  function cancelWatched(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    clearTimeout(watchedTimerId)
    watchedTimerId = undefined
  }

  function cancelBackground(): void {
    clearTimeout(backgroundTimerId)
    backgroundTimerId = undefined
  }

  function cancelBackstop(): void {
    clearTimeout(backstopTimerId)
    backstopTimerId = undefined
  }

  function cancel(): void {
    cancelWatched()
    cancelBackground()
    cancelBackstop()
  }

  /** Re-arm whatever the buffer still needs after any flush; drop the rest. */
  function rearm(): void {
    if (host.hasPending('watched')) armWatched()
    else cancelWatched()
    if (host.hasPending('background')) armBackground()
    else cancelBackground()
    if (host.hasPending('all')) armBackstop()
    else cancelBackstop()
  }

  function runFlush(tier: FlushTier): void {
    if (tier === 'all') cancel()
    else if (tier === 'watched') cancelWatched()
    else cancelBackground()
    if (tier !== 'background') lastWatchedFlushAt = nowMs()
    host.flush(tier)
    rearm()
  }

  function onFrame(): void {
    rafId = null
    // ≥ 30 ms since the last watched flush, else wait for another frame.
    if (nowMs() - lastWatchedFlushAt < WATCHED_FLUSH_MS) {
      rafId = requestAnimationFrame(onFrame)
      return
    }
    runFlush('watched')
  }

  function armWatched(): void {
    if (rafId !== null || watchedTimerId !== undefined) return
    if (hasRaf()) {
      rafId = requestAnimationFrame(onFrame)
    } else {
      // No rAF (non-browser host): replicate the cadence with a timer.
      const wait = Math.max(0, lastWatchedFlushAt + WATCHED_FLUSH_MS - nowMs())
      watchedTimerId = setTimeout(() => {
        watchedTimerId = undefined
        runFlush('watched')
      }, wait)
    }
  }

  function armBackground(): void {
    if (backgroundTimerId !== undefined) return
    backgroundTimerId = setTimeout(() => {
      backgroundTimerId = undefined
      runFlush('background')
    }, BACKGROUND_FLUSH_MS)
  }

  function armBackstop(): void {
    if (backstopTimerId !== undefined) return
    backstopTimerId = setTimeout(() => {
      backstopTimerId = undefined
      runFlush('all')
    }, FLUSH_BACKSTOP_MS)
  }

  return {
    note(sessionId) {
      if (host.isWatched(sessionId)) armWatched()
      else armBackground()
      armBackstop()
    },
    cancel,
    isArmed: () =>
      rafId !== null ||
      watchedTimerId !== undefined ||
      backgroundTimerId !== undefined ||
      backstopTimerId !== undefined
  }
}
