import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useOptimisticSelect } from './use-optimistic-select'

describe('useOptimisticSelect', () => {
  it('shows optimistic value and pending while onSelect is in flight', async () => {
    let resolveSelect!: () => void
    const onSelect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSelect = resolve
        })
    )

    const { result, rerender } = renderHook(
      ({ committed }) => useOptimisticSelect(committed, onSelect),
      { initialProps: { committed: 'a' } }
    )

    act(() => {
      result.current.select('b')
    })

    expect(onSelect).toHaveBeenCalledWith('b')
    expect(result.current.displayValue).toBe('b')
    expect(result.current.pending).toBe(true)

    await act(async () => {
      resolveSelect()
    })

    await waitFor(() => {
      expect(result.current.pending).toBe(false)
    })

    // Optimistic clears once the parent commits the same value.
    rerender({ committed: 'b' })
    expect(result.current.displayValue).toBe('b')
    expect(result.current.pending).toBe(false)
  })

  it('soft-replaces: latest selection wins when a second pick happens mid-flight', async () => {
    const resolvers: Array<() => void> = []
    const onSelect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
    )

    const { result } = renderHook(() => useOptimisticSelect('a', onSelect))

    act(() => {
      result.current.select('b')
    })
    act(() => {
      result.current.select('c')
    })

    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(result.current.displayValue).toBe('c')
    expect(result.current.pending).toBe(true)

    await act(async () => {
      resolvers[0]?.()
    })
    expect(result.current.pending).toBe(true)
    expect(result.current.displayValue).toBe('c')

    await act(async () => {
      resolvers[1]?.()
    })
    await waitFor(() => {
      expect(result.current.pending).toBe(false)
    })
  })

  it('reverts optimistic value when onSelect rejects', async () => {
    let rejectSelect!: (err: Error) => void
    const onSelect = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSelect = reject
        })
    )

    const { result } = renderHook(() => useOptimisticSelect('a', onSelect))

    act(() => {
      result.current.select('b')
    })
    expect(result.current.displayValue).toBe('b')

    await act(async () => {
      rejectSelect(new Error('nope'))
    })

    await waitFor(() => {
      expect(result.current.displayValue).toBe('a')
      expect(result.current.pending).toBe(false)
    })
  })

  it('reverts optimistic value when onSelect throws synchronously', async () => {
    const onSelect = vi.fn(() => {
      throw new Error('sync fail')
    })

    const { result } = renderHook(() => useOptimisticSelect('a', onSelect))

    act(() => {
      result.current.select('b')
    })

    await waitFor(() => {
      expect(result.current.displayValue).toBe('a')
      expect(result.current.pending).toBe(false)
    })
  })

  it('no-ops when selecting the already displayed value', () => {
    const onSelect = vi.fn(async () => undefined)
    const { result } = renderHook(() => useOptimisticSelect('a', onSelect))

    act(() => {
      result.current.select('a')
    })

    expect(onSelect).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(false)
  })
})
