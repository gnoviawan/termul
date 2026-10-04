/**
 * Story 5.3 + #852 — `useOskViewport` hook tests.
 *
 * Covers AC1/AC4: visualViewport-driven OSK detection on iOS Safari
 * (resize + scroll) and Android Chrome (layout resize), capability guard
 * fallback, the current-values keyboard-height formula (#852), and rAF
 * throttle coalescing.
 *
 * #852: `keyboardHeight = max(0, window.innerHeight - visualViewport.height)`
 * with BOTH values read at the same instant (no pre-OSK baseline). On Android
 * Chrome with `interactive-widget=resizes-content` the layout viewport shrinks
 * onto the keyboard together with the visual viewport, so the spacer must
 * collapse to ~0 — the keyboard height must not be compensated a second time.
 * On iOS (and Android without the meta) the layout viewport does not shrink,
 * so the difference is the real keyboard height.
 *
 * Mock strategy: install/uninstall a `window.visualViewport` stub per test
 * via `Object.defineProperty` and ALWAYS restore in `afterEach` (Story 5.1
 * `chat-responsive.test.tsx` leak lesson — never leak descriptor overrides).
 * `window.innerHeight` is stubbed the same way for the resizes-content
 * scenarios.
 *
 * rAF mock: real `requestAnimationFrame` is async (runs the cb on a later
 * frame). A synchronous mock breaks the hook's throttle guard (`rafId` would
 * be assigned AFTER `apply()` runs, so a second event in the same frame
 * wouldn't bail). The mock here queues `cb` on a microtask, and tests use
 * `await act(async () => ...)` to flush the microtask queue.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOskState, useOskViewport } from './use-osk-viewport'

interface VvStub extends VisualViewport {
  height: number
  offsetTop: number
  scale: number
  fireResize: () => void
  fireScroll: () => void
}

function installVisualViewport(initial: {
  height?: number
  offsetTop?: number
  scale?: number
}): VvStub {
  const resizeListeners: Array<() => void> = []
  const scrollListeners: Array<() => void> = []
  // The stub IS window.visualViewport — mutating stub.height mutates the
  // value the hook reads via `vv.height`. Keep them as one object.
  const stub = {
    height: initial.height ?? 800,
    offsetTop: initial.offsetTop ?? 0,
    scale: initial.scale ?? 1,
    addEventListener: (type: string, cb: () => void) => {
      if (type === 'resize') resizeListeners.push(cb)
      else if (type === 'scroll') scrollListeners.push(cb)
    },
    removeEventListener: (type: string, cb: () => void) => {
      if (type === 'resize') {
        const i = resizeListeners.indexOf(cb)
        if (i >= 0) resizeListeners.splice(i, 1)
      } else if (type === 'scroll') {
        const i = scrollListeners.indexOf(cb)
        if (i >= 0) scrollListeners.splice(i, 1)
      }
    },
    fireResize() {
      for (const fn of resizeListeners) fn()
    },
    fireScroll() {
      for (const fn of scrollListeners) fn()
    }
  } as unknown as VvStub

  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: stub
  })

  return stub
}

function uninstallVisualViewport(): void {
  // Delete the stub so a later test starts from a clean slate.
  try {
    delete (window as unknown as { visualViewport?: unknown }).visualViewport
  } catch {
    /* ignore — already absent */
  }
}

const originalInnerHeight = window.innerHeight

function setInnerHeight(value: number): void {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value
  })
}

function restoreInnerHeight(): void {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: originalInnerHeight
  })
}

