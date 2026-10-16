import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECONNECT_GRACE_MS, useDelayedFlag } from './use-delayed-flag'

describe('useDelayedFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses a 1000 ms reconnect grace period', () => {
    expect(RECONNECT_GRACE_MS).toBe(1000)
  })

  it('stays false while the flag is false', () => {
    const { result } = renderHook(() => useDelayedFlag(false, 1000))
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current).toBe(false)
  })

  it('turns true only after the flag has stayed true for the delay', () => {
    const { result } = renderHook(({ flag }) => useDelayedFlag(flag, 1000), {
      initialProps: { flag: true }
    })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(true)
  })

  it('never turns true when the flag drops before the delay (quick flap)', () => {
    const { result, rerender } = renderHook(({ flag }) => useDelayedFlag(flag, 1000), {
      initialProps: { flag: true }
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    rerender({ flag: false })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current).toBe(false)
  })

  it('turns false in the same render the flag drops', () => {
    const { result, rerender } = renderHook(({ flag }) => useDelayedFlag(flag, 1000), {
      initialProps: { flag: true }
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(true)
    rerender({ flag: false })
    expect(result.current).toBe(false)
  })

  it('restarts the delay when the flag rises again', () => {
    const { result, rerender } = renderHook(({ flag }) => useDelayedFlag(flag, 1000), {
      initialProps: { flag: true }
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(true)
    rerender({ flag: false })
    rerender({ flag: true })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(true)
  })
})
