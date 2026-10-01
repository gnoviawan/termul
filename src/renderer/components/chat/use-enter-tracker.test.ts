import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENTER_WINDOW_MS, useEnterTracker } from './use-enter-tracker'

function setup(sessionId: string, ids: string[]) {
  return renderHook(({ sessionId: s, ids: i }) => useEnterTracker(s, i), {
    initialProps: { sessionId, ids }
  })
}

describe('useEnterTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not animate history present on the first render', () => {
    const { result } = setup('s1', ['a', 'b'])
    expect(result.current.animate('a')).toBe(false)
    expect(result.current.animate('b')).toBe(false)
  })

  it('animates rows appended at the live edge with a burst stagger index', () => {
    const { result, rerender } = setup('s1', ['a'])
    rerender({ sessionId: 's1', ids: ['a', 'b', 'c'] })
    expect(result.current.animate('b')).toBe(true)
    expect(result.current.animate('c')).toBe(true)
    expect(result.current.staggerIndex('b')).toBe(0)
    expect(result.current.staggerIndex('c')).toBe(1)

    rerender({ sessionId: 's1', ids: ['a', 'b', 'c', 'd'] })
    expect(result.current.staggerIndex('d')).toBe(0)
  })

  it('does not replay the entrance after the arrival window (virtualizer remount)', () => {
    const { result, rerender } = setup('s1', ['a'])
    rerender({ sessionId: 's1', ids: ['a', 'b'] })
    expect(result.current.animate('b')).toBe(true)

    vi.advanceTimersByTime(ENTER_WINDOW_MS)
    rerender({ sessionId: 's1', ids: ['a', 'b'] })
    expect(result.current.animate('b')).toBe(false)
  })

  it('does not animate older rows prepended above seen rows', () => {
    const { result, rerender } = setup('s1', ['c', 'd'])
    rerender({ sessionId: 's1', ids: ['a', 'b', 'c', 'd'] })
    expect(result.current.animate('a')).toBe(false)
    expect(result.current.animate('b')).toBe(false)
  })

  it('treats the new session history as seen on the first render after a switch', () => {
    const { result, rerender } = setup('s1', ['a'])
    rerender({ sessionId: 's2', ids: ['x', 'y'] })
    expect(result.current.animate('x')).toBe(false)
    expect(result.current.animate('y')).toBe(false)

    rerender({ sessionId: 's2', ids: ['x', 'y', 'z'] })
    expect(result.current.animate('z')).toBe(true)
  })
})
