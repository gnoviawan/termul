import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAG_LIFT_FALLBACK_MS, useDragLift } from './use-drag-lift'

describe('useDragLift', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('drops the lift after the fallback when onDragTransitionEnd never fires', () => {
    const { result } = renderHook(() => useDragLift())
    act(() => result.current.lift('infra'))
    act(() => result.current.release('infra'))
    act(() => vi.advanceTimersByTime(DRAG_LIFT_FALLBACK_MS - 1))
    expect(result.current.liftedId).toBe('infra')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.liftedId).toBeNull()
  })

  it('settles at once when the snap-back finishes', () => {
    const { result } = renderHook(() => useDragLift())
    act(() => result.current.lift('infra'))
    act(() => result.current.release('infra'))
    act(() => result.current.settle('infra'))
    expect(result.current.liftedId).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("never clears a newer drag's lift", () => {
    const { result } = renderHook(() => useDragLift())
    act(() => result.current.lift('infra'))
    act(() => result.current.release('infra'))
    act(() => result.current.lift('docs'))
    expect(vi.getTimerCount()).toBe(0)
    act(() => result.current.settle('infra'))
    act(() => vi.advanceTimersByTime(DRAG_LIFT_FALLBACK_MS))
    expect(result.current.liftedId).toBe('docs')
  })

  it('cancels the fallback on unmount', () => {
    const { result, unmount } = renderHook(() => useDragLift())
    act(() => result.current.lift('infra'))
    act(() => result.current.release('infra'))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