describe('resolveOskState (pure helper)', () => {
  it('returns no-OSK defaults when visualViewport is null', () => {
    const layoutViewportHeight = 800
    const state = resolveOskState(layoutViewportHeight, null)
    expect(state.isOskOpen).toBe(false)
    expect(state.keyboardHeight).toBe(0)
    expect(state.height).toBe(layoutViewportHeight)
    expect(state.offsetTop).toBe(0)
  })

  it('detects iOS scroll OSK (offsetTop > 0, layout viewport unchanged)', () => {
    // iOS Safari: the layout viewport does NOT shrink when the OSK opens —
    // the difference IS the keyboard height, so a spacer is needed.
    const state = resolveOskState(800, {
      height: 500,
      offsetTop: 300,
      scale: 1
    } as VisualViewport)
    expect(state.isOskOpen).toBe(true)
    expect(state.keyboardHeight).toBe(300) // layoutViewportHeight - height
    expect(state.height).toBe(500)
    expect(state.offsetTop).toBe(300)
  })

  it('detects Android resizes-visual OSK (offsetTop 0, layout viewport unchanged)', () => {
    // Android without the meta (or `resizes-visual`): the visual viewport
    // shrinks under the keyboard but the layout viewport does not.
    const state = resolveOskState(800, {
      height: 500,
      offsetTop: 0,
      scale: 1
    } as VisualViewport)
    expect(state.isOskOpen).toBe(true)
    expect(state.keyboardHeight).toBe(300)
    expect(state.height).toBe(500)
    expect(state.offsetTop).toBe(0)
  })

  it('#852 collapses the spacer when the layout viewport already shrank (resizes-content)', () => {
    // Android Chrome 108+ with `interactive-widget=resizes-content`: the
    // layout viewport shrank onto the keyboard together with the visual
    // viewport — the difference is ~0, NOT the keyboard height again.
    const state = resolveOskState(480, {
      height: 480,
      offsetTop: 0,
      scale: 1
    } as VisualViewport)
    expect(state.keyboardHeight).toBe(0)
    expect(state.isOskOpen).toBe(false)
  })

  it('reports closed when visualViewport height equals the layout viewport (no shrink)', () => {
    const state = resolveOskState(800, {
      height: 800,
      offsetTop: 0,
      scale: 1
    } as VisualViewport)
    expect(state.isOskOpen).toBe(false)
    expect(state.keyboardHeight).toBe(0)
  })

  it('clamps keyboardHeight to non-negative', () => {
    const state = resolveOskState(800, {
      height: 900,
      offsetTop: 0,
      scale: 1
    } as VisualViewport)
    expect(state.keyboardHeight).toBe(0)
    expect(state.isOskOpen).toBe(false)
  })
})

