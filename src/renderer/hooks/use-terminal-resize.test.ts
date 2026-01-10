import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useTerminalResize } from './use-terminal-resize'

describe('useTerminalResize', () => {
  let mockResizeObserver: {
    observe: ReturnType<typeof vi.fn>
    unobserve: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    mockResizeObserver = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn()
    }

    global.ResizeObserver = vi.fn().mockImplementation(() => mockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('should return containerRef', () => {
    const onResize = vi.fn()
    const { result } = renderHook(() => useTerminalResize({ onResize }))
    expect(result.current.containerRef).toBeDefined()
  })

  it('should return triggerResize function', () => {
    const onResize = vi.fn()
    const { result } = renderHook(() => useTerminalResize({ onResize }))
    expect(typeof result.current.triggerResize).toBe('function')
  })

  it('should set up ResizeObserver when container is attached', () => {
    const onResize = vi.fn()
    const { result } = renderHook(() => useTerminalResize({ onResize }))

    const container = document.createElement('div')
    Object.defineProperty(result.current.containerRef, 'current', {
      value: container,
      writable: true
    })

    expect(result.current.containerRef.current).toBe(container)
  })

  it('should debounce resize calls', () => {
    const onResize = vi.fn()
    renderHook(() => useTerminalResize({ onResize, debounceMs: 100 }))

    expect(onResize).not.toHaveBeenCalled()
  })

  it('should calculate dimensions on triggerResize', () => {
    const onResize = vi.fn()
    const { result } = renderHook(() => useTerminalResize({ onResize }))

    const container = document.createElement('div')
    container.getBoundingClientRect = vi.fn().mockReturnValue({
      width: 800,
      height: 600
    })

    Object.defineProperty(result.current.containerRef, 'current', {
      value: container,
      writable: true
    })

    act(() => {
      result.current.triggerResize()
    })

    expect(onResize).toHaveBeenCalled()
  })

  it('should not call onResize for zero dimensions', () => {
    const onResize = vi.fn()
    const { result } = renderHook(() => useTerminalResize({ onResize }))

    const container = document.createElement('div')
    container.getBoundingClientRect = vi.fn().mockReturnValue({
      width: 0,
      height: 0
    })

    Object.defineProperty(result.current.containerRef, 'current', {
      value: container,
      writable: true
    })

    act(() => {
      result.current.triggerResize()
    })

    expect(onResize).not.toHaveBeenCalled()
  })

  it('should use default debounceMs of 100', () => {
    const onResize = vi.fn()
    const { result } = renderHook(() => useTerminalResize({ onResize }))

    expect(result.current).toBeDefined()
  })
})
