/**
 * Overlay stack registry (Story 6 — trap-free mobile navigation).
 *
 * QA finding F5: the renderer had zero `popstate` handlers, so Android's
 * hardware back exited the app while a sheet/dialog was open. This store is
 * the single registration point every overlay owner calls into: each overlay
 * registers `(id, close)` on open and unregisters on close. A popstate
 * listener at the app root (see `installOverlayBackHandler`) pops the
 * topmost overlay instead of the app.
 *
 * Registration-based (not DOM-querying) so the behavior is testable in jsdom.
 * The stack is plain state — no PTYs, no navigation, nothing destructive:
 * closing is delegated to each owner's own close function (the terminal-close
 * confirm flow, the editor dirty guard, etc. are never bypassed).
 *
 * Mobile shell: while `mobileShell` is true the history sentinels are managed
 * by a coalesced reconciler (see `installOverlayBackHandler`) that keeps the
 * number of `termulOverlay` entries equal to the stack depth, so a close by
 * X, Esc or scrim never leaves a dead back press behind. While it is false the
 * legacy push-on-growth + popstate re-arm path is unchanged.
 */

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { logFrontendError } from '@/lib/log-api'

export interface OverlayEntry {
  /** Stable unique id, e.g. 'mobile-drawer' or 'git-sheet'. */
  id: string
  /** Owner-provided close. Must be side-effect-idempotent. */
  close: () => void
}

interface OverlayStackState {
  /** Open overlays, oldest → topmost (last element is topmost). */
  stack: OverlayEntry[]
  /**
   * True while the mobile web shell is active. Set by WorkspaceLayout from
   * `useMobileWebShell()`. Gates the managed history-sentinel path and the
   * `mobileShellOnly` registrations; false keeps the desktop path unchanged.
   */
  mobileShell: boolean
  /** Flip the mobile-shell flag (idempotent). */
  setMobileShell: (active: boolean) => void
  /** Register an overlay as open; marks it topmost. Idempotent by id. */
  registerOverlay: (id: string, close: () => void) => void
  /** Unregister an overlay (idempotent; missing id is a no-op). */
  unregisterOverlay: (id: string) => void
  /** Close the topmost overlay via its registered close fn. No-op when empty. */
  closeTopmostOverlay: () => boolean
}

export const useOverlayStackStore = create<OverlayStackState>((set, get) => ({
  stack: [],
  mobileShell: false,

  setMobileShell: (active: boolean): void => {
    if (get().mobileShell === active) return
    set({ mobileShell: active })
  },

  registerOverlay: (id: string, close: () => void): void => {
    const { stack } = get()
    if (stack.some((entry) => entry.id === id)) return
    set({ stack: [...stack, { id, close }] })
  },

  unregisterOverlay: (id: string): void => {
    const { stack } = get()
    const next = stack.filter((entry) => entry.id !== id)
    if (next.length === stack.length) return
    set({ stack: next })
  },

  closeTopmostOverlay: (): boolean => {
    const top = get().stack.at(-1)
    if (!top) return false
    // The owner's close fn owns the actual teardown (including its own
    // unregister). Guard so a throwing close never leaves the popstate
    // chain wedged — log it and drop the entry defensively.
    try {
      top.close()
    } catch (error) {
      get().unregisterOverlay(top.id)
      void logFrontendError({
        level: 'error',
        source: 'overlay-stack',
        message: `Overlay '${top.id}' close handler threw during popstate intercept`,
        stack: error instanceof Error ? error.stack : undefined
      })
    }
    return true
  }
}))

export interface OverlayRegistrationOptions {
  /**
   * Register only while the mobile web shell is active. Desktop keeps its
   * existing behavior: the registration is inert there, so no sentinel is
   * pushed and no Esc fallback applies.
   */
  mobileShellOnly?: boolean
}

/**
 * React hook: keep an overlay registered while `open` is true.
 *
 * Owners pass their close function; the hook handles open→register /
 * close→unregister transitions. When the overlay is closed by any path
 * (back button, X button, Esc, backdrop), the owner's own state change
 * flips `open` false and the effect unregisters. Back-triggered closes go
 * through the same owner close fn, so no path double-closes.
 *
 * `options.mobileShellOnly` makes the registration inert unless the mobile
 * shell flag is set (the owner's own close still runs the dirty / confirm
 * guards — pass the owner's close, never a bypass).
 */
