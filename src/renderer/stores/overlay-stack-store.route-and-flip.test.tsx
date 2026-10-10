import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import {
  installOverlayBackHandler,
  notifyOverlayRouteChange,
  readOverlaySentinelDepth,
  useOverlayRegistration,
  useOverlayStackStore
} from './overlay-stack-store'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

/**
 * L-33 (route push or replace with an overlay open) and L-34 (mobile to desktop
 * breakpoint flip) against the real jsdom history. The reconciler's `schedule`
 * is injected so the coalescing is deterministic; `flush()` runs what is queued.
 */
let queued: Array<() => void> = []
let cleanup: (() => void) | null = null

function flush(): void {
  const runs = queued.splice(0)
  for (const run of runs) run()
}

function arm(): void {
  queued = []
  cleanup = armMobileOverlayBackStack({
    schedule: (run) => {
      queued.push(run)
    }
  })
  flush()
}

function nextPopState(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener('popstate', () => resolve(), { once: true })
  })
}

/** Register a default-scope overlay whose close unregisters it. */
function openOverlay(id: string): vi.Mock {
  const close = vi.fn(() => useOverlayStackStore.getState().unregisterOverlay(id))
  useOverlayStackStore.getState().registerOverlay(id, close)
  return close
}

/** Register mobile-shell-only overlays through the real hook (they unregister on a flip). */
function openMobileOnlyOverlays(ids: string[]): vi.Mock[] {
  return ids.map((id) => {
    const close = vi.fn(() => {
      useOverlayStackStore.getState().unregisterOverlay(id)
    })
    renderHook(() => useOverlayRegistration(id, true, close, { mobileShellOnly: true }))
    return close
  })
}

function stackIds(): string[] {
  return useOverlayStackStore.getState().stack.map((entry) => entry.id)
}

function setShell(mobile: boolean): void {
  act(() => {
    useOverlayStackStore.getState().setMobileShell(mobile)
  })
}

const logsOf = (level: 'info' | 'warn'): Array<{ message: string; source: string }> =>
  vi
    .mocked(logFrontendError)
    .mock.calls.map(([payload]) => payload)
    .filter((payload) => payload.level === level)

