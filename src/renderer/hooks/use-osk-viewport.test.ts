/**
 * Story 5.3 — `useOskViewport` hook tests.
 *
 * Covers AC1/AC4: visualViewport-driven OSK detection on iOS Safari
 * (resize + scroll) and Android Chrome (layout resize), capability guard
 * fallback, baseline-protection heuristic, and rAF throttle coalescing.
 *
 * Mock strategy: install/uninstall a `window.visualViewport` stub per test
 * via `Object.defineProperty` and ALWAYS restore in `afterEach` (Story 5.1
 * `chat-responsive.test.tsx` leak lesson — never leak descriptor overrides).
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
  // Delete the stub so a later test starts from a clean baseline.
  try {
    delete (window as unknown as { visualViewport?: unknown }).visualViewport
  } catch {
    /* ignore — already absent */
  }
}

describe('resolveOskState (pure helper)', () => {
  it('returns no-OSK defaults when visualViewport is null', () => {
    const baseline = 800
    const state = resolveOskState(baseline, null)
    expect(state.isOskOpen).toBe(false)
    expect(state.keyboardHeight).toBe(0)
    expect(state.height).toBe(baseline)
    expect(state.offsetTop).toBe(0)
  })

  it('detects iOS scroll OSK (offsetTop > 0)', () => {
    const baseline = 800
    const state = resolveOskState(baseline, {
      height: 500,
      offsetTop: 300,
      scale: 1
    } as VisualViewport)
    expect(state.isOskOpen).toBe(true)
    expect(state.keyboardHeight).toBe(300) // baseline - height
    expect(state.height).toBe(500)
    expect(state.offsetTop).toBe(300)
  })

  it('detects Android layout-resize OSK (offsetTop 0, height shrinks)', () => {
    const baseline = 800
    const state = resolveOskState(baseline, {
      height: 500,
      offsetTop: 0,
      scale: 1
    } as VisualViewport)
    expect(state.isOskOpen).toBe(true)
    expect(state.keyboardHeight).toBe(300)
    expect(state.height).toBe(500)
    expect(state.offsetTop).toBe(0)
  })

  it('reports closed when visualViewport height equals baseline (no shrink)', () => {
    const baseline = 800
    const state = resolveOskState(baseline, {
      height: 800,
      offsetTop: 0,
      scale: 1
    } as VisualViewport)
    expect(state.isOskOpen).toBe(false)
    expect(state.keyboardHeight).toBe(0)
  })

  it('clamps keyboardHeight to non-negative', () => {
    const baseline = 800
    const state = resolveOskState(baseline, {
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
    // Align baseline (window.innerHeight) with the stub's starting height so
    // keyboardHeight assertions are exact (jsdom's default innerHeight is 768,
    // but the stub starts at 800 — the baseline captured at mount is the
    // layout viewport = window.innerHeight).
    const baseline = window.innerHeight
    const vv = installVisualViewport({ height: baseline, offsetTop: 0 })
    const { result } = renderHook(() => useOskViewport())
    expect(result.current.isOskOpen).toBe(false)

    // OSK opens: height shrinks, offsetTop increases (iOS scroll behaviour).
    await act(async () => {
      vv.height = baseline - 300
      vv.offsetTop = 300
      vv.fireScroll()
      vv.fireResize()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(true))

    expect(result.current.keyboardHeight).toBe(300)
    expect(result.current.height).toBe(baseline - 300)
    expect(result.current.offsetTop).toBe(300)

    const cssVar = document.documentElement.style.getPropertyValue('--termul-keyboard-height')
    expect(cssVar).toBe('300px')
  })

  it('detects Android layout-resize OSK (offsetTop 0, innerHeight shrinks)', async () => {
    const baseline = window.innerHeight
    const vv = installVisualViewport({ height: baseline, offsetTop: 0 })
    const { result } = renderHook(() => useOskViewport())
    expect(result.current.isOskOpen).toBe(false)

    await act(async () => {
      vv.height = baseline - 300
      vv.fireResize()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(true))

    expect(result.current.keyboardHeight).toBe(300)
    expect(result.current.offsetTop).toBe(0)
  })

  it('skips baseline updates when iOS offsetTop > 0 (baseline protection)', async () => {
    const baseline = window.innerHeight
    // Mount with the OSK already partially scrolled (offsetTop > 0). The
    // baseline-protection heuristic must NOT capture this shrunk height as
    // the baseline, otherwise closing the OSK would never report keyboardHeight 0.
    const vv = installVisualViewport({ height: baseline - 300, offsetTop: 300 })
    const { result } = renderHook(() => useOskViewport())
    await waitFor(() => expect(result.current.isOskOpen).toBe(true))

    // Close the OSK: offsetTop returns to 0, height returns to baseline.
    await act(async () => {
      vv.height = baseline
      vv.offsetTop = 0
      vv.fireResize()
      vv.fireScroll()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(false))
    expect(result.current.keyboardHeight).toBe(0)
  })

  it('coalesces multiple rapid events via rAF throttle', async () => {
    const baseline = window.innerHeight
    const vv = installVisualViewport({ height: baseline, offsetTop: 0 })
    const { result } = renderHook(() => useOskViewport())
    expect(result.current.isOskOpen).toBe(false)

    // Fire several resize+scroll events in the same frame. The hook should
    // coalesce them and only settle on the final state.
    await act(async () => {
      rafCalls = 0
      vv.height = baseline - 200
      vv.fireResize()
      vv.height = baseline - 300
      vv.fireResize()
      vv.fireScroll()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(true))

    expect(result.current.keyboardHeight).toBe(300)
    // Multiple events coalesced; we expect far fewer rAF calls than events.
    expect(rafCalls).toBeLessThan(5)
  })

  it('restores --termul-keyboard-height to 0px when OSK closes', async () => {
    const baseline = window.innerHeight
    const vv = installVisualViewport({ height: baseline, offsetTop: 0 })
    const { result } = renderHook(() => useOskViewport())

    await act(async () => {
      vv.height = baseline - 300
      vv.fireResize()
    })
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--termul-keyboard-height')).toBe(
        '300px'
      )
    )

    await act(async () => {
      vv.height = baseline
      vv.fireResize()
    })
    await waitFor(() => expect(result.current.isOskOpen).toBe(false))
    expect(document.documentElement.style.getPropertyValue('--termul-keyboard-height')).toBe('0px')
  })
})
