import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_FLUSH_MS,
  createFlushClock,
  FLUSH_BACKSTOP_MS,
  type FlushTier,
  WATCHED_FLUSH_MS
} from './slices/transcript-flush-clock'

/**
 * Host double for the clock: a buffer of session ids where `watched` is the
 * on-screen session. `flush` drains the tier like the real transcript buffer.
 */
function makeHost(initialWatched: string) {
  let watched = initialWatched
  let buffer: string[] = []
  const flushed: Array<{ tier: FlushTier; at: number; sessions: string[] }> = []
  const matches = (tier: FlushTier, sid: string): boolean =>
    tier === 'all' || (tier === 'watched' ? sid === watched : sid !== watched)
  const host = {
    isWatched: (sid: string) => sid === watched,
    hasPending: (tier: FlushTier) => buffer.some((sid) => matches(tier, sid)),
    flush: (tier: FlushTier) => {
      const drained = buffer.filter((sid) => matches(tier, sid))
      buffer = buffer.filter((sid) => !matches(tier, sid))
      if (drained.length > 0) flushed.push({ tier, at: performance.now(), sessions: drained })
    }
  }
  const clock = createFlushClock(host)
  return {
    clock,
    flushed,
    push(sid: string) {
      buffer.push(sid)
      clock.note(sid)
    },
    setWatched(sid: string) {
      watched = sid
    },
    pending: () => buffer.length
  }
}

describe('transcript flush clock (render clocks)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes the watched session at most every ~30 ms, on a frame', () => {
    const h = makeHost('watched')
    // A steady token stream: one chunk every 4 ms for 200 ms.
    for (let t = 0; t < 200; t += 4) {
      h.push('watched')
      vi.advanceTimersByTime(4)
    }
    vi.advanceTimersByTime(100)
    expect(h.pending()).toBe(0)
    const watchedFlushes = h.flushed.filter((f) => f.tier === 'watched')
    // Frame-aligned and rate-limited: ~200 ms / 30 ms flushes, never one per frame (16 ms).
    expect(watchedFlushes.length).toBeGreaterThanOrEqual(5)
    expect(watchedFlushes.length).toBeLessThanOrEqual(8)
    for (let i = 1; i < watchedFlushes.length; i++) {
      expect(watchedFlushes[i].at - watchedFlushes[i - 1].at).toBeGreaterThanOrEqual(
        WATCHED_FLUSH_MS - 1
      )
    }
  })

  it('does not flush a background session before ~100 ms, then drains it on the timer', () => {
    const h = makeHost('watched')
    h.push('background')
    vi.advanceTimersByTime(BACKGROUND_FLUSH_MS - 1)
    expect(h.flushed).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(h.flushed).toEqual([
      expect.objectContaining({ tier: 'background', sessions: ['background'] })
    ])
  })

  it('a watched flush leaves background updates for their own clock', () => {
    const h = makeHost('watched')
    h.push('background')
    h.push('watched')
    vi.advanceTimersByTime(WATCHED_FLUSH_MS + 20)
    expect(h.flushed.map((f) => f.sessions)).toEqual([['watched']])
    expect(h.pending()).toBe(1)
    vi.advanceTimersByTime(BACKGROUND_FLUSH_MS)
    expect(h.flushed.map((f) => f.sessions)).toEqual([['watched'], ['background']])
  })

  it('drains everything via the timer backstop when requestAnimationFrame never fires', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    try {
      const h = makeHost('watched')
      h.push('watched')
      vi.advanceTimersByTime(FLUSH_BACKSTOP_MS - 1)
      expect(h.flushed).toHaveLength(0)
      vi.advanceTimersByTime(1)
      expect(h.flushed).toEqual([expect.objectContaining({ tier: 'all', sessions: ['watched'] })])
      expect(h.clock.isArmed()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('re-tiers at fire time when the watched session changes while buffered', () => {
    const h = makeHost('a')
    const start = performance.now()
    h.push('b') // background when buffered: only the background timer is armed
    h.setWatched('b') // the user switches to it before that timer fires
    // No second push: nothing but the original background timer can reach it.
    vi.advanceTimersByTime(BACKGROUND_FLUSH_MS - 1)
    expect(h.flushed).toHaveLength(0)
    // The timer fires, finds nothing for the background tier (b is watched now)
    // and re-tiers the leftover onto the watched frame clock…
    vi.advanceTimersByTime(1)
    expect(h.flushed).toHaveLength(0)
    // …which flushes it on the following frame — well before the 250 ms backstop.
    vi.advanceTimersByTime(WATCHED_FLUSH_MS)
    expect(h.flushed).toEqual([expect.objectContaining({ tier: 'watched', sessions: ['b'] })])
    expect(h.flushed[0].at - start).toBeLessThan(FLUSH_BACKSTOP_MS)
    // Exactly once: nothing is left for the backstop.
    vi.advanceTimersByTime(FLUSH_BACKSTOP_MS * 2)
    expect(h.flushed).toHaveLength(1)
    expect(h.clock.isArmed()).toBe(false)
  })

  it('cancel() disarms every frame and timer', () => {
    const h = makeHost('watched')
    h.push('watched')
    h.push('background')
    expect(h.clock.isArmed()).toBe(true)
    h.clock.cancel()
    expect(h.clock.isArmed()).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(h.flushed).toHaveLength(0)
  })
})
