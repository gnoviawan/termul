/**
 * `useDockClearance` — the mobile toast stack follows the measured dock.
 *
 * Mock strategy (restored in `afterEach`, the `use-osk-viewport.test.ts`
 * lesson): a capturing `ResizeObserver`, rects stubbed per element through the
 * `data-testid` the host renders, `window.innerHeight` and `visualViewport`
 * stubs, and a manual `requestAnimationFrame` queue so the rAF coalescing is
 * assertable. The module keeps a registry between tests; every test unmounts
 * its hosts, which empties it.
 */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCK_CLEARANCE_VAR, useDockClearance } from './use-dock-clearance'

const { logFrontendError } = vi.hoisted(() => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/log-api', () => ({ logFrontendError }))

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  targets = new Set<Element>()
  constructor(private readonly callback: () => void) {
    MockResizeObserver.instances.push(this)
  }
  observe(target: Element): void {
    this.targets.add(target)
  }
  unobserve(target: Element): void {
    this.targets.delete(target)
  }
  disconnect(): void {
    this.targets.clear()
  }
  fire(): void {
    this.callback()
  }
}

/** Every observed element across all observers. */
function observedTargets(): Element[] {
  return MockResizeObserver.instances.flatMap((observer) => [...observer.targets])
}

/** Deliver a resize notification the way the browser does: to each observer with targets. */
function notifyResize(): void {
  act(() => {
    for (const observer of MockResizeObserver.instances) {
      if (observer.targets.size > 0) observer.fire()
    }
  })
}

interface StubRect {
  top: number
  width?: number
  height?: number
}
const rects = new Map<string, StubRect>()

function setRect(testId: string, rect: StubRect): void {
  rects.set(testId, rect)
}

function rectOf(element: Element): DOMRect {
  const stub = rects.get(element.getAttribute('data-testid') ?? '')
  const top = stub?.top ?? 0
  const width = stub ? (stub.width ?? 390) : 0
  const height = stub ? (stub.height ?? 100) : 0
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    width,
    height,
    right: width,
    bottom: top + height,
    toJSON: () => ({})
  }
}

let frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1

function flushFrames(): void {
  act(() => {
    const pending = [...frames.values()]
    frames = new Map()
    for (const callback of pending) callback(0)
  })
}

interface ViewportStub {
  fire: (type: 'resize' | 'scroll') => void
  listenerCount: () => number
}

function installVisualViewport(): ViewportStub {
  const listeners = { resize: new Set<() => void>(), scroll: new Set<() => void>() }
  const stub = {
    addEventListener: (type: 'resize' | 'scroll', callback: () => void) => {
      listeners[type].add(callback)
    },
    removeEventListener: (type: 'resize' | 'scroll', callback: () => void) => {
      listeners[type].delete(callback)
    }
  }
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: stub
  })
  return {
    fire: (type) => {
      for (const callback of [...listeners[type]]) callback()
    },
    listenerCount: () => listeners.resize.size + listeners.scroll.size
  }
}

const originalInnerHeight = window.innerHeight

function setInnerHeight(value: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value })
}

const dockVar = (): string => document.documentElement.style.getPropertyValue(DOCK_CLEARANCE_VAR)

function Host({
  id,
  enabled = true,
  onRender
}: {
  id: string
  enabled?: boolean
  onRender?: () => void
}): React.JSX.Element {
  const ref = useDockClearance(enabled)
  onRender?.()
  return <div ref={ref} data-testid={id} />
}