export function useOverlayRegistration(
  id: string,
  open: boolean,
  close: () => void,
  options?: OverlayRegistrationOptions
): void {
  const mobileShellOnly = options?.mobileShellOnly === true
  const mobileShell = useOverlayStackStore((s) => s.mobileShell)
  const effectiveOpen = open && (!mobileShellOnly || mobileShell)

  // Keep the latest close closure in a ref so the store entry stays fresh
  // without re-registering (registration is keyed by id; churn would reorder
  // the stack and double-fire the open/close transitions).
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!effectiveOpen) return
    useOverlayStackStore.getState().registerOverlay(id, () => closeRef.current())
    return () => {
      useOverlayStackStore.getState().unregisterOverlay(id)
    }
  }, [id, effectiveOpen])
}

/**
 * Sentinel depth of a `history.state` value: the positive integer
 * `termulOverlayDepth` (or 1 when it is missing) when `termulOverlay === true`,
 * and 0 for anything else (route entries, null, malformed values).
 */
export function readOverlaySentinelDepth(state: unknown): number {
  if (typeof state !== 'object' || state === null) return 0
  const record = state as Record<string, unknown>
  if (record.termulOverlay !== true) return 0
  const depth = record.termulOverlayDepth
  return typeof depth === 'number' && Number.isInteger(depth) && depth > 0 ? depth : 1
}

export interface OverlayBackHandlerOptions {
  /**
   * Defer a reconcile run. Defaults to `requestAnimationFrame` (falling back
   * to `setTimeout(0)`), so it runs after a drawer row's own rAF-deferred
   * navigation has pushed its route entry. Tests inject a deterministic one.
   */
  schedule?: (run: () => void) => void
  /** Wait this long for the popstate of a consume traversal (default 1000). */
  traversalTimeoutMs?: number
}

const DEFAULT_TRAVERSAL_TIMEOUT_MS = 1000
/** Stop retrying a lost traversal after this many misses in a row. */
const MAX_CONSECUTIVE_LOST_TRAVERSALS = 3

function logOverlay(level: 'info' | 'warn', message: string, error?: unknown): void {
  void logFrontendError({
    level,
    source: 'overlay-stack',
    message,
    stack: error instanceof Error ? error.stack : undefined
  })
}

/** Legacy (desktop) popstate branch — unchanged while `mobileShell` is false. */
function handleLegacyPopState(): void {
  const store = useOverlayStackStore.getState()
  if (store.stack.length === 0) {
    // No overlay open: normal router navigation — do not touch history.
    return
  }

  const topId = store.stack.at(-1)?.id ?? 'unknown'
  const closed = store.closeTopmostOverlay()
  if (!closed) return

  // Durable boundary log: popstate consumed an overlay instead of the app.
  // No user data / secrets — overlay id only.
  const remaining = useOverlayStackStore.getState().stack
  void logFrontendError({
    level: 'warn',
    source: 'popstate-overlay',
    message: `Hardware back intercepted: closed topmost overlay '${topId}' (${remaining.length} remaining)`
  })

  // If overlays remain open, re-arm the sentinel so the next back pops an
  // overlay rather than navigating the app.
  if (remaining.length > 0) {
    try {
      history.pushState({ termulOverlay: true }, '')
    } catch {
      // History API unavailable/limited (iOS 100-call cap, sandboxed test
      // env): overlays still close via their visible controls.
    }
  }
}

