import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { framerMotionTestState, resetFramerMotionTestState } from '@/test-utils/mock-framer-motion'
import { useSmoothWheelScroll } from './use-smooth-wheel-scroll'

/**
 * Thin React shell over `installSmoothWheelScroll` (engine coverage lives in
 * `lib/smooth-wheel.test.ts`). These tests lock the hook-level contract:
 * document listener mounted on render, `prefers-reduced-motion` gate,
 * unmount cleanup, and coverage of portaled surfaces (their wheel events
 * bubble to `document` no matter where they mount).
 */

vi.mock('framer-motion', async (importOriginal) => {
  const { installFramerMotionMock } = await import('@/test-utils/mock-framer-motion')
  return installFramerMotionMock(importOriginal)
})

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(() => Promise.resolve())
}))

const FRAME_MS = 16
let rafQueue: Map<number, FrameRequestCallback>
let rafSeq: number
let nowValue: number

function flushFrames(rounds = 1, dt = FRAME_MS): void {
  for (let i = 0; i < rounds; i++) {
    const callbacks = [...rafQueue.values()]
    rafQueue.clear()
    if (callbacks.length === 0) return
    nowValue += dt
    for (const cb of callbacks) cb(nowValue)
  }
}

/** Give a rendered element jsdom-missing layout metrics + stored scrollTop. */
function makeScrollable(
  el: HTMLElement,
  { clientHeight = 200, scrollHeight = 1000, scrollTop = 0 } = {}
): void {
  el.style.overflowY = 'auto'
  let top = scrollTop
  Object.defineProperties(el, {
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v
      }
    }
  })
}

function dispatchWheel(target: Element, init: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function Harness(): React.JSX.Element {
  useSmoothWheelScroll()
  return (
    <div data-testid="scroller">
      <div data-testid="child" />
    </div>
  )
}

describe('useSmoothWheelScroll', () => {
  beforeEach(() => {
    resetFramerMotionTestState()
    rafQueue = new Map()
    rafSeq = 0
    nowValue = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafSeq += 1
      rafQueue.set(rafSeq, cb)
      return rafSeq
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafQueue.delete(id)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => nowValue)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('installs the interceptor: wheel on a scrollable region eases scrollTop', () => {
    const { getByTestId } = render(<Harness />)
    const scroller = getByTestId('scroller')
    const child = getByTestId('child')
    makeScrollable(scroller)

    let event!: WheelEvent
    act(() => {
      event = dispatchWheel(child, { deltaY: 100 })
    })
    expect(event.defaultPrevented).toBe(true)

    act(() => flushFrames(60))
    expect(scroller.scrollTop).toBe(100)
  })

  it('covers scroll surfaces mounted outside the hook root (portaled dialogs)', () => {
    render(<Harness />)
    // Radix portals render directly under document.body — a separate subtree
    // from the harness — but their wheel events bubble to `document`.
    const portalScroller = document.createElement('div')
    makeScrollable(portalScroller)
    const portalChild = document.createElement('div')
    portalScroller.appendChild(portalChild)
    document.body.appendChild(portalScroller)

    const event = dispatchWheel(portalChild, { deltaY: 100 })
    expect(event.defaultPrevented).toBe(true)
    flushFrames(60)
    expect(portalScroller.scrollTop).toBe(100)
  })

  it('is inert under prefers-reduced-motion — scroll stays fully native', () => {
    framerMotionTestState.reducedMotion.current = true
    const { getByTestId } = render(<Harness />)
    const scroller = getByTestId('scroller')
    const child = getByTestId('child')
    makeScrollable(scroller)

    const event = dispatchWheel(child, { deltaY: 100 })
    expect(event.defaultPrevented).toBe(false)
    expect(rafQueue.size).toBe(0)
    expect(scroller.scrollTop).toBe(0)
  })

  it('detaches when reduced motion turns on and reattaches when it turns off', () => {
    const { getByTestId, rerender } = render(<Harness />)
    const scroller = getByTestId('scroller')
    const child = getByTestId('child')
    makeScrollable(scroller)

    expect(dispatchWheel(child, { deltaY: 100 }).defaultPrevented).toBe(true)
    flushFrames(60)
    scroller.scrollTop = 0

    framerMotionTestState.reducedMotion.current = true
    rerender(<Harness />)
    expect(dispatchWheel(child, { deltaY: 100 }).defaultPrevented).toBe(false)
    expect(rafQueue.size).toBe(0)

    framerMotionTestState.reducedMotion.current = false
    rerender(<Harness />)
    expect(dispatchWheel(child, { deltaY: 100 }).defaultPrevented).toBe(true)
  })

  it('removes the wheel listener on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(<Harness />)
    // Fixture lives outside the React tree — it stays attached to
    // document.body after unmount, so this dispatch genuinely exercises the
    // listener's presence (unlike a node React already detached).
    const scroller = document.createElement('div')
    makeScrollable(scroller)
    const child = document.createElement('div')
    scroller.appendChild(child)
    document.body.appendChild(scroller)

    unmount()

    expect(removeSpy).toHaveBeenCalledWith('wheel', expect.any(Function))
    const event = dispatchWheel(child, { deltaY: 100 })
    expect(event.defaultPrevented).toBe(false)
  })
})