describe('useOskViewport', () => {
  let originalRaf: typeof globalThis.requestAnimationFrame
  let rafCalls: number

  beforeEach(() => {
    originalRaf = globalThis.requestAnimationFrame
    rafCalls = 0
    // rAF mock that runs the callback on a microtask. This preserves the
    // throttle contract: `rafId` is assigned BEFORE `cb` runs, so a second
    // `scheduleApply` in the same frame correctly sees `rafId !== null` and
    // bails. Tests use `await act(async () => ...)` to flush the microtask.
    let nextHandle = 1
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      rafCalls += 1
      const handle = nextHandle++
      queueMicrotask(() => cb(0))
      return handle
    }
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf
    uninstallVisualViewport()
    restoreInnerHeight()
    vi.restoreAllMocks()
  })

  it('returns no-OSK default when window.visualViewport is absent', () => {
    uninstallVisualViewport()
    const { result } = renderHook(() => useOskViewport())
    expect(result.current.isOskOpen).toBe(false)
    expect(result.current.keyboardHeight).toBe(0)
    // height falls back to window.innerHeight in jsdom
    expect(result.current.height).toBe(window.innerHeight)
    expect(result.current.offsetTop).toBe(0)
  })

  it('detects iOS scroll OSK and mirrors --termul-keyboard-height to documentElement', async () => {
    // iOS: the layout viewport (innerHeight) does NOT shrink when the OSK
    // opens — only the visual viewport does. Align the stub's starting height
    // with innerHeight so the keyboardHeight assertions are exact (jsdom's
    // default innerHeight is 768).
    const layoutViewportHeight = window.innerHeight
    const vv = installVisualViewport({ height: layoutViewportHeight, offsetTop: 0 })
    const { result } = renderHook(() => useOskViewport())
    expect(result.current.isOskOpen).toBe(false)

    // OSK opens: height shrinks, offsetTop increases (iOS scroll behaviour).
    await act(async () => {
      vv.height = layoutViewportHeight - 300
      vv.offsetTop = 300
      vv.fireScroll()
      vv.fireResize()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(true))

    expect(result.current.keyboardHeight).toBe(300)
    expect(result.current.height).toBe(layoutViewportHeight - 300)
    expect(result.current.offsetTop).toBe(300)

    const cssVar = document.documentElement.style.getPropertyValue('--termul-keyboard-height')
    expect(cssVar).toBe('300px')
  })

  it('detects Android resizes-visual OSK (offsetTop 0, layout viewport unchanged)', async () => {
    // Android WITHOUT `resizes-content`: the visual viewport shrinks, the
    // layout viewport (innerHeight) does not — the spacer is the difference.
    const layoutViewportHeight = window.innerHeight
    const vv = installVisualViewport({ height: layoutViewportHeight, offsetTop: 0 })
    const { result } = renderHook(() => useOskViewport())
    expect(result.current.isOskOpen).toBe(false)

    await act(async () => {
      vv.height = layoutViewportHeight - 300
      vv.fireResize()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(true))

    expect(result.current.keyboardHeight).toBe(300)
    expect(result.current.offsetTop).toBe(0)
  })

  it('#852 does not double-compensate when innerHeight already shrank (resizes-content)', async () => {
    // The QA repro: viewport 844 → 480 with the composer focused. Android
    // Chrome with `interactive-widget=resizes-content` shrinks the LAYOUT
    // viewport (window.innerHeight) onto the keyboard together with the
    // visual viewport. The old pre-OSK-baseline formula returned the full
    // ~364px keyboard height AGAIN as a spacer — the transcript collapsed
    // behind a giant gap. The current-values formula must return ~0.
    setInnerHeight(844)
    const vv = installVisualViewport({ height: 844, offsetTop: 0 })
    const { result } = renderHook(() => useOskViewport())
    expect(result.current.isOskOpen).toBe(false)

    await act(async () => {
      // Keyboard opens: BOTH the layout viewport and the visual viewport
      // shrink to 480 (resizes-content semantics).
      setInnerHeight(480)
      vv.height = 480
      vv.fireResize()
    })
    await waitFor(() => expect(result.current.height).toBe(480))

    // No double compensation: the spacer the chat panel pads by is ~0.
    expect(result.current.keyboardHeight).toBe(0)
    expect(result.current.isOskOpen).toBe(false)
    expect(result.current.offsetTop).toBe(0)
    const cssVar = document.documentElement.style.getPropertyValue('--termul-keyboard-height')
    expect(cssVar).toBe('0px')

    // Keyboard closes: both viewports restore together; still no spacer.
    await act(async () => {
      setInnerHeight(844)
      vv.height = 844
      vv.fireResize()
    })
    await waitFor(() => expect(result.current.height).toBe(844))
    expect(result.current.keyboardHeight).toBe(0)
  })

  it('recovers to closed when the OSK closes even after mounting mid-OSK (no baseline latch)', async () => {
    // Mount with the OSK already open (height shrunk, iOS offsetTop > 0).
    // With live current-values reads there is no baseline to latch, so the
    // close transition must resolve to keyboardHeight 0.
    const layoutViewportHeight = window.innerHeight
    const vv = installVisualViewport({ height: layoutViewportHeight - 300, offsetTop: 300 })
    const { result } = renderHook(() => useOskViewport())
    await waitFor(() => expect(result.current.isOskOpen).toBe(true))

    // Close the OSK: offsetTop returns to 0, height returns to full.
    await act(async () => {
      vv.height = layoutViewportHeight
      vv.offsetTop = 0
      vv.fireResize()
      vv.fireScroll()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(false))
    expect(result.current.keyboardHeight).toBe(0)
  })

  it('coalesces multiple rapid events via rAF throttle', async () => {
    const layoutViewportHeight = window.innerHeight
    const vv = installVisualViewport({ height: layoutViewportHeight, offsetTop: 0 })
    const { result } = renderHook(() => useOskViewport())
    expect(result.current.isOskOpen).toBe(false)

    // Fire several resize+scroll events in the same frame. The hook should
    // coalesce them and only settle on the final state.
    await act(async () => {
      rafCalls = 0
      vv.height = layoutViewportHeight - 200
      vv.fireResize()
      vv.height = layoutViewportHeight - 300
      vv.fireResize()
      vv.fireScroll()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(true))

    expect(result.current.keyboardHeight).toBe(300)
    // Multiple events coalesced; we expect far fewer rAF calls than events.
    expect(rafCalls).toBeLessThan(5)
  })

  it('restores --termul-keyboard-height to 0px when OSK closes', async () => {
    const layoutViewportHeight = window.innerHeight
    const vv = installVisualViewport({ height: layoutViewportHeight, offsetTop: 0 })
    const { result } = renderHook(() => useOskViewport())

    await act(async () => {
      vv.height = layoutViewportHeight - 300
      vv.fireResize()
    })
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--termul-keyboard-height')).toBe(
        '300px'
      )
    )

    await act(async () => {
      vv.height = layoutViewportHeight
      vv.fireResize()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(false))
    expect(document.documentElement.style.getPropertyValue('--termul-keyboard-height')).toBe('0px')
  })
})
