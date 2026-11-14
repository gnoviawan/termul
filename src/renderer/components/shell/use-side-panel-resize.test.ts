import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetShellLayoutStoreForTests,
  SHELL_LAYOUT_BOUNDS,
  useShellLayoutStore
} from '@/stores/shell-layout-store'
import { useSidePanelResize } from './use-side-panel-resize'

const { min, max, default: initial } = SHELL_LAYOUT_BOUNDS.sidePanelWidth

const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {} }) as unknown as React.KeyboardEvent<HTMLButtonElement>

describe('useSidePanelResize', () => {
  beforeEach(() => {
    resetShellLayoutStoreForTests()
    useShellLayoutStore.setState({ status: 'ready' })
  })

  it('reads the width from the store', () => {
    const { result } = renderHook(() => useSidePanelResize())
    expect(result.current.width).toBe(initial)
    expect(result.current.min).toBe(min)
    expect(result.current.max).toBe(max)
  })

  it('widens on a leftward drag from the left edge, clamped to the bounds', () => {
    const { result } = renderHook(() => useSidePanelResize())
    act(() => {
      result.current.onResizeMouseDown({
        clientX: 100,
        preventDefault: () => {}
      } as React.MouseEvent<HTMLButtonElement>)
    })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 60 }))
    })
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(initial + 40)
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: -5000 }))
    })
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(max)
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'))
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 5000 }))
    })
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(max)
  })

  it('resizes with the keyboard', () => {
    const { result } = renderHook(() => useSidePanelResize())
    act(() => result.current.onResizeKeyDown(keyEvent('ArrowLeft')))
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(initial + 16)
    act(() => result.current.onResizeKeyDown(keyEvent('ArrowRight')))
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(initial)
    act(() => result.current.onResizeKeyDown(keyEvent('End')))
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(max)
    act(() => result.current.onResizeKeyDown(keyEvent('Home')))
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(min)
  })

  it('does not write before the store has hydrated', () => {
    resetShellLayoutStoreForTests()
    const { result } = renderHook(() => useSidePanelResize())
    act(() => result.current.onResizeKeyDown(keyEvent('End')))
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(initial)
  })
})
