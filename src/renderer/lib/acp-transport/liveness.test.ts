import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_HEARTBEAT_INTERVAL_MS, HOST_SILENCE_LIMIT_MS, HostLiveness } from './liveness'

describe('HostLiveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports silence only past 2.5 heartbeat intervals, then waits a full limit again', () => {
    const onSilent = vi.fn()
    const liveness = new HostLiveness({ onSilent })
    liveness.start()
    vi.advanceTimersByTime(HOST_SILENCE_LIMIT_MS)
    expect(onSilent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(HOST_HEARTBEAT_INTERVAL_MS)
    expect(onSilent).toHaveBeenCalledTimes(1)
    // A slow probe is not reported again on the next tick.
    vi.advanceTimersByTime(HOST_HEARTBEAT_INTERVAL_MS)
    expect(onSilent).toHaveBeenCalledTimes(1)
    liveness.stop()
  })

  it('treats any received frame as proof of life', () => {
    const onSilent = vi.fn()
    const liveness = new HostLiveness({ onSilent })
    liveness.start()
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(HOST_HEARTBEAT_INTERVAL_MS)
      liveness.touch()
    }
    expect(onSilent).not.toHaveBeenCalled()
    liveness.stop()
  })

  it('does not judge while the page cannot (hidden tab) and restarts the clock', () => {
    const onSilent = vi.fn()
    let canJudge = false
    const liveness = new HostLiveness({ onSilent, canJudge: () => canJudge })
    liveness.start()
    vi.advanceTimersByTime(HOST_SILENCE_LIMIT_MS * 4)
    expect(onSilent).not.toHaveBeenCalled()
    canJudge = true
    // The hidden period counts for nothing: a full limit must pass again.
    vi.advanceTimersByTime(HOST_SILENCE_LIMIT_MS)
    expect(onSilent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(HOST_HEARTBEAT_INTERVAL_MS / 2)
    expect(onSilent).toHaveBeenCalledTimes(1)
    liveness.stop()
  })

  it('stops checking after stop()', () => {
    const onSilent = vi.fn()
    const liveness = new HostLiveness({ onSilent })
    liveness.start()
    liveness.stop()
    vi.advanceTimersByTime(HOST_SILENCE_LIMIT_MS * 3)
    expect(onSilent).not.toHaveBeenCalled()
  })
})
