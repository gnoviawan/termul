import { type RefObject, useEffect } from 'react'
import { type OverlayEntry, useOverlayStackStore } from '@/stores/overlay-stack-store'

/** Overlay ids that never make the shell body inert. See `isInertExemptOverlay`. */
const EXEMPT_OVERLAY_IDS: ReadonlySet<string> = new Set(['agent-launcher'])
const EXEMPT_OVERLAY_PREFIXES: readonly string[] = [
  'confirm-dialog:',
  'message-actions-menu:',
  'create-snapshot-modal:',
  'new-project-modal:'
]

/**
 * Whether overlay `id` leaves the shell body interactive while it is open.
 *
 * Every other registered overlay is a portaled Radix surface or a sheet that
 * sits outside the body, so it makes the body inert. These kinds are exempt:
 * - `agent-launcher` renders inside the body (in `<main>`), so inerting the
 *   body would inert the launcher itself;
 * - `confirm-dialog:*` is a `fixed inset-0` div rendered in place, and its
 *   instances (the Git tab's "Discard changes") sit inside the body;
 * - `create-snapshot-modal:*` and `new-project-modal:*` are `fixed inset-0`
 *   divs rendered in place too, and the Snapshots page, a routed child of the
 *   body (`<Outlet />`), opens both;
 * - `message-actions-menu:*` opens mid-gesture, with the finger still down on
 *   its own trigger, and inerting that trigger mid-gesture is unverified on a
 *   touch device.
 *
 * An overlay that renders inside the shell body must be added here, or it goes
 * inert along with the rest of the body and can no longer be tapped or focused.
 * The producers' tests assert their own id against this predicate.
 */
export function isInertExemptOverlay(id: string): boolean {
  return (
    EXEMPT_OVERLAY_IDS.has(id) || EXEMPT_OVERLAY_PREFIXES.some((prefix) => id.startsWith(prefix))
  )
}

function hasBlockingOverlay(stack: readonly OverlayEntry[]): boolean {
  return stack.some((entry) => !isInertExemptOverlay(entry.id))
}

/**
 * Keep the shell body inert while a blocking overlay is open.
 *
 * Radix `hideOthers` (aria-hidden) skips every `[aria-live]` node, including
 * the chat log's `aria-live="off"`, and does not descend into it, so the log
 * and all its messages stay reachable by a screen reader behind a modal sheet.
 * `inert` on the body wrapper removes them from the accessibility tree and from
 * focus and pointer input. The live region, header, drawer and key bar sit
 * outside the wrapper and stay live.
 *
 * Imperative on purpose, with no React state or selector: a stack change must
 * not re-render the shell (see `layouts/use-workspace-overlay-back-stack.ts`),
 * and the attribute must come off in the same tick the last blocking overlay
 * unregisters. React flushes that passive cleanup before a `flushSync` return
 * and before Radix's `setTimeout(0)` focus return, so a focus move that follows
 * a sheet closing (the + sheet's Mention and Commands, a sheet returning focus
 * to an opener inside the body) lands on an interactive element. React 18 does
 * not render a boolean `inert` prop, hence `setAttribute`.
 *
 * Does nothing while `ref.current` is null. Cleanup unsubscribes and clears the
 * attribute.
 */
export function useInertBehindOverlays(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    // The element this effect last touched, so cleanup still reaches it after
    // React has already detached the ref on unmount.
    let applied: HTMLElement | null = null

    const apply = (stack: readonly OverlayEntry[]): void => {
      const element = ref.current
      if (!element) return
      applied = element
      if (hasBlockingOverlay(stack)) element.setAttribute('inert', '')
      else element.removeAttribute('inert')
    }

    apply(useOverlayStackStore.getState().stack)
    const unsubscribe = useOverlayStackStore.subscribe((state, prev) => {
      if (state.stack !== prev.stack) apply(state.stack)
    })

    return () => {
      unsubscribe()
      applied?.removeAttribute('inert')
    }
  }, [ref])
}
