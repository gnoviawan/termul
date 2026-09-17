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
  /** Register an overlay as open; marks it topmost. Idempotent by id. */
  registerOverlay: (id: string, close: () => void) => void
  /** Unregister an overlay (idempotent; missing id is a no-op). */
  unregisterOverlay: (id: string) => void
  /** Close the topmost overlay via its registered close fn. No-op when empty. */
  closeTopmostOverlay: () => boolean
}

export const useOverlayStackStore = create<OverlayStackState>((set, get) => ({
  stack: [],

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

/**
 * React hook: keep an overlay registered while `open` is true.
 *
 * Owners pass their close function; the hook handles open→register /
 * close→unregister transitions. When the overlay is closed by any path
 * (back button, X button, Esc, backdrop), the owner's own state change
 * flips `open` false and the effect unregisters. Back-triggered closes go
 * through the same owner close fn, so no path double-closes.
 */
export function useOverlayRegistration(id: string, open: boolean, close: () => void): void {
  // Keep the latest close closure in a ref so the store entry stays fresh
  // without re-registering (registration is keyed by id; churn would reorder
  // the stack and double-fire the open/close transitions).
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!open) return
    useOverlayStackStore.getState().registerOverlay(id, () => closeRef.current())
    return () => {
      useOverlayStackStore.getState().unregisterOverlay(id)
    }
  }, [id, open])
}

/**
 * Install the app-root popstate listener for hardware-back overlay dismissal
 * (QA F5). Returns a detach function (used by tests; the app root never
 * detaches).
 *
 * Sentinel bookkeeping (per spec Design Notes): when the first overlay opens,
 * a state entry `{ termulOverlay: true }` is pushed via
 * `history.pushState(state, '')` — a state push, NOT a hash change, so the
 * hash router's URL is untouched. A hardware back then pops that sentinel:
 * popstate fires, we close the topmost overlay, and — if overlays remain —
 * push a new sentinel so the next back still consumes an overlay. When the
 * stack empties, sentinels are exhausted and normal back behavior resumes.
 */
export function installOverlayBackHandler(): () => void {
  const handlePopState = (): void => {
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

  window.addEventListener('popstate', handlePopState)
  return () => window.removeEventListener('popstate', handlePopState)
}

/**
 * Push one sentinel history entry for the currently-open overlay stack.
 * Called when the stack goes 0 → 1 (first overlay opens) so the next
 * hardware back lands on popstate (closing the overlay) instead of leaving
 * the app. A state push, not a hash change — the router's URL is untouched.
 */
export function pushOverlaySentinel(): void {
  try {
    history.pushState({ termulOverlay: true }, '')
  } catch {
    // Best-effort: failure degrades to visible-close-only behavior.
  }
}