/**
 * Install the app-root popstate listener for hardware-back overlay dismissal
 * (QA F5). Returns a detach function (used by tests and effect cleanup).
 *
 * Desktop / `mobileShell` false (legacy): when the first overlay opens, a
 * state entry `{ termulOverlay: true }` is pushed via `history.pushState` —
 * a state push, NOT a hash change, so the hash router's URL is untouched. A
 * hardware back pops that sentinel: popstate fires, we close the topmost
 * overlay, and — if overlays remain — push a new sentinel so the next back
 * still consumes an overlay.
 *
 * Mobile shell (managed): a coalesced reconciler keeps the number of
 * `termulOverlay` sentinels equal to the stack depth.
 * - The stack grew: push sentinels up to the depth (router state spread into
 *   each, so React Router reads the same `idx` and treats the pop as a no-op).
 * - A non-back close shrank it (X, Esc, scrim): consume with one
 *   `history.back()` (or `history.go(-k)` for k sentinels), but only while the
 *   current entry is our sentinel — never across a route entry, never touching
 *   `location.hash`.
 * - System back: close only the topmost overlay, then re-reconcile (a vetoed
 *   close arms a fresh sentinel).
 * Also adds an Esc fallback for overlays that do not handle Esc themselves.
 *
 * Detach removes every listener and the store subscription and cancels all
 * scheduled work and timers.
 */
