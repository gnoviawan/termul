import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
})

describe('useMobileWebShell', () => {
  let matches = false
  let listeners: Array<(e: MediaQueryListEvent) => void> = []
  let originalMatchMedia: PropertyDescriptor | undefined

  beforeEach(() => {
    matches = false
    listeners = []
    mockIsTauriContext.mockReturnValue(false)

    if (originalMatchMedia === undefined) {
      originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
          listeners.push(cb)
        },
        removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
          listeners = listeners.filter((l) => l !== cb)
        },
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalMatchMedia !== undefined) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia)
    }
    listeners = []
  })

  it('returns false on Tauri', () => {
    mockIsTauriContext.mockReturnValue(true)
    matches = true
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(false)
  })

  it('returns true on web when viewport is narrow', () => {
    matches = true
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(true)
    expect(window.matchMedia).toHaveBeenCalledWith(`(max-width: ${MOBILE_WEB_SHELL_MAX_PX}px)`)
  })

  it('returns false on web when viewport is wide', () => {
    matches = false
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(false)
  })

  it('updates when matchMedia change fires', () => {
    matches = false
    const { result } = renderHook(() => useMobileWebShell())
    expect(result.current).toBe(false)

    matches = true
    act(() => {
      for (const cb of listeners) {
        cb({ matches: true } as MediaQueryListEvent)
      }
    })
    expect(result.current).toBe(true)
  })
})
