/**
 * Focus return after a `ConfirmDialog` that a mobile drawer row raised.
 *
 * `ConfirmDialog` is shared with desktop and never takes or returns focus, so
 * when it unmounts (Cancel, Close or Esc) focus falls to `<body>`. The drawer
 * closes before the confirm shows (a hand-off, so the confirm is not covered by
 * the drawer's overlay) and wants focus back on its opener afterwards.
 *
 * The dialog is observable only through the overlay stack, where each open
 * `ConfirmDialog` is registered under `confirm-dialog:<id>` (mobile shell
 * only), and through its root's `data-sibling-dialog` attribute, which stays in
 * the DOM for the 0.15s exit animation.
 */

import { CONFIRM_DIALOG_OVERLAY_PREFIX } from '@/components/ConfirmDialog'
import { logFrontendError } from '@/lib/log-api'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'

const LOG_SOURCE = 'confirm-focus-return'

/** How long to wait for a confirm to open before giving up (it opens next render). */
export const CONFIRM_APPEAR_TIMEOUT_MS = 1000

/** How long to wait for the closed confirm to leave the DOM (exit animation is 0.15s). */
export const CONFIRM_EXIT_TIMEOUT_MS = 500

const SIBLING_DIALOG_SELECTOR = '[data-sibling-dialog]'

function isConfirmOpen(): boolean {
  return useOverlayStackStore
    .getState()
    .stack.some((entry) => entry.id.startsWith(CONFIRM_DIALOG_OVERLAY_PREFIX))
}

function focusIsLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

/**
 * Wait for a confirm to open and then close, and call `restore` once it has
 * left the DOM, but only if focus was lost to `<body>` (a user or a dialog that
 * already put focus somewhere real is never overridden). `restore` returns
 * whether focus landed; `false` is logged at `info`.
 *
 * Gives up, without calling `restore`, when no confirm opens within about a
 * second, or when the closed confirm is still in the DOM after about half a
 * second (another dialog may own focus). Always unsubscribes from the overlay
 * store. Returns a cancel function for callers that unmount first.
 */
export function returnFocusAfterConfirm(restore: () => boolean): () => void {
  let done = false
  let sawConfirm = false
  let appearTimer: ReturnType<typeof setTimeout> | null = null
  let frame: number | null = null
  let unsubscribe: (() => void) | null = null

  const finish = (): void => {
    if (done) return
    done = true
    unsubscribe?.()
    unsubscribe = null
    if (appearTimer !== null) clearTimeout(appearTimer)
    appearTimer = null
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }

  const restoreIfFocusLost = (): void => {
    if (!focusIsLost()) return
    if (!restore()) {
      void logFrontendError({
        level: 'info',
        source: LOG_SOURCE,
        message: 'Confirm closed with no connected focus target'
      })
    }
  }

  const waitForExit = (): void => {
    const deadline = Date.now() + CONFIRM_EXIT_TIMEOUT_MS
    const poll = (): void => {
      frame = null
      if (done) return
      if (!document.querySelector(SIBLING_DIALOG_SELECTOR)) {
        finish()
        restoreIfFocusLost()
        return
      }
      if (Date.now() >= deadline) {
        finish()
        void logFrontendError({
          level: 'info',
          source: LOG_SOURCE,
          message: 'Confirm still in the DOM after closing; focus was not restored'
        })
        return
      }
      frame = requestAnimationFrame(poll)
    }
    poll()
  }

  const onStackChange = (): void => {
    if (done || frame !== null) return
    if (isConfirmOpen()) {
      sawConfirm = true
      return
    }
    if (!sawConfirm) return
    // The confirm closed. Stop watching the store; the DOM decides from here.
    unsubscribe?.()
    unsubscribe = null
    if (appearTimer !== null) clearTimeout(appearTimer)
    appearTimer = null
    waitForExit()
  }

  unsubscribe = useOverlayStackStore.subscribe(onStackChange)
  appearTimer = setTimeout(() => {
    appearTimer = null
    if (!sawConfirm) finish()
  }, CONFIRM_APPEAR_TIMEOUT_MS)
  // A confirm that is already open counts as seen.
  onStackChange()

  return finish
}
