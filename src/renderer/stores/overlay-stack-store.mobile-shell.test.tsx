import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import {
  installOverlayBackHandler,
  readOverlaySentinelDepth,
  useOverlayRegistration,
  useOverlayStackStore
} from './overlay-stack-store'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

/**
 * Real jsdom history: `history.go(n)` is async and fires one popstate whose
 * state is the target entry's. The reconciler's `schedule` is injected so the
 * coalescing is deterministic; `flush()` runs what is queued.
 */
let queued: Array<() => void> = []
let cleanup: (() => void) | null = null

function flush(): void {
  const runs = queued.splice(0)
  for (const run of runs) run()
}

function arm(options?: { traversalTimeoutMs?: number }): void {
  queued = []
  cleanup = armMobileOverlayBackStack({
    schedule: (run) => {
      queued.push(run)
    },
    ...options
  })
  // Install-time reconcile (stale-sentinel check) is a no-op on a clean state.
  flush()
}

function nextPopState(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener('popstate', () => resolve(), { once: true })
  })
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Register an overlay whose close unregisters it (like an owner's state flip). */
function openOverlay(id: string, { veto = { current: false } } = {}): vi.Mock {
  const close = vi.fn(() => {
    if (!veto.current) useOverlayStackStore.getState().unregisterOverlay(id)
  })
  useOverlayStackStore.getState().registerOverlay(id, close)
  return close
}

function closeOverlay(id: string): void {
  useOverlayStackStore.getState().unregisterOverlay(id)
}

function stackIds(): string[] {
  return useOverlayStackStore.getState().stack.map((entry) => entry.id)
}

const warnLogs = (): unknown[][] =>
  vi.mocked(logFrontendError).mock.calls.filter(([payload]) => payload.level === 'warn')

describe('overlay-stack-store mobile shell (managed history sentinels)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // A route entry below the base entry, so "a route back" has somewhere to go.
    window.history.replaceState(null, '', '#/route-a')
    window.history.pushState(null, '', '#/base')
    arm()
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
    vi.restoreAllMocks()
  })

  describe('readOverlaySentinelDepth', () => {
    it('reads the sentinel depth and treats everything else as 0', () => {
      expect(readOverlaySentinelDepth(null)).toBe(0)
      expect(readOverlaySentinelDepth(undefined)).toBe(0)
      expect(readOverlaySentinelDepth('termulOverlay')).toBe(0)
      expect(readOverlaySentinelDepth({ idx: 2 })).toBe(0)
      expect(readOverlaySentinelDepth({ termulOverlay: 'yes' })).toBe(0)
      expect(readOverlaySentinelDepth({ termulOverlay: true })).toBe(1)
      expect(readOverlaySentinelDepth({ termulOverlay: true, termulOverlayDepth: 3 })).toBe(3)
      for (const bad of [0, -1, 1.5, '2', null]) {
        expect(readOverlaySentinelDepth({ termulOverlay: true, termulOverlayDepth: bad })).toBe(1)
      }
    })
  })

  describe('pushing', () => {
    it('pushes one sentinel per overlay and spreads the router state into each', async () => {
      window.history.replaceState({ usr: 'x', key: 'k1', idx: 3 }, '', '#/base')
      const pushSpy = vi.spyOn(history, 'pushState')

      openOverlay('a')
      openOverlay('b')
      flush()

      expect(pushSpy).toHaveBeenCalledTimes(2)
      expect(history.state).toEqual({
        usr: 'x',
        key: 'k1',
        idx: 3,
        termulOverlay: true,
        termulOverlayDepth: 2
      })
      expect(location.hash).toBe('#/base')
    })

    it('coalesces a burst of stack changes into one reconcile', () => {
      openOverlay('a')
      openOverlay('b')
      closeOverlay('b')
      expect(queued).toHaveLength(1)
    })
  })

  describe('non-back close', () => {
    it('consumes the sentinel with exactly one history.back() and lands on the base entry', async () => {
      openOverlay('a')
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)

      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const popped = nextPopState()
      closeOverlay('a') // the user taps X, presses Esc or taps the scrim
      flush()
      expect(backSpy).toHaveBeenCalledTimes(1)
      await popped
      flush()

      expect(backSpy).toHaveBeenCalledTimes(1)
      expect(goSpy).not.toHaveBeenCalled()
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
      // The next back is a route back.
      await pressSystemBack()
      expect(location.hash).toBe('#/route-a')
    })

    it('uses history.go(-k) when k sentinels drop in the same flush', async () => {
      openOverlay('a')
      openOverlay('b')
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(2)

      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const popped = nextPopState()
      closeOverlay('b')
      closeOverlay('a')
      flush()
      await popped
      flush()

      expect(goSpy).toHaveBeenCalledTimes(1)
      expect(goSpy).toHaveBeenCalledWith(-2)
      expect(backSpy).not.toHaveBeenCalled()
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
    })
  })

  describe('system back', () => {
    it('closes only the topmost overlay per press and the third back is a route back', async () => {
      const closeA = openOverlay('a')
      const closeB = openOverlay('b')
      flush()
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      await pressSystemBack()
      flush()
      expect(closeB).toHaveBeenCalledTimes(1)
      expect(closeA).not.toHaveBeenCalled()
      expect(stackIds()).toEqual(['a'])
      expect(readOverlaySentinelDepth(history.state)).toBe(1)

      await pressSystemBack()
      flush()
      expect(closeA).toHaveBeenCalledTimes(1)
      expect(stackIds()).toEqual([])
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')

      // Nothing open and the entry is not a sentinel: the router's back.
      await pressSystemBack()
      flush()
      expect(location.hash).toBe('#/route-a')
      expect(closeA).toHaveBeenCalledTimes(1)
      expect(closeB).toHaveBeenCalledTimes(1)
      // Only the three presses above called back(); the reconciler added none.
      expect(backSpy).toHaveBeenCalledTimes(3)
      expect(goSpy).not.toHaveBeenCalled()
    })

    it('logs the popstate intercept at warn with the popstate-overlay source', async () => {
      openOverlay('a')
      flush()
      await pressSystemBack()

      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          source: 'popstate-overlay',
          message: expect.stringContaining("closed topmost overlay 'a'")
        })
      )
    })

    it('arms a fresh sentinel when the owner vetoes the close', async () => {
      const veto = { current: true }
      const close = openOverlay('a', { veto })
      flush()
      const pushSpy = vi.spyOn(history, 'pushState')

      await pressSystemBack()
      flush()
      expect(close).toHaveBeenCalledTimes(1)
      expect(stackIds()).toEqual(['a'])
      expect(pushSpy).toHaveBeenCalledTimes(1)
      expect(readOverlaySentinelDepth(history.state)).toBe(1)

      // The next back targets the overlay again, and now it closes.
      veto.current = false
      await pressSystemBack()
      flush()
      expect(close).toHaveBeenCalledTimes(2)
      expect(stackIds()).toEqual([])
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('closes nothing and does not traverse when nothing is open', async () => {
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const pushSpy = vi.spyOn(history, 'pushState')

      await pressSystemBack()
      flush()

      expect(location.hash).toBe('#/route-a')
      expect(backSpy).toHaveBeenCalledTimes(1) // the press itself
      expect(goSpy).not.toHaveBeenCalled()
      expect(pushSpy).not.toHaveBeenCalled()
      expect(logFrontendError).not.toHaveBeenCalled()
    })
  })

  describe('swap in one tap', () => {
    it('does not traverse or push when one flush closes an overlay and opens another', async () => {
      openOverlay('drawer')
      flush()
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const pushSpy = vi.spyOn(history, 'pushState')

      closeOverlay('drawer')
      openOverlay('settings')
      flush()

      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
      expect(pushSpy).not.toHaveBeenCalled()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)

      // One back closes the new overlay.
      await pressSystemBack()
      flush()
      expect(stackIds()).toEqual([])
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })
  })

  describe('close by navigation', () => {
    it('does not traverse across a route entry, then skips the leftover sentinel on back', async () => {
      openOverlay('drawer')
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      // A drawer row pushes a route entry, then the drawer closes.
      history.pushState(null, '', '#/c/chat-1')
      closeOverlay('drawer')
      flush()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
      expect(location.hash).toBe('#/c/chat-1')

      // Back lands on the leftover sentinel with an empty stack: one skip
      // traversal, so the press reaches the previous route.
      await pressSystemBack()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
      expect(backSpy).toHaveBeenCalledTimes(1) // the press
      const popped = nextPopState()
      flush()
      expect(backSpy).toHaveBeenCalledTimes(2) // + the skip traversal
      await popped
      flush()

      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          source: 'overlay-stack',
          message: expect.stringContaining('stale')
        })
      )
    })
  })

  describe('stale sentinel', () => {
    it('traverses back to the base entry after a forward into a sentinel', async () => {
      openOverlay('a')
      flush()
      let popped = nextPopState()
      closeOverlay('a')
      flush()
      await popped
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(0)

      const backSpy = vi.spyOn(history, 'back')
      popped = nextPopState()
      history.forward() // lands on the consumed sentinel entry
      await popped
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
      popped = nextPopState()
      flush()
      expect(backSpy).toHaveBeenCalledTimes(1)
      await popped
      flush()

      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
    })

    it('clears a sentinel left over from a reload when the mobile shell turns on', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      history.pushState({ termulOverlay: true }, '')
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
      const backSpy = vi.spyOn(history, 'back')

      const popped = nextPopState()
      useOverlayStackStore.getState().setMobileShell(true)
      flush()
      expect(backSpy).toHaveBeenCalledTimes(1)
      await popped
      flush()

      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
    })

    it('clears a sentinel already on the entry when the handler installs with the flag on (phone reload)', async () => {
      // A reload keeps `history.state`, and `useMobileWebShell` is true from
      // the first render, so the flag is already on when the handler installs:
      // the subscription's flip branch never runs, only the install-time one.
      cleanup?.()
      queued = []
      history.pushState({ termulOverlay: true, termulOverlayDepth: 1 }, '')
      useOverlayStackStore.setState({ stack: [], mobileShell: true })
      const backSpy = vi.spyOn(history, 'back')

      const popped = nextPopState()
      const detach = installOverlayBackHandler({
        schedule: (run) => {
          queued.push(run)
        }
      })
      cleanup = () => {
        detach()
        useOverlayStackStore.setState({ stack: [], mobileShell: false })
      }
      flush()
      expect(backSpy).toHaveBeenCalledTimes(1)
      await popped
      flush()

      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'info', source: 'overlay-stack' })
      )
    })
  })

  describe('Esc fallback', () => {
    it('closes the topmost overlay when no handler owns the Esc', async () => {
      const closeA = openOverlay('a')
      flush()

      fireEvent.keyDown(window, { key: 'Escape' })
      await tick()

      expect(closeA).toHaveBeenCalledTimes(1)
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'info', source: 'overlay-stack' })
      )
      // The sentinel is consumed by the reconciler, not left behind.
      const popped = nextPopState()
      flush()
      await popped
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('does nothing when a handler called preventDefault()', async () => {
      const closeA = openOverlay('a')
      flush()
      const owner = (event: KeyboardEvent): void => event.preventDefault()
      document.addEventListener('keydown', owner, true)

      fireEvent.keyDown(document.body, { key: 'Escape' })
      await tick()
      document.removeEventListener('keydown', owner, true)

      expect(closeA).not.toHaveBeenCalled()
      expect(stackIds()).toEqual(['a'])
    })

    it('closes exactly one overlay when a handler already closed the topmost', async () => {
      const closeA = openOverlay('a')
      openOverlay('b')
      flush()
      const owner = (): void => closeOverlay('b')
      window.addEventListener('keydown', owner)

      fireEvent.keyDown(document.body, { key: 'Escape' })
      await tick()
      window.removeEventListener('keydown', owner)

      expect(closeA).not.toHaveBeenCalled()
      expect(stackIds()).toEqual(['a'])
    })

    it('ignores auto-repeat, IME composition, other keys and an empty stack', async () => {
      const closeA = openOverlay('a')
      flush()

      fireEvent.keyDown(window, { key: 'Escape', repeat: true })
      fireEvent.keyDown(window, { key: 'Escape', isComposing: true })
      fireEvent.keyDown(window, { key: 'Enter' })
      await tick()
      expect(closeA).not.toHaveBeenCalled()

      closeOverlay('a')
      fireEvent.keyDown(window, { key: 'Escape' })
      await tick()
      expect(closeA).not.toHaveBeenCalled()
    })

    it('is inert on desktop (mobileShell false)', async () => {
      const closeA = openOverlay('a')
      flush()
      useOverlayStackStore.getState().setMobileShell(false)

      fireEvent.keyDown(window, { key: 'Escape' })
      await tick()

      expect(closeA).not.toHaveBeenCalled()
    })
  })

  describe('History API failure', () => {
    it('does not throw when pushState throws and logs a warn', () => {
      const closeA = vi.fn()
      vi.spyOn(history, 'pushState').mockImplementation(() => {
        throw new Error('rate cap')
      })

      expect(() => {
        useOverlayStackStore.getState().registerOverlay('a', closeA)
        flush()
      }).not.toThrow()

      // The overlay still closes through its visible controls.
      expect(stackIds()).toEqual(['a'])
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', source: 'overlay-stack' })
      )
    })

    it('does not throw when the traversal throws, logs a warn and retries on the next change', async () => {
      openOverlay('a')
      flush()
      const backSpy = vi.spyOn(history, 'back').mockImplementationOnce(() => {
        throw new Error('sandboxed')
      })

      expect(() => {
        closeOverlay('a')
        flush()
      }).not.toThrow()
      expect(warnLogs().some(([payload]) => payload.source === 'overlay-stack')).toBe(true)

      // The pending flag was cleared: the next stack change reconciles again.
      const popped = nextPopState()
      openOverlay('b')
      flush()
      closeOverlay('b')
      flush()
      expect(backSpy).toHaveBeenCalledTimes(2)
      await popped
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })
  })

  describe('lost traversal', () => {
    it('clears the pending flag after the timeout, warns and reconciles again', async () => {
      cleanup?.()
      arm({ traversalTimeoutMs: 20 })
      openOverlay('a')
      flush()
      const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {})

      closeOverlay('a')
      flush()
      expect(backSpy).toHaveBeenCalledTimes(1)
      // A pending traversal blocks further reconciles.
      flush()
      expect(backSpy).toHaveBeenCalledTimes(1)

      await tick(40)
      expect(warnLogs().some(([payload]) => /no popstate/.test(payload.message))).toBe(true)
      flush()
      expect(backSpy).toHaveBeenCalledTimes(2)
    })

    it('stops retrying after repeated misses so a stuck history cannot loop', async () => {
      cleanup?.()
      arm({ traversalTimeoutMs: 10 })
      openOverlay('a')
      flush()
      const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {})

      closeOverlay('a')
      for (let attempt = 0; attempt < 5; attempt += 1) {
        flush()
        await tick(25)
      }

      expect(backSpy).toHaveBeenCalledTimes(3)
      expect(queued).toHaveLength(0)
    })
  })

  describe('default scheduler (requestAnimationFrame)', () => {
    it('reconciles after a route push queued earlier in the frame, so a drawer-row close never traverses', async () => {
      // The real default scheduler, not the injected one.
      cleanup?.()
      cleanup = armMobileOverlayBackStack()
      openOverlay('drawer')
      await waitForSentinelDepth(1)
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      // MobileChatShell.selectTab: an rAF that navigates is requested first,
      // then the drawer closes in the same tick (which schedules the reconcile).
      requestAnimationFrame(() => history.pushState(null, '', '#/c/chat-1'))
      closeOverlay('drawer')
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
        await tick()
      })

      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
      expect(location.hash).toBe('#/c/chat-1')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })
  })

  describe('desktop (mobileShell false)', () => {
    it('mobileShellOnly registrations are inert and nothing is pushed', () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const close = vi.fn()

      const { rerender, unmount } = renderHook(
        ({ open }: { open: boolean }) =>
          useOverlayRegistration('dialog:x', open, close, { mobileShellOnly: true }),
        { initialProps: { open: true } }
      )
      flush()
      expect(stackIds()).toEqual([])
      expect(pushSpy).not.toHaveBeenCalled()

      // Becomes live only once the mobile shell turns on.
      act(() => {
        useOverlayStackStore.getState().setMobileShell(true)
      })
      expect(stackIds()).toEqual(['dialog:x'])
      act(() => {
        useOverlayStackStore.getState().setMobileShell(false)
      })
      expect(stackIds()).toEqual([])

      rerender({ open: false })
      unmount()
    })

    it('default-scope registrations keep the legacy popstate path', () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const closeTop = vi.fn(() => closeOverlay('top'))
      useOverlayStackStore.getState().registerOverlay('bottom', vi.fn())
      useOverlayStackStore.getState().registerOverlay('top', closeTop)
      flush()

      fireEvent(window, new Event('popstate'))

      expect(closeTop).toHaveBeenCalledTimes(1)
      // Legacy re-arm shape, not the managed sentinel.
      expect(pushSpy).toHaveBeenCalledWith({ termulOverlay: true }, '')
    })
  })

  describe('detach', () => {
    it('removes the listeners and the subscription and cancels scheduled work', async () => {
      const closeA = openOverlay('a')
      expect(queued).toHaveLength(1)
      const pushSpy = vi.spyOn(history, 'pushState')

      cleanup?.()
      cleanup = null
      // Scheduled-but-unrun work is a no-op after detach.
      flush()
      expect(pushSpy).not.toHaveBeenCalled()

      // No subscription: a stack change schedules nothing.
      useOverlayStackStore.setState({ mobileShell: true })
      openOverlay('b')
      expect(queued).toHaveLength(0)

      // No popstate or Esc handling.
      fireEvent(window, new Event('popstate'))
      fireEvent.keyDown(window, { key: 'Escape' })
      await tick()
      expect(closeA).not.toHaveBeenCalled()
    })

    it('installing twice and detaching one leaves the other working', async () => {
      const second = installOverlayBackHandler({
        schedule: (run) => {
          queued.push(run)
        }
      })
      second()
      const closeA = openOverlay('a')
      flush()
      await waitForSentinelDepth(1)

      await pressSystemBack()
      expect(closeA).toHaveBeenCalledTimes(1)
    })
  })
})
