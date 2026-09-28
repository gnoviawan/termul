import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThrottledStreamingText } from './use-throttled-streaming-text'

describe('useThrottledStreamingText', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('returns the first streaming text immediately', () => {
    const { result } = renderHook(() => useThrottledStreamingText('a', true))

    expect(result.current).toBe('a')
  })

  it('commits at most one text change per 100 ms during streaming', () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useThrottledStreamingText(text, streaming),
      { initialProps: { text: 'a', streaming: true } }
    )

    // Initial commit lands immediately.
    expect(result.current).toBe('a')

    // Bursts inside the 100 ms window: the trailing-edge timer absorbs them.
    for (let i = 1; i <= 5; i++) {
      rerender({ text: `a${i}`, streaming: true })
    }
    expect(result.current).toBe('a')

    // One trailing commit at the window boundary carries the latest text.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe('a5')

    // Quiet gap: the window has fully elapsed since the boundary commit, so
    // the next change lands immediately (no trailing timer needed).
    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender({ text: 'b', streaming: true })
    expect(result.current).toBe('b')
  })

  it('schedules the trailing commit only once for a burst inside the window', () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useThrottledStreamingText(text, streaming),
      { initialProps: { text: 'a', streaming: true } }
    )

    for (let i = 1; i <= 3; i++) {
      rerender({ text: `t${i}`, streaming: true })
    }
    expect(vi.getTimerCount()).toBe(1)

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe('t3')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('commits the final text immediately and synchronously at turn end', () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useThrottledStreamingText(text, streaming),
      { initialProps: { text: 'a', streaming: true } }
    )

    rerender({ text: 'final', streaming: true })
    expect(result.current).toBe('a')

    // Turn end commits the exact text during this render, with no timer.
    rerender({ text: 'final', streaming: false })
    expect(result.current).toBe('final')
    expect(vi.getTimerCount()).toBe(0)

    // No stale trailing commit fires later.
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(result.current).toBe('final')
  })

  it('cancels a pending trailing commit when streaming flips false', () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useThrottledStreamingText(text, streaming),
      { initialProps: { text: 'a', streaming: true } }
    )

    rerender({ text: 'pending', streaming: true })
    expect(vi.getTimerCount()).toBe(1)

    rerender({ text: 'final', streaming: false })
    expect(vi.getTimerCount()).toBe(0)
    expect(result.current).toBe('final')
  })

  it('returns historical (non-streaming) text unthrottled on every change', () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useThrottledStreamingText(text, streaming),
      { initialProps: { text: 'history-a', streaming: false } }
    )

    expect(result.current).toBe('history-a')
    rerender({ text: 'history-b', streaming: false })
    expect(result.current).toBe('history-b')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resets the throttle window after a turn ends so a re-stream can commit immediately', () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useThrottledStreamingText(text, streaming),
      { initialProps: { text: 'a', streaming: true } }
    )

    rerender({ text: 'done', streaming: false })
    expect(result.current).toBe('done')

    // Re-stream: first chunk commits without waiting.
    rerender({ text: 'new-turn', streaming: true })
    expect(result.current).toBe('new-turn')
  })

  it('never leaves a pending trailing timer behind after unmount', () => {
    const { rerender, unmount } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useThrottledStreamingText(text, streaming),
      { initialProps: { text: 'a', streaming: true } }
    )

    rerender({ text: 'pending', streaming: true })
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
