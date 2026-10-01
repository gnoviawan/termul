import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import { installSmoothWheelScroll } from './smooth-wheel'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(() => Promise.resolve())
}))

/**
 * jsdom gives us real event dispatch, WheelEvent init dicts, stored
 * `scrollTop`, and computed `overflow-y` from inline styles — but not
 * layout. Scrollable fixtures therefore define `clientHeight`/`scrollHeight`
 * (`scrollTop` is redefined too, so tests control the backing store), and
 * rAF is stubbed the same way `use-pane-split-animation.test.ts` does:
 * captured callbacks flushed manually with controlled timestamps.
 */

const FRAME_MS = 16
/** Matches MIN_NOTCH_DELTA_PX in smooth-wheel.ts (normalized px per notch). */
const NOTCH_DELTA = 100

let rafQueue: Map<number, FrameRequestCallback>
let rafSeq: number
let nowValue: number
let cleanups: Array<() => void>

function install(): void {
  cleanups.push(installSmoothWheelScroll(document))
}

/** Flush pending rAF callbacks, advancing the clock `dt` per flush round. */
function flushFrames(rounds = 1, dt = FRAME_MS): void {
  for (let i = 0; i < rounds; i++) {
    const callbacks = [...rafQueue.values()]
    rafQueue.clear()
    if (callbacks.length === 0) return
    nowValue += dt
    for (const cb of callbacks) cb(nowValue)
  }
}

interface ScrollMetrics {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  clientWidth: number
  scrollWidth: number
  scrollLeft: number
}

interface ScrollableOptions extends Partial<ScrollMetrics> {
  overflowY?: string
  overflowX?: string
  scrollBehavior?: string
}

/** Fixture metrics live in a WeakMap so tests can mutate them mid-flight. */
const metricsByEl = new WeakMap<HTMLElement, ScrollMetrics>()

function setScrollMetrics(el: HTMLElement, patch: Partial<ScrollMetrics>): void {
  const metrics = metricsByEl.get(el)
  if (metrics) Object.assign(metrics, patch)
}

function makeScrollable({
  clientHeight = 200,
  scrollHeight = 1000,
  scrollTop = 0,
  clientWidth = 200,
  scrollWidth = 200,
  scrollLeft = 0,
  overflowY = 'auto',
  overflowX,
  scrollBehavior
}: ScrollableOptions = {}): HTMLDivElement {
  const el = document.createElement('div')
  el.style.overflowY = overflowY
  if (overflowX !== undefined) el.style.overflowX = overflowX
  if (scrollBehavior !== undefined) el.style.scrollBehavior = scrollBehavior
  const metrics: ScrollMetrics = {
    clientHeight,
    scrollHeight,
    scrollTop,
    clientWidth,
    scrollWidth,
    scrollLeft
  }
  metricsByEl.set(el, metrics)
  Object.defineProperties(el, {
    clientHeight: { configurable: true, get: () => metrics.clientHeight },
    scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => metrics.scrollTop,
      set: (v: number) => {
        metrics.scrollTop = v
      }
    },
    clientWidth: { configurable: true, get: () => metrics.clientWidth },
    scrollWidth: { configurable: true, get: () => metrics.scrollWidth },
    scrollLeft: {
      configurable: true,
      get: () => metrics.scrollLeft,
      set: (v: number) => {
        metrics.scrollLeft = v
      }
    }
  })
  return el
}

/** scroller > child, appended to document.body — mirrors app markup. */
function mountScrollable(options: ScrollableOptions = {}): {
  scroller: HTMLDivElement
  child: HTMLDivElement
} {
  const scroller = makeScrollable(options)
  const child = document.createElement('div')
  scroller.appendChild(child)
  document.body.appendChild(scroller)
  return { scroller, child }
}

