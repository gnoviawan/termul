import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_SHELL_MAX_HEIGHT_PX,
  MOBILE_WEB_SHELL_MAX_PX,
  resolveMobileWebShell,
  useMobileWebShell
} from './use-mobile-web-shell'

const { mockIsTauriContext } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(() => false)
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

describe('resolveMobileWebShell', () => {
  it('is false inside Tauri even on a narrow viewport', () => {
    expect(resolveMobileWebShell(true, true)).toBe(false)
    expect(resolveMobileWebShell(true, false)).toBe(false)
  })

  it('is true only for web + narrow viewport', () => {
    expect(resolveMobileWebShell(false, true)).toBe(true)
    expect(resolveMobileWebShell(false, false)).toBe(false)
  })

  it('keeps the two-arg contract: short-wide alone does not flip the default', () => {
    // Backward compatibility: callers that never pass the third arg keep the
    // pre-landscape behavior (width-only).
    expect(resolveMobileWebShell(false, false)).toBe(false)
  })

  it('is true for a landscape phone (short + wide), even when not narrow', () => {
    // Story 7 (QA P2): 844×390 — width > 767 so not "narrow", but height < 500.
    expect(resolveMobileWebShell(false, false, true)).toBe(true)
  })

  it('is false on web when neither narrow nor short-wide', () => {
    // Landscape tablet: 1024×768 — height ≥ 500 keeps the desktop shell.
    expect(resolveMobileWebShell(false, false, false)).toBe(false)
  })

  it('is true when narrow, regardless of the short-wide flag', () => {
    expect(resolveMobileWebShell(false, true, false)).toBe(true)
    expect(resolveMobileWebShell(false, true, true)).toBe(true)
  })

  it('is false inside Tauri even on a landscape phone viewport', () => {
    expect(resolveMobileWebShell(true, false, true)).toBe(false)
  })
})

describe('useMobileWebShell', () => {
  // matches per query, keyed by the exact media query string.
  let matchesByQuery: Record<string, boolean> = {}
  let listenersByQuery: Record<string, Array<(e: MediaQueryListEvent) => void>> = {}
  let originalMatchMedia: PropertyDescriptor | undefined

  beforeEach(() => {
    matchesByQuery = {}
    listenersByQuery = {}
    mockIsTauriContext.mockReturnValue(false)

    if (originalMatchMedia === undefined) {
      originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => {
        if (matchesByQuery[query] === undefined) {
          // Default: a viewport matches nothing — each test sets what it needs.
          matchesByQuery[query] = false
        }
        if (listenersByQuery[query] === undefined) {
          listenersByQuery[query] = []
        }
        const listeners = listenersByQuery[query]
        const matches = () => matchesByQuery[query]
        return {
          get matches() {
            return matches()
          },
          media: query,
          onchange: null,
          addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
            listeners.push(cb)
          },
          removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
            const idx = listeners.indexOf(cb)
            if (idx >= 0) listeners.splice(idx, 1)
          },
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn()
        }
      })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalMatchMedia !== undefined) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia)
    }
    listenersByQuery = {}
  })

  const NARROW_QUERY = `(max-width: ${MOBILE_WEB_SHELL_MAX_PX}px)`
  const SHORT_WIDE_QUERY = `(max-height: ${MOBILE_WEB_SHELL_MAX_HEIGHT_PX}px) and (min-width: ${
    MOBILE_WEB_SHELL_MAX_PX + 1
  }px)`

  function fireChange(query: string, matches: boolean): void {
    matchesByQuery[query] = matches
    const listeners = listenersByQuery[query] ?? []
    for (const cb of listeners) {
      cb({ matches } as MediaQueryListEvent)
    }
  }

  it('returns false on Tauri', () => {
    mockIsTauriContext.mockReturnValue(true)
    matchesByQuery[NARROW_QUERY] = true
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(false)
  })

  it('returns true on web when viewport is narrow', () => {
    matchesByQuery[NARROW_QUERY] = true
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(true)
    expect(window.matchMedia).toHaveBeenCalledWith(NARROW_QUERY)
  })

  it('returns false on web when viewport is wide', () => {
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(false)
  })

  it('returns true for a landscape phone (width > 767, height < 500)', () => {
    // Story 7 matrix row: 844×390 — narrow query false, short-wide true.
    matchesByQuery[NARROW_QUERY] = false
    matchesByQuery[SHORT_WIDE_QUERY] = true
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(true)
  })

  it('returns false for a landscape tablet (1024×768, height ≥ 500)', () => {
    // Story 7 matrix row: neither query matches.
    matchesByQuery[NARROW_QUERY] = false
    matchesByQuery[SHORT_WIDE_QUERY] = false
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(false)
  })

  it('updates when matchMedia change fires', () => {
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(false)

    act(() => {
      fireChange(NARROW_QUERY, true)
    })
    expect(result.current).toBe(true)
  })

  it('updates live when orientation flips from portrait to landscape phone', () => {
    // Portrait phone (narrow): mobile. Rotate to landscape 844×390: narrow
    // flips off, short-wide flips on — the mobile shell must STAY.
    matchesByQuery[NARROW_QUERY] = true
    matchesByQuery[SHORT_WIDE_QUERY] = false
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(true)

    act(() => {
      fireChange(NARROW_QUERY, false)
      fireChange(SHORT_WIDE_QUERY, true)
    })
    expect(result.current).toBe(true)

    // Rotate back to portrait.
    act(() => {
      fireChange(SHORT_WIDE_QUERY, false)
      fireChange(NARROW_QUERY, true)
    })
    expect(result.current).toBe(true)
  })

  it('flips to desktop when a landscape phone grows into tablet height', () => {
    // Landscape phone (short-wide) → user resizes taller than 500px → desktop.
    matchesByQuery[NARROW_QUERY] = false
    matchesByQuery[SHORT_WIDE_QUERY] = true
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(true)

    act(() => {
      fireChange(SHORT_WIDE_QUERY, false)
    })
    expect(result.current).toBe(false)
  })
})
