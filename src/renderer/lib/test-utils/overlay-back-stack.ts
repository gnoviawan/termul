/**
 * Shared helpers for tests that exercise the mobile overlay back stack
 * (`stores/overlay-stack-store`) against the REAL jsdom history.
 *
 * jsdom history persists across the tests of one file and `history.go(n)` is
 * asynchronous (it fires one `popstate` whose `state` is the target entry's
 * state). Assert traversal counts with spies on a freshly armed state — never
 * by counting entries below the current one.
 *
 * NOTE: this file is covered by `typecheck:web` — import only plain functions
 * and public types (no vitest globals).
 */
import { act, waitFor } from '@testing-library/react'
import {
  installOverlayBackHandler,
  type OverlayBackHandlerOptions,
  readOverlaySentinelDepth,
  useOverlayStackStore
} from '@/stores/overlay-stack-store'

const POPSTATE_TIMEOUT_MS = 2000

/**
 * Put the overlay stack in a clean mobile-shell state and install the back
 * handler: resets the store to `{ stack: [], mobileShell: true }`, clears a
 * stale sentinel left by an earlier test, installs the handler and returns a
 * cleanup that detaches it and resets the store to
 * `{ stack: [], mobileShell: false }`.
 *
 * Use it only in tests that do NOT render WorkspaceLayout — that layout
 * installs its own handler, and two handlers would close two overlays per
 * back press.
 */
export function armMobileOverlayBackStack(options?: OverlayBackHandlerOptions): () => void {
  useOverlayStackStore.setState({ stack: [], mobileShell: true })
  window.history.replaceState(null, '', window.location.hash || '#/')
  const detach = installOverlayBackHandler(options)
  return () => {
    detach()
    useOverlayStackStore.setState({ stack: [], mobileShell: false })
  }
}

/** Resolve once the current history entry carries a sentinel of depth `n`. */
export async function waitForSentinelDepth(n: number): Promise<void> {
  await waitFor(() => {
    const depth = readOverlaySentinelDepth(window.history.state)
    if (depth !== n) throw new Error(`Expected overlay sentinel depth ${n}, got ${depth}`)
  })
}

/**
 * Let the reconciler's default `requestAnimationFrame` scheduling (and any
 * consume traversal it starts) settle. Use it before asserting that NO
 * traversal or push happened.
 */
export async function settleOverlayBackStack(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
  })
}

/**
 * A system back press: the real `history.back()` inside `act`, resolving
 * after the next `popstate`. Rejects when no popstate arrives (the entry
 * below does not exist), so a dead press fails loudly instead of hanging.
 */
export async function pressSystemBack(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('popstate', onPopState)
        reject(new Error(`pressSystemBack: no popstate within ${POPSTATE_TIMEOUT_MS}ms`))
      }, POPSTATE_TIMEOUT_MS)
      function onPopState(): void {
        clearTimeout(timer)
        resolve()
      }
      window.addEventListener('popstate', onPopState, { once: true })
      window.history.back()
    })
  })
}
