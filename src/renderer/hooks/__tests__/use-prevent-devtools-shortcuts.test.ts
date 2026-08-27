import { renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreventDevToolsShortcuts } from '@/hooks/use-prevent-devtools-shortcuts'

// P10: logFrontendError is called on each block — mock it so the assertion
// doesn't try to invoke the real Tauri command.
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

interface DispatchOptions {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/** Dispatch a real KeyboardEvent on document and return spies on its methods. */
function dispatchKeyDown(opts: DispatchOptions): {
  event: KeyboardEvent
  preventDefault: ReturnType<typeof vi.spyOn>
  stopPropagation: ReturnType<typeof vi.spyOn>
} {
  const event = new KeyboardEvent('keydown', {
    key: opts.key,
    code: opts.code ?? '',
    bubbles: true,
    cancelable: true,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false
  })
  const preventDefault = vi.spyOn(event, 'preventDefault')
  const stopPropagation = vi.spyOn(event, 'stopPropagation')
  document.dispatchEvent(event)
  return { event, preventDefault, stopPropagation }
}

describe('usePreventDevToolsShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  // ---- P5: production gating ----

  describe('in production (PROD=true)', () => {
    beforeEach(() => {
      vi.stubEnv('PROD', true)
    })

    it('mounts a capture-phase keydown listener on document', () => {
      const addSpy = vi.spyOn(document, 'addEventListener')
      renderHook(() => usePreventDevToolsShortcuts())
      expect(addSpy).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function),
        expect.objectContaining({ capture: true })
      )
    })

    it('blocks F12', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault, stopPropagation } = dispatchKeyDown({ key: 'F12', code: 'F12' })
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(stopPropagation).toHaveBeenCalledTimes(1)
    })

    it('blocks Ctrl+Shift+I (e.code=KeyI)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault, stopPropagation } = dispatchKeyDown({
        key: 'i',
        code: 'KeyI',
        ctrlKey: true,
        shiftKey: true
      })
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(stopPropagation).toHaveBeenCalledTimes(1)
    })

    it('blocks Ctrl+Shift+J (e.code=KeyJ)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault, stopPropagation } = dispatchKeyDown({
        key: 'j',
        code: 'KeyJ',
        ctrlKey: true,
        shiftKey: true
      })
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(stopPropagation).toHaveBeenCalledTimes(1)
    })

    it('blocks Ctrl+Shift+C (e.code=KeyC)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault, stopPropagation } = dispatchKeyDown({
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
        shiftKey: true
      })
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(stopPropagation).toHaveBeenCalledTimes(1)
    })

    it('blocks Ctrl+U (e.code=KeyU)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault, stopPropagation } = dispatchKeyDown({
        key: 'u',
        code: 'KeyU',
        ctrlKey: true
      })
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(stopPropagation).toHaveBeenCalledTimes(1)
    })

    // P6a: macOS Cmd+Shift+I uses metaKey
    it('blocks Cmd+Shift+I on macOS (metaKey, e.code=KeyI)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault } = dispatchKeyDown({
        key: 'i',
        code: 'KeyI',
        metaKey: true,
        shiftKey: true
      })
      expect(preventDefault).toHaveBeenCalledTimes(1)
    })

    it('blocks Cmd+U on macOS (metaKey, e.code=KeyU)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault } = dispatchKeyDown({
        key: 'u',
        code: 'KeyU',
        metaKey: true
      })
      expect(preventDefault).toHaveBeenCalledTimes(1)
    })

    // P6b: Alt excluded
    it('does NOT block Ctrl+Shift+Alt+I (altKey excluded)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault } = dispatchKeyDown({
        key: 'i',
        code: 'KeyI',
        ctrlKey: true,
        shiftKey: true,
        altKey: true
      })
      expect(preventDefault).not.toHaveBeenCalled()
    })

    it('does NOT block Ctrl+Alt+U (altKey excluded)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault } = dispatchKeyDown({
        key: 'u',
        code: 'KeyU',
        ctrlKey: true,
        altKey: true
      })
      expect(preventDefault).not.toHaveBeenCalled()
    })

    it('lets non-target keys pass through (Enter)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault, stopPropagation } = dispatchKeyDown({
        key: 'Enter',
        code: 'Enter'
      })
      expect(preventDefault).not.toHaveBeenCalled()
      expect(stopPropagation).not.toHaveBeenCalled()
    })

    it('lets Ctrl+R pass through (app reload)', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault } = dispatchKeyDown({ key: 'r', code: 'KeyR', ctrlKey: true })
      expect(preventDefault).not.toHaveBeenCalled()
    })

    it('removes the listener on unmount', () => {
      const removeSpy = vi.spyOn(document, 'removeEventListener')
      const { unmount } = renderHook(() => usePreventDevToolsShortcuts())
      unmount()
      expect(removeSpy).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function),
        expect.objectContaining({ capture: true })
      )
    })
  })

  // ---- P5: dev mode no-op ----

  describe('in dev (PROD=false)', () => {
    beforeEach(() => {
      vi.stubEnv('PROD', false)
    })

    it('does NOT add a keydown listener (dev keeps devtools access)', () => {
      const addSpy = vi.spyOn(document, 'addEventListener')
      renderHook(() => usePreventDevToolsShortcuts())
      expect(addSpy).not.toHaveBeenCalledWith(
        'keydown',
        expect.any(Function),
        expect.objectContaining({ capture: true })
      )
    })

    it('lets F12 pass through in dev', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault } = dispatchKeyDown({ key: 'F12', code: 'F12' })
      expect(preventDefault).not.toHaveBeenCalled()
    })

    it('lets Ctrl+Shift+I pass through in dev', () => {
      renderHook(() => usePreventDevToolsShortcuts())
      const { preventDefault } = dispatchKeyDown({
        key: 'i',
        code: 'KeyI',
        ctrlKey: true,
        shiftKey: true
      })
      expect(preventDefault).not.toHaveBeenCalled()
    })
  })
})
