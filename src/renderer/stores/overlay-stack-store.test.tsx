import { fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import {
  installOverlayBackHandler,
  pushOverlaySentinel,
  useOverlayRegistration,
  useOverlayStackStore
} from './overlay-stack-store'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

const detachers: Array<() => void> = []

describe('overlay-stack-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOverlayStackStore.setState({ stack: [] })
    // jsdom history: reset between tests so sentinel pushes don't pile up.
    window.history.replaceState(null, '', '#/')
  })

  afterEach(() => {
    // Guarantee no popstate listener leaks across tests even when an
    // assertion fails before the test's own detach() runs.
    while (detachers.length > 0) {
      detachers.pop()?.()
    }
  })

  /** installOverlayBackHandler that auto-detaches in afterEach. */
  function mountBackHandler(): () => void {
    const detach = installOverlayBackHandler()
    detachers.push(detach)
    return detach
  }

  describe('registration', () => {
    it('registers overlays in open order with topmost last', () => {
      const store = useOverlayStackStore.getState()
      store.registerOverlay('drawer', () => {})
      store.registerOverlay('git-sheet', () => {})

      const stack = useOverlayStackStore.getState().stack
      expect(stack.map((e) => e.id)).toEqual(['drawer', 'git-sheet'])
    })

    it('registering the same id twice is idempotent (keeps first close fn)', () => {
      const first = vi.fn()
      const second = vi.fn()
      const store = useOverlayStackStore.getState()
      store.registerOverlay('drawer', first)
      store.registerOverlay('drawer', second)

      const stack = useOverlayStackStore.getState().stack
      expect(stack).toHaveLength(1)
      stack[0].close()
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).not.toHaveBeenCalled()
    })

    it('unregisterOverlay removes the entry and is a no-op for unknown ids', () => {
      const store = useOverlayStackStore.getState()
      store.registerOverlay('drawer', () => {})
      store.unregisterOverlay('drawer')
      store.unregisterOverlay('nonexistent')

      expect(useOverlayStackStore.getState().stack).toHaveLength(0)
    })
  })

  describe('closeTopmostOverlay', () => {
    it('closes the topmost overlay via its registered close fn', () => {
      const bottom = vi.fn()
      const top = vi.fn()
      const store = useOverlayStackStore.getState()
      store.registerOverlay('bottom', bottom)
      store.registerOverlay('top', top)

      expect(store.closeTopmostOverlay()).toBe(true)
      expect(top).toHaveBeenCalledTimes(1)
      expect(bottom).not.toHaveBeenCalled()
    })

    it('returns false when the stack is empty', () => {
      expect(useOverlayStackStore.getState().closeTopmostOverlay()).toBe(false)
    })

    it('a throwing close handler unregisters the entry and logs it', () => {
      const failing = vi.fn(() => {
        throw new Error('boom')
      })
      const store = useOverlayStackStore.getState()
      store.registerOverlay('broken', failing)

      expect(store.closeTopmostOverlay()).toBe(true)
      expect(failing).toHaveBeenCalledTimes(1)
      expect(useOverlayStackStore.getState().stack).toHaveLength(0)
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'overlay-stack',
          message: expect.stringContaining("'broken'")
        })
      )
    })
  })

  describe('useOverlayRegistration hook', () => {
    it('registers while open and unregisters when closed', () => {
      const close = vi.fn()
      const { rerender, unmount } = renderHook(
        ({ open }: { open: boolean }) => useOverlayRegistration('drawer', open, close),
        { initialProps: { open: false } }
      )

      expect(useOverlayStackStore.getState().stack).toHaveLength(0)

      rerender({ open: true })
      expect(useOverlayStackStore.getState().stack.map((e) => e.id)).toEqual(['drawer'])

      rerender({ open: false })
      expect(useOverlayStackStore.getState().stack).toHaveLength(0)

      unmount()
    })

    it('unmounting while open unregisters too', () => {
      const { unmount } = renderHook(() => useOverlayRegistration('drawer', true, () => {}))
      expect(useOverlayStackStore.getState().stack).toHaveLength(1)
      unmount()
      expect(useOverlayStackStore.getState().stack).toHaveLength(0)
    })

    it('back-triggered close uses the latest close closure (ref freshness)', () => {
      let closeA = vi.fn()
      const { rerender } = renderHook(
        ({ close }: { close: () => void }) => useOverlayRegistration('drawer', true, close),
        { initialProps: { close: closeA as () => void } }
      )

      // Owner re-renders with a NEW close closure (e.g. new state capture).
      const closeB = vi.fn()
      closeA = vi.fn()
      rerender({ close: closeB as () => void })

      const top = useOverlayStackStore.getState().stack[0]
      top.close()
      expect(closeB).toHaveBeenCalledTimes(1)
      expect(closeA).not.toHaveBeenCalled()
    })
  })

  describe('pushOverlaySentinel', () => {
    it('pushes a state entry without touching the hash URL', () => {
      const hrefBefore = window.location.href
      pushOverlaySentinel()
      // Same URL (no hash change), new history entry with the marker state.
      expect(window.location.href).toBe(hrefBefore)
      expect(history.state).toEqual({ termulOverlay: true })
    })
  })

  describe('installOverlayBackHandler (popstate)', () => {
    it('popstate with an open overlay closes the topmost one', () => {
      const detach = mountBackHandler()
      const close = vi.fn()
      useOverlayStackStore.getState().registerOverlay('git-sheet', close)

      // The app root arms the sentinel when the stack grows; the back
      // gesture pops it and fires popstate.
      pushOverlaySentinel()
      fireEvent(window, new Event('popstate'))

      expect(close).toHaveBeenCalledTimes(1)

      detach()
    })

    it('popstate passes through untouched when no overlay is open (no close, no push)', () => {
      const detach = mountBackHandler()
      const close = vi.fn()
      useOverlayStackStore.getState().registerOverlay('unused', close)
      useOverlayStackStore.getState().unregisterOverlay('unused')

      fireEvent(window, new Event('popstate'))

      expect(close).not.toHaveBeenCalled()
      expect(logFrontendError).not.toHaveBeenCalled()

      detach()
    })

    it('a second back with no overlays left does nothing (normal router behavior)', () => {
      const detach = mountBackHandler()
      // The owner's real close flips its state closed, which unregisters
      // the entry — model that so the stack actually empties.
      const close = vi.fn(() => {
        useOverlayStackStore.getState().unregisterOverlay('git-sheet')
      })
      useOverlayStackStore.getState().registerOverlay('git-sheet', close)

      pushOverlaySentinel()
      fireEvent(window, new Event('popstate'))
      expect(close).toHaveBeenCalledTimes(1)

      // Stack is now empty: the next popstate is the router's business.
      fireEvent(window, new Event('popstate'))
      expect(close).toHaveBeenCalledTimes(1)

      detach()
    })

    it('re-arms the sentinel when overlays remain after a back', () => {
      const detach = mountBackHandler()
      const closeBottom = vi.fn(() => {
        useOverlayStackStore.getState().unregisterOverlay('bottom-sheet')
      })
      const closeTop = vi.fn(() => {
        useOverlayStackStore.getState().unregisterOverlay('top-sheet')
      })
      useOverlayStackStore.getState().registerOverlay('bottom-sheet', closeBottom)
      useOverlayStackStore.getState().registerOverlay('top-sheet', closeTop)

      const historySpy = vi.spyOn(history, 'pushState')

      pushOverlaySentinel()
      fireEvent(window, new Event('popstate'))
      expect(closeTop).toHaveBeenCalledTimes(1)
      // bottom-sheet still open → handler pushes a fresh sentinel.
      expect(historySpy).toHaveBeenCalledWith({ termulOverlay: true }, '')

      // And the next back closes it.
      fireEvent(window, new Event('popstate'))
      expect(closeBottom).toHaveBeenCalledTimes(1)

      historySpy.mockRestore()
      detach()
    })

    it('logs the popstate intercept via log-api (boundary log, no secrets)', () => {
      const detach = mountBackHandler()
      const close = vi.fn()
      useOverlayStackStore.getState().registerOverlay('git-sheet', close)

      pushOverlaySentinel()
      fireEvent(window, new Event('popstate'))

      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          source: 'popstate-overlay',
          message: expect.stringContaining("closed topmost overlay 'git-sheet'")
        })
      )

      detach()
    })

    it('detach removes the listener', () => {
      const detach = mountBackHandler()
      const close = vi.fn()
      useOverlayStackStore.getState().registerOverlay('git-sheet', close)

      detach()
      fireEvent(window, new Event('popstate'))

      expect(close).not.toHaveBeenCalled()
    })
  })

  describe('integration: hook + popstate together', () => {
    function Harness({ open, onClosed }: { open: boolean; onClosed: () => void }) {
      useOverlayRegistration('sheet', open, onClosed)
      return null
    }

    it('hardware back closes a hook-registered overlay and the state flips closed', () => {
      const detach = mountBackHandler()
      const onClosed = vi.fn()
      const { rerender } = render(<Harness open onClosed={onClosed} />)

      expect(useOverlayStackStore.getState().stack.map((e) => e.id)).toEqual(['sheet'])

      pushOverlaySentinel()
      fireEvent(window, new Event('popstate'))

      // The registered close fn ran (owner state would flip closed).
      expect(onClosed).toHaveBeenCalledTimes(1)

      // Simulate the owner state actually closing → stack empties.
      rerender(<Harness open={false} onClosed={onClosed} />)
      expect(useOverlayStackStore.getState().stack).toHaveLength(0)

      detach()
    })

    it('registers from a real component effect and unregisters on unmount', () => {
      function Comp(): null {
        useOverlayRegistration('drawer', true, () => {})
        return null
      }

      const { unmount } = render(
        <>
          <Comp />
        </>
      )
      expect(useOverlayStackStore.getState().stack.map((e) => e.id)).toEqual(['drawer'])
      unmount()
      expect(useOverlayStackStore.getState().stack).toHaveLength(0)
    })
  })
})