beforeEach(() => {
  MockResizeObserver.instances = []
  rects.clear()
  frames = new Map()
  nextFrameId = 1
  logFrontendError.mockReset()
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this)
  })
  setInnerHeight(844)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  try {
    delete (window as unknown as { visualViewport?: unknown }).visualViewport
  } catch {
    /* already absent */
  }
  setInnerHeight(originalInnerHeight)
  document.documentElement.style.removeProperty(DOCK_CLEARANCE_VAR)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDockClearance', () => {
  it('writes the distance from the viewport bottom to the dock top (one-row composer)', () => {
    setRect('dock', { top: 708, height: 136 })
    render(<Host id="dock" />)

    // 844 - 708: the dock's own `pb-6` and every inset below it are included.
    expect(dockVar()).toBe('136px')
  })

  it('follows the dock as it grows, in the same frame as its resize notification', () => {
    setRect('dock', { top: 708, height: 136 })
    render(<Host id="dock" />)
    expect(dockVar()).toBe('136px')

    // An approval, a changed-files bar, a queued prompt or an attachment pushes the top up.
    setRect('dock', { top: 600, height: 244 })
    notifyResize()
    expect(dockVar()).toBe('244px')

    setRect('dock', { top: 708, height: 136 })
    notifyResize()
    expect(dockVar()).toBe('136px')
  })

  it('lets the highest registered top win and drops back when it leaves', () => {
    function Pair({ showDock }: { showDock: boolean }): React.JSX.Element {
      return (
        <>
          {showDock ? <Host id="dock" /> : null}
          <Host id="bar" />
        </>
      )
    }
    setRect('dock', { top: 600, height: 244 })
    setRect('bar', { top: 740, height: 104 })
    const { rerender } = render(<Pair showDock />)
    expect(dockVar()).toBe('244px')

    rerender(<Pair showDock={false} />)
    expect(dockVar()).toBe('104px')
  })

  it('re-measures when the keyboard moves the dock without resizing it', () => {
    setRect('dock', { top: 708, height: 136 })
    const { getByTestId } = render(<Host id="dock" />)
    const dock = getByTestId('dock')
    expect(dockVar()).toBe('136px')

    // The root padding grows by the keyboard height: the dock keeps its size,
    // so only its parent's content box changes. Both are observed.
    expect(observedTargets()).toEqual(expect.arrayContaining([dock, dock.parentElement]))
    setRect('dock', { top: 408, height: 136 })
    notifyResize()
    expect(dockVar()).toBe('436px')
  })

  it('re-measures on window and visualViewport events, one measurement per frame', () => {
    const viewport = installVisualViewport()
    setRect('dock', { top: 708, height: 136 })
    render(<Host id="dock" />)
    expect(dockVar()).toBe('136px')

    setRect('dock', { top: 408, height: 136 })
    viewport.fire('resize')
    viewport.fire('scroll')
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    // Nothing is measured until the frame: three events share one callback.
    expect(dockVar()).toBe('136px')
    expect(frames.size).toBe(1)
    flushFrames()
    expect(dockVar()).toBe('436px')

    // A rotation changes the viewport, not the dock's rect: the variable follows it.
    setInnerHeight(390)
    setRect('dock', { top: 254, height: 136 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    flushFrames()
    expect(dockVar()).toBe('136px')
  })

  it('clamps to the viewport and rounds a fractional top up', () => {
    setRect('dock', { top: 707.2, height: 136.8 })
    render(<Host id="dock" />)
    expect(dockVar()).toBe('137px')

    setRect('dock', { top: -40, height: 884 })
    notifyResize()
    expect(dockVar()).toBe('844px')

    setRect('dock', { top: 900, height: 10 })
    notifyResize()
    expect(dockVar()).toBe('0px')
  })

  it('writes nothing while the value is unchanged', () => {
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty')
    setRect('dock', { top: 708, height: 136 })
    render(<Host id="dock" />)
    expect(setProperty).toHaveBeenCalledTimes(1)

    notifyResize()
    notifyResize()
    expect(setProperty).toHaveBeenCalledTimes(1)

    setRect('dock', { top: 700, height: 144 })
    notifyResize()
    expect(setProperty).toHaveBeenCalledTimes(2)
    expect(setProperty).toHaveBeenLastCalledWith(DOCK_CLEARANCE_VAR, '144px')
  })

  it('leaves the property absent with nothing to measure', () => {
    // Hidden chat or desktop shell: `enabled` is false.
    setRect('dock', { top: 708, height: 136 })
    const { rerender } = render(<Host id="dock" enabled={false} />)
    expect(dockVar()).toBe('')
    expect(MockResizeObserver.instances).toHaveLength(0)

    // Enabled: written. Disabled again: removed, observer and listeners released.
    const viewport = installVisualViewport()
    rerender(<Host id="dock" enabled />)
    expect(dockVar()).toBe('136px')
    expect(viewport.listenerCount()).toBe(2)
    rerender(<Host id="dock" enabled={false} />)
    expect(dockVar()).toBe('')
    expect(viewport.listenerCount()).toBe(0)
    expect(observedTargets()).toEqual([])
  })

  it('ignores a zero-size (display: none) element', () => {
    setRect('dock', { top: 0, width: 0, height: 0 })
    render(<Host id="dock" />)
    expect(dockVar()).toBe('')

    setRect('dock', { top: 708, height: 136 })
    notifyResize()
    expect(dockVar()).toBe('136px')

    setRect('dock', { top: 0, width: 0, height: 0 })
    notifyResize()
    expect(dockVar()).toBe('')
  })

  it('registers an element that mounts after the first render (behind an early return)', () => {
    function Gated({ ready }: { ready: boolean }): React.JSX.Element | null {
      const ref = useDockClearance(true)
      if (!ready) return null
      return <div ref={ref} data-testid="dock" />
    }
    setRect('dock', { top: 708, height: 136 })
    const { rerender } = render(<Gated ready={false} />)
    expect(dockVar()).toBe('')

    rerender(<Gated ready />)
    expect(dockVar()).toBe('136px')
  })

  it('removes the property and releases every listener when the last registrant unmounts', () => {
    const viewport = installVisualViewport()
    const removeListener = vi.spyOn(window, 'removeEventListener')
    function Pair({ showDock }: { showDock: boolean }): React.JSX.Element {
      return (
        <>
          {showDock ? <Host id="dock" /> : null}
          <Host id="bar" />
        </>
      )
    }
    setRect('dock', { top: 600, height: 244 })
    setRect('bar', { top: 740, height: 104 })
    const { rerender, unmount } = render(<Pair showDock />)
    expect(dockVar()).toBe('244px')
    expect(viewport.listenerCount()).toBe(2)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(frames.size).toBe(1)

    // One registrant leaves: the other keeps the listeners.
    rerender(<Pair showDock={false} />)
    expect(viewport.listenerCount()).toBe(2)
    expect(observedTargets()).toHaveLength(2)

    unmount()
    expect(dockVar()).toBe('')
    expect(viewport.listenerCount()).toBe(0)
    expect(observedTargets()).toEqual([])
    expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function))
    // The pending frame was cancelled with the listeners.
    expect(frames.size).toBe(0)
  })

  it('adds no render to the component that uses it', () => {
    setRect('dock', { top: 708, height: 136 })
    const onRender = vi.fn()
    render(<Host id="dock" onRender={onRender} />)

    expect(onRender).toHaveBeenCalledTimes(1)
    notifyResize()
    expect(onRender).toHaveBeenCalledTimes(1)
  })

  describe('without ResizeObserver', () => {
    beforeEach(() => {
      vi.stubGlobal('ResizeObserver', undefined)
      vi.resetModules()
    })

    it('still follows window and visualViewport resizes, and warns once', async () => {
      const fresh = await import('./use-dock-clearance')
      const viewport = installVisualViewport()
      function FreshHost({ id }: { id: string }): React.JSX.Element {
        const ref = fresh.useDockClearance(true)
        return <div ref={ref} data-testid={id} />
      }
      setRect('dock', { top: 708, height: 136 })
      const first = render(<FreshHost id="dock" />)
      expect(dockVar()).toBe('136px')

      setRect('dock', { top: 608, height: 236 })
      viewport.fire('resize')
      flushFrames()
      expect(dockVar()).toBe('236px')

      setRect('dock', { top: 508, height: 336 })
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      flushFrames()
      expect(dockVar()).toBe('336px')

      expect(logFrontendError).toHaveBeenCalledTimes(1)
      const [payload] = logFrontendError.mock.calls[0] as [Record<string, unknown>]
      expect(payload).toMatchObject({ level: 'warn', source: 'dock-clearance' })
      expect(JSON.stringify(payload)).not.toContain('data-testid')

      // A second registration after a full release stays silent.
      first.unmount()
      expect(dockVar()).toBe('')
      render(<FreshHost id="dock" />)
      expect(logFrontendError).toHaveBeenCalledTimes(1)
    })
  })
})
