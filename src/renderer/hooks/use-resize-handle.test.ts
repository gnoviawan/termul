import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ResizeHandleOptions, useResizeHandle } from './use-resize-handle'

function setup(overrides: Partial<ResizeHandleOptions> = {}) {
  let value = 100
  const write = vi.fn((next: number) => {
    value = Math.min(200, Math.max(50, next))
  })
  const hook = renderHook(() =>
    useResizeHandle({
      axis: 'x',
      direction: 1,
      min: 50,
      max: 200,
      read: () => value,
      write,
      ...overrides
    })
  )
  return { ...hook, write, value: () => value }
}

const start = (init: Partial<React.PointerEvent<HTMLElement>>) =>
  ({ button: 0, preventDefault: () => {}, ...init }) as React.PointerEvent<HTMLElement>

const key = (k: string) => ({ key: k, preventDefault: vi.fn() }) as unknown as React.KeyboardEvent

describe('useResizeHandle', () => {
  it('grows with the pointer on the x axis when direction is 1 and stops on mouseup', () => {
    const { result, write } = setup()
    act(() => result.current.onDragStart(start({ clientX: 10 })))
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40 }))
    })
    expect(write).toHaveBeenLastCalledWith(130)
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'))
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 90 }))
    })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('shrinks with the pointer when direction is -1 and follows the y axis', () => {
    const { result, write } = setup({ axis: 'y', direction: -1 })
    act(() => result.current.onDragStart(start({ clientX: 0, clientY: 50 })))
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 70 }))
    })
    expect(write).toHaveBeenLastCalledWith(80)
  })

  it('uses pointer events and ignores a non-primary button in pointer mode', () => {
    const { result, write } = setup({ pointer: true })
    act(() => result.current.onDragStart(start({ button: 2, clientX: 0 })))
    act(() => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 10 }))
    })
    expect(write).not.toHaveBeenCalled()

    act(() => result.current.onDragStart(start({ clientX: 0 })))
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10 }))
    })
    expect(write).not.toHaveBeenCalled()
    act(() => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 10 }))
    })
    expect(write).toHaveBeenLastCalledWith(110)
    act(() => {
      document.dispatchEvent(new MouseEvent('pointercancel'))
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 30 }))
    })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('sets the body cursor while dragging and clears it on release and unmount', () => {
    const { result, unmount } = setup({ cursor: 'col-resize' })
    act(() => result.current.onDragStart(start({ clientX: 0 })))
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(document.body.style.cursor).toBe('')
    act(() => result.current.onDragStart(start({ clientX: 0 })))
    unmount()
    expect(document.body.style.userSelect).toBe('')
  })

  it('steps with the arrows along the axis, flipped by direction, and jumps with Home and End', () => {
    const grow = setup()
    act(() => grow.result.current.onKeyDown(key('ArrowRight')))
    expect(grow.value()).toBe(116)
    act(() => grow.result.current.onKeyDown(key('ArrowLeft')))
    expect(grow.value()).toBe(100)
    act(() => grow.result.current.onKeyDown(key('End')))
    expect(grow.value()).toBe(200)
    act(() => grow.result.current.onKeyDown(key('Home')))
    expect(grow.value()).toBe(50)

    const flipped = setup({ direction: -1 })
    act(() => flipped.result.current.onKeyDown(key('ArrowLeft')))
    expect(flipped.value()).toBe(116)

    const vertical = setup({ axis: 'y' })
    act(() => vertical.result.current.onKeyDown(key('ArrowDown')))
    expect(vertical.value()).toBe(116)
    act(() => vertical.result.current.onKeyDown(key('ArrowRight')))
    expect(vertical.value()).toBe(116)
  })

  it('leaves other keys alone', () => {
    const { result, write } = setup()
    const event = key('Enter')
    act(() => result.current.onKeyDown(event))
    expect(write).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