export function installOverlayBackHandler(options: OverlayBackHandlerOptions = {}): () => void {
  const traversalTimeoutMs = options.traversalTimeoutMs ?? DEFAULT_TRAVERSAL_TIMEOUT_MS

  let disposed = false
  let reconcileScheduled = false
  let traversalPending = false
  let lostTraversals = 0
  let traversalTimer: ReturnType<typeof setTimeout> | null = null
  let frameHandle: number | null = null
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  const escTimers = new Set<ReturnType<typeof setTimeout>>()

  const runDeferred = (run: () => void): void => {
    if (options.schedule) {
      options.schedule(run)
      return
    }
    if (typeof requestAnimationFrame === 'function') {
      frameHandle = requestAnimationFrame(() => {
        frameHandle = null
        run()
      })
      return
    }
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null
      run()
    }, 0)
  }

  const clearTraversal = (): void => {
    traversalPending = false
    if (traversalTimer !== null) {
      clearTimeout(traversalTimer)
      traversalTimer = null
    }
  }

  const pushSentinels = (from: number, to: number): void => {
    try {
      for (let depth = from; depth <= to; depth += 1) {
        const routerState =
          typeof history.state === 'object' && history.state !== null ? history.state : {}
        history.pushState({ ...routerState, termulOverlay: true, termulOverlayDepth: depth }, '')
      }
    } catch (error) {
      // History API unavailable/limited (iOS rate cap, sandbox): overlays
      // still close via their visible controls. The next trigger retries.
      logOverlay(
        'warn',
        'Overlay history push failed; overlays close via their visible controls',
        error
      )
    }
  }

  const onTraversalTimeout = (): void => {
    traversalTimer = null
    if (disposed || !traversalPending) return
    traversalPending = false
    lostTraversals += 1
    logOverlay(
      'warn',
      `Overlay history traversal produced no popstate within ${traversalTimeoutMs}ms (miss ${lostTraversals})`
    )
    // Retry through the reconciler, but never in an endless loop when the
    // browser keeps ignoring the traversal.
    if (lostTraversals < MAX_CONSECUTIVE_LOST_TRAVERSALS) scheduleReconcile()
  }

  const startTraversal = (delta: number): void => {
    traversalPending = true
    traversalTimer = setTimeout(onTraversalTimeout, traversalTimeoutMs)
    try {
      if (delta === -1) history.back()
      else history.go(delta)
    } catch (error) {
      clearTraversal()
      logOverlay(
        'warn',
        'Overlay history traversal failed; overlays close via their visible controls',
        error
      )
    }
  }

  const reconcile = (): void => {
    const { mobileShell, stack } = useOverlayStackStore.getState()
    if (!mobileShell || traversalPending) return

    const desired = stack.length
    const actual = readOverlaySentinelDepth(history.state)
    if (desired > actual) {
      pushSentinels(actual + 1, desired)
    } else if (desired < actual) {
      startTraversal(desired - actual)
    }
  }

  function scheduleReconcile(): void {
    if (disposed || reconcileScheduled) return
    reconcileScheduled = true
    runDeferred(() => {
      reconcileScheduled = false
      if (disposed) return
      reconcile()
    })
  }

  /** Log a sentinel that is about to be skipped (nothing open above it). */
  const noteStaleSentinel = (): void => {
    const { mobileShell, stack } = useOverlayStackStore.getState()
    const depth = readOverlaySentinelDepth(history.state)
    if (mobileShell && stack.length === 0 && depth > 0) {
      logOverlay('info', `Skipping stale overlay history sentinel (depth ${depth})`)
    }
  }

  const handleManagedPopState = (): void => {
    lostTraversals = 0
    if (traversalPending) {
      // The popstate of our own consume traversal: nothing to close.
      clearTraversal()
      scheduleReconcile()
      return
    }

    const store = useOverlayStackStore.getState()
    const depth = readOverlaySentinelDepth(history.state)
    if (store.stack.length > depth) {
      const topId = store.stack.at(-1)?.id ?? 'unknown'
      if (store.closeTopmostOverlay()) {
        // Same durable boundary log as the legacy path.
        const remaining = useOverlayStackStore.getState().stack
        void logFrontendError({
          level: 'warn',
          source: 'popstate-overlay',
          message: `Hardware back intercepted: closed topmost overlay '${topId}' (${remaining.length} remaining)`
        })
      }
    } else {
      noteStaleSentinel()
    }
    // A vetoed close arms a fresh sentinel; a leftover one is skipped.
    scheduleReconcile()
  }

  const handlePopState = (): void => {
    if (useOverlayStackStore.getState().mobileShell) {
      handleManagedPopState()
      return
    }
    handleLegacyPopState()
  }

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.repeat || event.isComposing) return
    const { mobileShell, stack } = useOverlayStackStore.getState()
    if (!mobileShell) return
    const topId = stack.at(-1)?.id
    if (topId === undefined) return

    // Let every Esc handler run first (Radix layers, ConfirmDialog, the
    // palette, ...). They call preventDefault() and/or change the stack; only
    // when neither happened does nothing own this Esc, so close the topmost.
    const timer = setTimeout(() => {
      escTimers.delete(timer)
      if (disposed || event.defaultPrevented) return
      const current = useOverlayStackStore.getState()
      if (!current.mobileShell || current.stack.at(-1)?.id !== topId) return
      logOverlay('info', `Esc closed topmost overlay '${topId}'`)
      current.closeTopmostOverlay()
    }, 0)
    escTimers.add(timer)
  }

  const unsubscribe = useOverlayStackStore.subscribe((state, prev) => {
    if (state.stack.length !== prev.stack.length) {
      lostTraversals = 0
      scheduleReconcile()
    }
    if (state.mobileShell !== prev.mobileShell) {
      if (state.mobileShell) {
        // Also clears a sentinel left over from a reload.
        noteStaleSentinel()
        scheduleReconcile()
      } else {
        clearTraversal()
      }
    }
  })

  window.addEventListener('popstate', handlePopState)
  window.addEventListener('keydown', handleKeyDown, true)

  // Already on the mobile shell at install time (flag set before the handler):
  // reconcile once so a stale sentinel from a reload is cleared.
  if (useOverlayStackStore.getState().mobileShell) {
    noteStaleSentinel()
    scheduleReconcile()
  }

  return () => {
    disposed = true
    window.removeEventListener('popstate', handlePopState)
    window.removeEventListener('keydown', handleKeyDown, true)
    unsubscribe()
    clearTraversal()
    reconcileScheduled = false
    if (frameHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameHandle)
    }
    frameHandle = null
    if (fallbackTimer !== null) clearTimeout(fallbackTimer)
    fallbackTimer = null
    for (const timer of escTimers) clearTimeout(timer)
    escTimers.clear()
  }
}

/**
 * Push one sentinel history entry for the currently-open overlay stack.
 * Called when the stack goes 0 → 1 (first overlay opens) so the next
 * hardware back lands on popstate (closing the overlay) instead of leaving
 * the app. A state push, not a hash change — the router's URL is untouched.
 * Desktop (legacy) path only: on the mobile shell the reconciler owns this.
 */
export function pushOverlaySentinel(): void {
  try {
    history.pushState({ termulOverlay: true }, '')
  } catch {
    // Best-effort: failure degrades to visible-close-only behavior.
  }
}