function dispatchWheel(target: Element, init: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('installSmoothWheelScroll', () => {
  beforeEach(() => {
    rafQueue = new Map()
    rafSeq = 0
    nowValue = 1000
    cleanups = []
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
    for (const cleanup of cleanups.splice(0)) cleanup()
    document.body.innerHTML = ''
    // innerHTML does not clear body attributes — drop scroll-lock state.
    document.body.removeAttribute('data-scroll-locked')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.mocked(logFrontendError).mockClear()
  })

  it('preventDefaults a discrete wheel step and eases scrollTop to the target', () => {
    install()
    const { scroller, child } = mountScrollable()

    const event = dispatchWheel(child, { deltaY: NOTCH_DELTA })
    expect(event.defaultPrevented).toBe(true)
    // Nothing is applied synchronously — the ease runs on rAF.
    expect(scroller.scrollTop).toBe(0)

    flushFrames(1)
    expect(scroller.scrollTop).toBeGreaterThan(0)
    expect(scroller.scrollTop).toBeLessThan(NOTCH_DELTA)

    flushFrames(60)
    expect(scroller.scrollTop).toBe(NOTCH_DELTA)
    expect(rafQueue.size).toBe(0)
  })

  it('accumulates repeated notches into a single eased target', () => {
    install()
    const { scroller, child } = mountScrollable()

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    dispatchWheel(child, { deltaY: NOTCH_DELTA })

    flushFrames(60)
    expect(scroller.scrollTop).toBe(NOTCH_DELTA * 2)
  })

  it('clamps the eased target to the scroll range', () => {
    install()
    const { scroller, child } = mountScrollable({ scrollTop: 750 })

    dispatchWheel(child, { deltaY: NOTCH_DELTA * 2 })
    flushFrames(60)
    expect(scroller.scrollTop).toBe(800) // scrollHeight - clientHeight
  })

  it('smooths upward wheel deltas symmetrically', () => {
    install()
    const { scroller, child } = mountScrollable({ scrollTop: 400 })

    const event = dispatchWheel(child, { deltaY: -NOTCH_DELTA })
    expect(event.defaultPrevented).toBe(true)
    flushFrames(60)
    expect(scroller.scrollTop).toBe(300)
  })

  it.each([
    ['.xterm', (el: HTMLElement) => el.classList.add('xterm')],
    ['.cm-scroller', (el: HTMLElement) => el.classList.add('cm-scroller')],
    [
      '[data-virtuoso-scroller]',
      (el: HTMLElement) => el.setAttribute('data-virtuoso-scroller', 'true')
    ],
    [
      '[data-smooth-scroll="off"]',
      (el: HTMLElement) => el.setAttribute('data-smooth-scroll', 'off')
    ]
  ])('leaves wheel events inside %s untouched', (_label, markExcluded) => {
    install()
    const excluded = document.createElement('div')
    markExcluded(excluded)
    const scroller = makeScrollable()
    const child = document.createElement('div')
    scroller.appendChild(child)
    excluded.appendChild(scroller)
    document.body.appendChild(excluded)

    const event = dispatchWheel(child, { deltaY: NOTCH_DELTA })
    expect(event.defaultPrevented).toBe(false)
    flushFrames(60)
    expect(scroller.scrollTop).toBe(0)
  })

  it('bails when an element-level handler already preventDefaulted (tab-bar pattern)', () => {
    install()
    const { scroller, child } = mountScrollable()
    // WorkspaceTabBar/TerminalTabBar consume wheel to scroll horizontally.
    child.addEventListener('wheel', (e) => e.preventDefault())

    const event = dispatchWheel(child, { deltaY: NOTCH_DELTA })
    expect(event.defaultPrevented).toBe(true)
    expect(rafQueue.size).toBe(0)
    flushFrames(10)
    expect(scroller.scrollTop).toBe(0)
  })

  it('never sees events a stopPropagation consumer swallows (Mermaid zoom pattern)', () => {
    install()
    const { scroller, child } = mountScrollable()
    let consumed = false
    child.addEventListener('wheel', (e) => {
      consumed = true
      e.preventDefault()
      e.stopPropagation()
    })

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    expect(consumed).toBe(true)
    expect(rafQueue.size).toBe(0)
    expect(scroller.scrollTop).toBe(0)
    // Sanity: a sibling scrollable without the consumer IS intercepted.
    const { child: freeChild } = mountScrollable()
    const free = dispatchWheel(freeChild, { deltaY: NOTCH_DELTA })
    expect(free.defaultPrevented).toBe(true)
  })

  it('does not preventDefault at the scroll edge so native scroll-chaining proceeds', () => {
    install()
    const { scroller, child } = mountScrollable({ scrollTop: 0 })

    const atTop = dispatchWheel(child, { deltaY: -NOTCH_DELTA })
    expect(atTop.defaultPrevented).toBe(false)

    scroller.scrollTop = 800 // scrollHeight - clientHeight
    const atBottom = dispatchWheel(child, { deltaY: NOTCH_DELTA })
    expect(atBottom.defaultPrevented).toBe(false)
    expect(rafQueue.size).toBe(0)
  })

  it('passes through modifier-chorded wheels (ctrl/shift/alt/meta)', () => {
    install()
    const { scroller, child } = mountScrollable()

    // ctrlKey: pinch-zoom. shiftKey: horizontal scroll. altKey/metaKey:
    // app/OS gesture chords — all must stay native.
    for (const init of [
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { metaKey: true }
    ]) {
      expect(dispatchWheel(child, { deltaY: NOTCH_DELTA, ...init }).defaultPrevented).toBe(false)
    }
    expect(scroller.scrollTop).toBe(0)
  })

  it('passes through horizontal-dominant deltas', () => {
    install()
    const { child } = mountScrollable()

    expect(dispatchWheel(child, { deltaX: 100, deltaY: 50 }).defaultPrevented).toBe(false)
    expect(dispatchWheel(child, { deltaX: 100, deltaY: 0 }).defaultPrevented).toBe(false)
    expect(dispatchWheel(child, { deltaX: 0, deltaY: 0 }).defaultPrevented).toBe(false)
  })

  it('passes through fractional and sub-threshold trackpad deltas', () => {
    install()
    const { scroller, child } = mountScrollable()

    // Precision touchpads / free-spin wheels emit high-frequency streams of
    // fractional or small deltas that already carry native inertia.
    expect(dispatchWheel(child, { deltaY: 12.5 }).defaultPrevented).toBe(false)
    expect(dispatchWheel(child, { deltaY: 20 }).defaultPrevented).toBe(false)
    expect(dispatchWheel(child, { deltaY: 100, deltaX: 0.5 }).defaultPrevented).toBe(false)
    expect(rafQueue.size).toBe(0)
    expect(scroller.scrollTop).toBe(0)
  })

  it('normalizes deltaMode lines to pixels before accumulating', () => {
    install()
    const { scroller, child } = mountScrollable()

    const event = dispatchWheel(child, { deltaY: 3, deltaMode: 1 })
    expect(event.defaultPrevented).toBe(true)
    flushFrames(80)
    // 3 lines * 17px — matches native's ~48-57px for a 3-line notch.
    expect(scroller.scrollTop).toBe(51)
  })

  it('does not apply the sub-notch floor to line/page deltas (inherently discrete)', () => {
    install()
    const { scroller, child } = mountScrollable()

    // A 1-line delta normalizes to 17px — below the pixel-mode floor — but
    // line-mode deltas only come from discrete notches, so they must still
    // be smoothed rather than left as native steps.
    const event = dispatchWheel(child, { deltaY: 1, deltaMode: 1 })
    expect(event.defaultPrevented).toBe(true)
    flushFrames(80)
    expect(scroller.scrollTop).toBe(17)
  })

  it('normalizes deltaMode pages against the resolved scroller viewport', () => {
    install()
    const { scroller, child } = mountScrollable({ clientHeight: 200 })

    const event = dispatchWheel(child, { deltaY: 1, deltaMode: 2 })
    expect(event.defaultPrevented).toBe(true)
    flushFrames(80)
    expect(scroller.scrollTop).toBe(200) // 1 page * clientHeight
  })

  it('resolves the nearest vertically-scrollable ancestor, skipping non-scrollables', () => {
    install()
    const outer = makeScrollable({ clientHeight: 400, scrollHeight: 2000 })
    // overflow-hidden wrapper: large scrollHeight but must never match.
    const hiddenShell = makeScrollable({
      clientHeight: 400,
      scrollHeight: 2000,
      overflowY: 'hidden'
    })
    const inner = makeScrollable({ clientHeight: 100, scrollHeight: 500 })
    const child = document.createElement('div')
    inner.appendChild(child)
    hiddenShell.appendChild(inner)
    outer.appendChild(hiddenShell)
    document.body.appendChild(outer)

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    flushFrames(60)
    expect(inner.scrollTop).toBe(100)
    expect(outer.scrollTop).toBe(0)

    // When the inner scroller is absent, the hidden shell is skipped and
    // the outer scroller gets the smoothed event.
    inner.remove()
    dispatchWheel(hiddenShell, { deltaY: NOTCH_DELTA })
    flushFrames(60)
    expect(outer.scrollTop).toBe(100)
  })

  it('does nothing when no scrollable ancestor exists', () => {
    install()
    const plain = document.createElement('div')
    const child = document.createElement('div')
    plain.appendChild(child)
    document.body.appendChild(plain)

    const event = dispatchWheel(child, { deltaY: NOTCH_DELTA })
    expect(event.defaultPrevented).toBe(false)
    expect(rafQueue.size).toBe(0)
  })

  it('resyncs the target when an external writer moves scrollTop mid-animation', () => {
    install()
    const { scroller, child } = mountScrollable()

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    flushFrames(2)
    const midFlight = scroller.scrollTop
    expect(midFlight).toBeGreaterThan(0)
    expect(midFlight).toBeLessThan(NOTCH_DELTA)

    // External writer (RO follow, prepend-restore, scrollToEnd) takes over.
    scroller.scrollTop = 500
    flushFrames(10)
    // The animation must NOT drag the position back toward the stale
    // target — it settles at the real position and stops.
    expect(scroller.scrollTop).toBe(500)
    expect(rafQueue.size).toBe(0)
  })

  it('anchors new wheel deltas at the real position after external writes', () => {
    install()
    const { scroller, child } = mountScrollable()

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    flushFrames(2)
    scroller.scrollTop = 500 // virtualizer prepend-restore

    const event = dispatchWheel(child, { deltaY: 50 })
    expect(event.defaultPrevented).toBe(true)
    flushFrames(60)
    expect(scroller.scrollTop).toBe(550)
  })

  it('drops the animation when the scroller detaches mid-flight', () => {
    install()
    const { scroller, child } = mountScrollable()

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    flushFrames(1)
    scroller.remove()
    flushFrames(10)
    expect(rafQueue.size).toBe(0)
    expect(vi.mocked(logFrontendError)).not.toHaveBeenCalled()
  })

  it('logs and disables the interceptor when a frame write throws', () => {
    install()
    const scroller = makeScrollable()
    const child = document.createElement('div')
    scroller.appendChild(child)
    document.body.appendChild(scroller)
    // A scrollTop setter that explodes mid-frame — the interceptor must
    // disable itself rather than wedge scrolling.
    const top = 0
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: () => {
        throw new Error('scrollTop exploded')
      }
    })

    expect(dispatchWheel(child, { deltaY: NOTCH_DELTA }).defaultPrevented).toBe(true)
    flushFrames(1)
    expect(vi.mocked(logFrontendError)).toHaveBeenCalled()

    // Disabled: subsequent wheels are untouched (native stepping resumes).
    expect(dispatchWheel(child, { deltaY: NOTCH_DELTA }).defaultPrevented).toBe(false)
  })

  it('shares one interceptor across concurrent installs (refcounted)', () => {
    const detachA = installSmoothWheelScroll(document)
    const detachB = installSmoothWheelScroll(document)
    cleanups.push(detachA, detachB)
    const { scroller, child } = mountScrollable()

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    flushFrames(60)
    // Handled exactly once — two engines would have summed to 200px.
    expect(scroller.scrollTop).toBe(NOTCH_DELTA)

    detachA()
    scroller.scrollTop = 0
    const stillActive = dispatchWheel(child, { deltaY: NOTCH_DELTA })
    expect(stillActive.defaultPrevented).toBe(true)
    flushFrames(60)
    scroller.scrollTop = 0

    detachB()
    const inactive = dispatchWheel(child, { deltaY: NOTCH_DELTA })
    expect(inactive.defaultPrevented).toBe(false)
  })

  it('stops listening and cancels pending frames on dispose', () => {
    install()
    const { scroller, child } = mountScrollable()

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    flushFrames(1)
    const pending = rafQueue.size
    expect(pending).toBe(1)

    for (const cleanup of cleanups.splice(0)) cleanup()
    expect(rafQueue.size).toBe(0)

    const event = dispatchWheel(child, { deltaY: NOTCH_DELTA })
    expect(event.defaultPrevented).toBe(false)
    const settled = scroller.scrollTop
    flushFrames(10)
    expect(scroller.scrollTop).toBe(settled)
  })

  it('passes through non-cancelable wheel events', () => {
    install()
    const { scroller, child } = mountScrollable()

    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: false,
      deltaY: NOTCH_DELTA
    })
    child.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(rafQueue.size).toBe(0)
    expect(scroller.scrollTop).toBe(0)
  })

  it('leaves wheel events on native form controls to the control', () => {
    install()
    const { scroller } = mountScrollable()

    // <select> cycles options on wheel; input[type=number] steps — the
    // control owns the gesture, not the scroll ancestor.
    const select = document.createElement('select')
    const option = document.createElement('option')
    select.appendChild(option)
    const number = document.createElement('input')
    number.type = 'number'
    scroller.appendChild(select)
    scroller.appendChild(number)

    expect(dispatchWheel(option, { deltaY: NOTCH_DELTA }).defaultPrevented).toBe(false)
    expect(dispatchWheel(select, { deltaY: NOTCH_DELTA }).defaultPrevented).toBe(false)
    expect(dispatchWheel(number, { deltaY: NOTCH_DELTA }).defaultPrevented).toBe(false)
    expect(rafQueue.size).toBe(0)
    expect(scroller.scrollTop).toBe(0)
  })

  it('smooths only inside the locked layer while body carries data-scroll-locked', () => {
    install()
    // react-remove-scroll marks the lock on body — its document listener is
    // bubble-phase and registered after ours, so outside-lock wheels fall
    // through to ITS preventDefault; we must not animate the background.
    document.body.setAttribute('data-scroll-locked', '1')

    const { scroller, child } = mountScrollable()
    expect(dispatchWheel(child, { deltaY: NOTCH_DELTA }).defaultPrevented).toBe(false)
    flushFrames(10)
    expect(scroller.scrollTop).toBe(0)

    // Inside the locked layer (Radix role markers / vaul drawer) the wheel
    // is allowed — and still gets the inertial glide.
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const dialogScroller = makeScrollable()
    const dialogChild = document.createElement('div')
    dialogScroller.appendChild(dialogChild)
    dialog.appendChild(dialogScroller)
    document.body.appendChild(dialog)

    expect(dispatchWheel(dialogChild, { deltaY: NOTCH_DELTA }).defaultPrevented).toBe(true)
    flushFrames(60)
    expect(dialogScroller.scrollTop).toBe(NOTCH_DELTA)
  })

  it('passes wheel through to natively smooth areas (scroll-behavior: smooth)', () => {
    install()
    const { scroller, child } = mountScrollable({ scrollBehavior: 'smooth' })

    const event = dispatchWheel(child, { deltaY: NOTCH_DELTA })
    // The browser already eases scrollTop for this element — consuming the
    // event would double-smooth and thrash the resync guard.
    expect(event.defaultPrevented).toBe(false)
    expect(rafQueue.size).toBe(0)
    expect(scroller.scrollTop).toBe(0)
  })

  it('applies a non-dominant deltaX natively when the scroller can scroll horizontally', () => {
    install()
    const { scroller, child } = mountScrollable({
      clientWidth: 200,
      scrollWidth: 2000,
      scrollLeft: 0,
      overflowX: 'auto'
    })

    const event = dispatchWheel(child, { deltaY: NOTCH_DELTA, deltaX: 40 })
    expect(event.defaultPrevented).toBe(true)
    // Horizontal travel lands synchronously — the event was consumed.
    expect(scroller.scrollLeft).toBe(40)
    flushFrames(60)
    expect(scroller.scrollTop).toBe(NOTCH_DELTA)
  })

  it('does not apply deltaX when the scroller cannot scroll horizontally', () => {
    install()
    const { scroller, child } = mountScrollable({
      scrollWidth: 2000,
      overflowX: 'hidden'
    })

    dispatchWheel(child, { deltaY: NOTCH_DELTA, deltaX: 40 })
    expect(scroller.scrollLeft).toBe(0)
    flushFrames(60)
    expect(scroller.scrollTop).toBe(NOTCH_DELTA)
  })

  it('normalizes deltaMode PAGE on deltaX against clientWidth for the dominance check', () => {
    install()
    const { child } = mountScrollable({ clientWidth: 1000, clientHeight: 100 })

    // Raw deltas look vertical-dominant (1 < 5) but page-normalized
    // 1*1000px horizontal > 5*100px vertical — the event must pass through.
    const event = dispatchWheel(child, { deltaX: 1, deltaY: 5, deltaMode: 2 })
    expect(event.defaultPrevented).toBe(false)
    expect(rafQueue.size).toBe(0)
  })

  it('requeues a frame without writing when rAF timestamps do not advance (dt <= 0)', () => {
    install()
    const { scroller, child } = mountScrollable()

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    // Same timestamp as the seed → dt = 0 → requeue, no write, no settle.
    flushFrames(3, 0)
    expect(scroller.scrollTop).toBe(0)
    expect(rafQueue.size).toBe(1)

    // A real dt resumes the ease.
    flushFrames(60)
    expect(scroller.scrollTop).toBe(NOTCH_DELTA)
  })

  it('re-clamps the target when the scroll range shrinks mid-animation', () => {
    install()
    const { scroller, child } = mountScrollable()

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    flushFrames(2)
    expect(scroller.scrollTop).toBeGreaterThan(0)

    // Content trims: scrollHeight drops so maxScrollTop (10) lands below
    // BOTH the in-flight position and the accumulated target — the target
    // must re-clamp and the loop must still terminate.
    setScrollMetrics(scroller, { scrollHeight: 210 })
    flushFrames(60)
    expect(scroller.scrollTop).toBe(10)
    expect(rafQueue.size).toBe(0)
  })

  it('stops the loop when a scrollTop write makes zero progress', () => {
    install()
    const scroller = makeScrollable()
    const child = document.createElement('div')
    scroller.appendChild(child)
    document.body.appendChild(scroller)
    // Setter silently ignores writes — the engine must not spin rAF
    // forever chasing a target it can never reach.
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: () => {}
    })

    expect(dispatchWheel(child, { deltaY: NOTCH_DELTA }).defaultPrevented).toBe(true)
    flushFrames(10)
    expect(scroller.scrollTop).toBe(0)
    expect(rafQueue.size).toBe(0)
    expect(vi.mocked(logFrontendError)).not.toHaveBeenCalled()
  })

  it('drops a queued frame that outlives dispose (cancelAnimationFrame unavailable)', () => {
    install()
    const { scroller, child } = mountScrollable()

    dispatchWheel(child, { deltaY: NOTCH_DELTA })
    flushFrames(1)
    const stale = [...rafQueue.values()]
    rafQueue.clear()
    // Teardown with a no-op cancelAnimationFrame — the queued callback
    // still fires later and must not write or reschedule.
    vi.stubGlobal('cancelAnimationFrame', () => {})
    for (const cleanup of cleanups.splice(0)) cleanup()

    const before = scroller.scrollTop
    nowValue += FRAME_MS
    for (const cb of stale) cb(nowValue)
    expect(scroller.scrollTop).toBe(before)
    expect(rafQueue.size).toBe(0)
  })
})