describe('overlay-stack-store route change and breakpoint flip', () => {
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

  describe('route push with an overlay open (L-33)', () => {
    it('re-arms one sentinel on the new entry, so one back closes the overlay and keeps the route', async () => {
      const close = openOverlay('sheet')
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)

      // The router pushes a route (no popstate), the layout location key changes.
      history.pushState({ usr: null, key: 'k2', idx: 2 }, '', '#/c/chat-1')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      const pushSpy = vi.spyOn(history, 'pushState')
      notifyOverlayRouteChange()
      expect(queued).toHaveLength(1)
      flush()

      expect(pushSpy).toHaveBeenCalledTimes(1)
      expect(history.state).toEqual({
        usr: null,
        key: 'k2',
        idx: 2,
        termulOverlay: true,
        termulOverlayDepth: 1
      })
      expect(location.hash).toBe('#/c/chat-1')
      expect(logsOf('info')).toContainEqual(
        expect.objectContaining({
          source: 'overlay-stack',
          message: expect.stringContaining('Route changed')
        })
      )

      await pressSystemBack()
      flush()

      expect(close).toHaveBeenCalledTimes(1)
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/c/chat-1')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('re-arms every missing sentinel when two overlays are open', async () => {
      openOverlay('a')
      openOverlay('b')
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(2)

      history.pushState(null, '', '#/c/chat-1')
      notifyOverlayRouteChange()
      flush()

      expect(readOverlaySentinelDepth(history.state)).toBe(2)
      expect(location.hash).toBe('#/c/chat-1')
    })
  })

  describe('route replace with an overlay open (L-33)', () => {
    it('re-arms after the replace dropped the marker, and one back closes the overlay', async () => {
      const close = openOverlay('sheet')
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)

      // A replace overwrites the sentinel's state: the marker is gone.
      history.replaceState({ usr: null, key: 'k3', idx: 1 }, '', '#/replaced')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      notifyOverlayRouteChange()
      flush()

      expect(readOverlaySentinelDepth(history.state)).toBe(1)
      expect(location.hash).toBe('#/replaced')

      await pressSystemBack()
      flush()

      expect(close).toHaveBeenCalledTimes(1)
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/replaced')
    })
  })

  describe('route change with nothing to re-arm', () => {
    it('does not push or traverse when the sentinels already match the stack', () => {
      openOverlay('sheet')
      flush()
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      notifyOverlayRouteChange()
      flush()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
      expect(logsOf('info')).toEqual([])
    })

    it('does nothing with no overlay open', () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      history.pushState(null, '', '#/c/chat-1')
      pushSpy.mockClear()

      notifyOverlayRouteChange()
      flush()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(logsOf('info')).toEqual([])
    })

    it('coalesces a burst of route changes into one reconcile', () => {
      notifyOverlayRouteChange()
      notifyOverlayRouteChange()
      notifyOverlayRouteChange()
      expect(queued).toHaveLength(1)
    })

    it('is inert on desktop: no history call at all', () => {
      openOverlay('sheet')
      flush()
      setShell(false)
      flush()
      history.pushState(null, '', '#/c/chat-1')
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      notifyOverlayRouteChange()
      flush()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })

    it('is a no-op after the handler detached', () => {
      openOverlay('sheet')
      flush()
      history.pushState(null, '', '#/c/chat-1')
      cleanup?.()
      cleanup = null
      queued = []
      const pushSpy = vi.spyOn(history, 'pushState')

      expect(() => notifyOverlayRouteChange()).not.toThrow()
      flush()

      expect(queued).toHaveLength(0)
      expect(pushSpy).not.toHaveBeenCalled()
    })

    it('reaches every installed handler and only the ones still installed', () => {
      const queuedSecond: Array<() => void> = []
      const runSecond = (): void => {
        for (const run of queuedSecond.splice(0)) run()
      }
      const detachSecond = installOverlayBackHandler({
        schedule: (run) => {
          queuedSecond.push(run)
        }
      })
      try {
        // The install-time reconcile (stale-sentinel check) is a no-op here.
        runSecond()

        notifyOverlayRouteChange()
        expect(queued).toHaveLength(1)
        expect(queuedSecond).toHaveLength(1)
        runSecond()
      } finally {
        detachSecond()
      }

      flush()
      notifyOverlayRouteChange()
      expect(queued).toHaveLength(1)
      expect(queuedSecond).toHaveLength(0)
    })
  })

  describe('route change with the History API failing (L-33)', () => {
    it('does not throw when pushState throws and logs a warn', () => {
      const close = openOverlay('sheet')
      flush()
      history.pushState(null, '', '#/c/chat-1')
      vi.spyOn(history, 'pushState').mockImplementation(() => {
        throw new Error('rate cap')
      })

      expect(() => {
        notifyOverlayRouteChange()
        flush()
      }).not.toThrow()

      // The overlay still closes through its visible controls.
      expect(stackIds()).toEqual(['sheet'])
      expect(close).not.toHaveBeenCalled()
      expect(logsOf('warn')).toContainEqual(
        expect.objectContaining({
          source: 'overlay-stack',
          message: expect.stringContaining('push')
        })
      )
    })
  })

  describe('real scheduler: route push within a frame (L-33)', () => {
    it('arms a depth-1 sentinel on the new entry and one back closes the overlay', async () => {
      cleanup?.()
      cleanup = armMobileOverlayBackStack()
      const close = openOverlay('sheet')
      await waitForSentinelDepth(1)

      history.pushState(null, '', '#/c/chat-1')
      notifyOverlayRouteChange()
      await waitForSentinelDepth(1)
      expect(location.hash).toBe('#/c/chat-1')

      await pressSystemBack()

      expect(close).toHaveBeenCalledTimes(1)
      expect(location.hash).toBe('#/c/chat-1')
      await waitForSentinelDepth(0)
    })
  })

  describe('mobile to desktop flip (L-34)', () => {
    it('consumes every stranded sentinel with one go(-n) whose popstate nothing reacts to', async () => {
      const closes = openMobileOnlyOverlays(['mobile-a', 'mobile-b'])
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(2)
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      vi.mocked(logFrontendError).mockClear()

      // The breakpoint flips: both mobile-only registrations unregister.
      const popped = nextPopState()
      setShell(false)
      expect(stackIds()).toEqual([])
      flush()

      expect(goSpy).toHaveBeenCalledTimes(1)
      expect(goSpy).toHaveBeenCalledWith(-2)
      expect(backSpy).not.toHaveBeenCalled()
      expect(logsOf('info')).toContainEqual(
        expect.objectContaining({
          source: 'overlay-stack',
          message: expect.stringContaining('Breakpoint')
        })
      )
      await popped
      flush()

      // Neither popstate path reacted: nothing closed, no re-arm, no extra traversal.
      for (const close of closes) expect(close).not.toHaveBeenCalled()
      expect(
        vi.mocked(logFrontendError).mock.calls.filter(([p]) => p.source === 'popstate-overlay')
      ).toEqual([])
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
      expect(goSpy).toHaveBeenCalledTimes(1)
      expect(backSpy).not.toHaveBeenCalled()

      // The next back is a route back, not a dead press.
      await pressSystemBack()
      flush()
      expect(location.hash).toBe('#/route-a')
    })

    it('keeps one sentinel for a default-scope overlay that stays open', async () => {
      const closeGit = openOverlay('git-sheet')
      const [closeHistory] = openMobileOnlyOverlays(['command-history'])
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(2)
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      const popped = nextPopState()
      setShell(false)
      expect(stackIds()).toEqual(['git-sheet'])
      flush()

      // One traversal of one entry (startTraversal(-1) is history.back()).
      expect(backSpy).toHaveBeenCalledTimes(1)
      expect(goSpy).not.toHaveBeenCalled()
      await popped
      flush()
      expect(closeGit).not.toHaveBeenCalled()
      expect(closeHistory).not.toHaveBeenCalled()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
      expect(location.hash).toBe('#/base')

      // The next back closes the git sheet once (the legacy popstate path).
      await pressSystemBack()
      expect(closeGit).toHaveBeenCalledTimes(1)
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')

      // The one after is a route back.
      await pressSystemBack()
      expect(location.hash).toBe('#/route-a')
      expect(closeGit).toHaveBeenCalledTimes(1)
      expect(backSpy).toHaveBeenCalledTimes(3) // the cleanup plus the two presses
    })

    it('makes no history call when the sentinels do not exceed the overlays still open', () => {
      openOverlay('git-sheet')
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      vi.mocked(logFrontendError).mockClear()

      setShell(false)
      flush()

      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
      expect(logsOf('info')).toEqual([])
    })

    it('makes no history call when the current entry is not a sentinel', () => {
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      setShell(false)
      flush()

      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })

    it('never traverses across a route entry: a sentinel below a pushed route is left alone', () => {
      openMobileOnlyOverlays(['mobile-a'])
      flush()
      // A route is pushed on top of the sentinel; the current entry is a route.
      history.pushState(null, '', '#/c/chat-1')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      setShell(false)
      flush()

      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
      expect(location.hash).toBe('#/c/chat-1')
    })

    it('runs once: a later reconcile on desktop does not traverse again', async () => {
      openMobileOnlyOverlays(['mobile-a', 'mobile-b'])
      flush()
      const goSpy = vi.spyOn(history, 'go')

      const popped = nextPopState()
      setShell(false)
      flush()
      await popped
      flush()
      expect(goSpy).toHaveBeenCalledTimes(1)

      // Another stack change on desktop: nothing is armed any more.
      openOverlay('git-sheet')
      flush()
      expect(goSpy).toHaveBeenCalledTimes(1)
    })

    it('is disarmed when the viewport comes back to mobile before the deferred run', () => {
      openMobileOnlyOverlays(['mobile-a', 'mobile-b'])
      flush()
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      setShell(false)
      setShell(true)
      flush()

      // Back on mobile the reconciler re-evaluates; two overlays, two sentinels.
      expect(goSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect([...stackIds()].sort()).toEqual(['mobile-a', 'mobile-b'])
      expect(readOverlaySentinelDepth(history.state)).toBe(2)
    })

    it('does not throw when go() throws, logs a warn and leaves the overlays usable', () => {
      const closeGit = openOverlay('git-sheet')
      openMobileOnlyOverlays(['mobile-a', 'mobile-b'])
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(3)
      vi.spyOn(history, 'go').mockImplementation(() => {
        throw new Error('sandboxed')
      })

      expect(() => {
        setShell(false)
        flush()
      }).not.toThrow()

      expect(logsOf('warn')).toContainEqual(
        expect.objectContaining({
          source: 'overlay-stack',
          message: expect.stringContaining('traversal failed')
        })
      )
      // The pending flag was cleared and the git sheet still closes on its own.
      expect(stackIds()).toEqual(['git-sheet'])
      useOverlayStackStore.getState().closeTopmostOverlay()
      expect(closeGit).toHaveBeenCalledTimes(1)
    })

    it('does not discard a consume traversal already in flight when the flip arrives', async () => {
      const closeBase = openOverlay('base-overlay')
      openOverlay('git-sheet')
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(2)
      const backSpy = vi.spyOn(history, 'back')

      // The user closes the top overlay (a consume traversal starts), then the
      // viewport flips before its popstate arrives.
      const popped = nextPopState()
      useOverlayStackStore.getState().unregisterOverlay('git-sheet')
      flush()
      expect(backSpy).toHaveBeenCalledTimes(1)
      setShell(false)
      await popped
      flush()

      // The popstate was still ignored on desktop: the legacy handler did not
      // close the overlay that stays open, and nothing traversed again.
      expect(closeBase).not.toHaveBeenCalled()
      expect(stackIds()).toEqual(['base-overlay'])
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
      expect(backSpy).toHaveBeenCalledTimes(1)
    })

    it('still consumes the sentinels left over after an in-flight traversal when the flip arrives', async () => {
      const [, closeB] = openMobileOnlyOverlays(['mobile-a', 'mobile-b'])
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(2)
      const backSpy = vi.spyOn(history, 'back')

      // The top overlay closes (a consume traversal starts), then the viewport
      // flips before its popstate: the other mobile-only overlay unregisters too.
      const firstPop = nextPopState()
      closeB()
      flush()
      expect(backSpy).toHaveBeenCalledTimes(1)
      setShell(false)
      flush()
      expect(stackIds()).toEqual([])
      expect(backSpy).toHaveBeenCalledTimes(1)

      // The in-flight popstate is ignored; the deferred cleanup then consumes
      // the one sentinel that is still left.
      await firstPop
      const secondPop = nextPopState()
      flush()
      expect(backSpy).toHaveBeenCalledTimes(2)
      await secondPop
      flush()

      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
      expect(backSpy).toHaveBeenCalledTimes(2)

      await pressSystemBack()
      flush()
      expect(location.hash).toBe('#/route-a')
    })

    it('retries the cleanup when its traversal produced no popstate', async () => {
      cleanup?.()
      cleanup = armMobileOverlayBackStack({
        schedule: (run) => {
          queued.push(run)
        },
        traversalTimeoutMs: 20
      })
      flush()
      openMobileOnlyOverlays(['mobile-a', 'mobile-b'])
      flush()
      expect(readOverlaySentinelDepth(history.state)).toBe(2)
      // The first go(-2) is lost: the browser never fires its popstate.
      const goSpy = vi.spyOn(history, 'go').mockImplementationOnce(() => undefined)

      setShell(false)
      flush()
      expect(goSpy).toHaveBeenCalledTimes(1)

      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 60))
      })
      expect(logsOf('warn')).toContainEqual(
        expect.objectContaining({
          source: 'overlay-stack',
          message: expect.stringContaining('no popstate')
        })
      )
      const popped = nextPopState()
      flush()
      expect(goSpy).toHaveBeenCalledTimes(2)
      expect(goSpy).toHaveBeenLastCalledWith(-2)
      await popped
      flush()

      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
    })
  })
})
