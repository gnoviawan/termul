/**
 * Focus return for mobile sheets, across components. The one mechanism for the
 * shell's drawer and ⋯ / project / Git / Files sheets.
 *
 * Radix returns focus on close only to a `Dialog.Trigger`. Our openers are
 * plain buttons that set state, and the opener and the sheet often live in
 * different components (the changed-files bar opens the Git sheet in
 * `WorkspaceLayout`), so focus fell to `<body>`. iOS Safari also does not focus
 * a tapped button, so reading `document.activeElement` at open time cannot
 * replace an explicit record.
 *
 * Usage, keyed by the overlay id (`files-sheet`, `git-sheet`, `mobile-drawer`...):
 * - the opener calls `recordSheetOpener(id, event.currentTarget, fallback?)`
 *   before opening; the optional fallback is tried when the opener is gone (the
 *   attention pill unmounts once nothing needs the user, so the drawer falls
 *   back to ☰). Each open records its own opener and the next close consumes
 *   it, so an open that records none restores nothing rather than reusing the
 *   previous open's opener;
 * - a flow that navigates somewhere calls `setSheetFocusDestination(id, target)`
 *   before closing. `target` is an element, or a resolver that runs when the
 *   sheet has closed, for a destination that only exists after the close
 *   commits (a chat tab becomes visible in the same commit as the close);
 * - the `SheetContent` takes `onCloseAutoFocus={sheetCloseAutoFocus(id)}`.
 */

import { logFrontendError } from '@/lib/log-api'

const LOG_SOURCE = 'sheet-focus-return'

/**
 * An editor or terminal surface. Focusing one raises the on-screen keyboard, so
 * no focus-return path may land on one.
 */
const NEVER_FOCUS_SELECTOR = '.xterm, .cm-editor, .ProseMirror'

/** Where focus goes after a navigation: an element, or a resolver run at close time. */
type SheetFocusDestination = HTMLElement | (() => HTMLElement | null)

const openers = new Map<string, HTMLElement>()
const fallbacks = new Map<string, HTMLElement>()
const destinations = new Map<string, SheetFocusDestination>()

/**
 * Remember the control that opened sheet `id`, and optionally a `fallback`
 * tried after it. One shot, like the destination: the next close of that sheet
 * consumes both. Overwrites any earlier opener and replaces the fallback (a
 * record without one clears the old one), and drops a destination left over
 * from an earlier open that was abandoned (a file finished opening after the
 * sheet was already dismissed), so a stale destination cannot steal focus from
 * this open's opener. A record with no opener changes nothing.
 */
export function recordSheetOpener(
  id: string,
  opener: HTMLElement | null | undefined,
  fallback?: HTMLElement | null
): void {
  if (!opener) return
  openers.set(id, opener)
  if (fallback) fallbacks.set(id, fallback)
  else fallbacks.delete(id)
  destinations.delete(id)
}

/**
 * Set where focus goes when sheet `id` closes, instead of the opener. One shot:
 * it is consumed by the next close of that sheet whether or not it was used.
 * A resolver is called at close time, never here.
 */
export function setSheetFocusDestination(
  id: string,
  destination: SheetFocusDestination | null
): void {
  if (destination) destinations.set(id, destination)
  else destinations.delete(id)
}

function isFocusReturnTarget(el: HTMLElement | null | undefined): el is HTMLElement {
  if (!el) return false
  return el.isConnected && el.closest(NEVER_FOCUS_SELECTOR) === null
}

/**
 * Take (and forget) sheet `id`'s destination. A resolver that throws counts as
 * no destination and is logged with the sheet id only.
 */
function takeDestination(id: string): HTMLElement | null {
  const destination = destinations.get(id)
  destinations.delete(id)
  if (typeof destination !== 'function') return destination ?? null
  try {
    return destination()
  } catch {
    void logFrontendError({
      level: 'error',
      source: LOG_SOURCE,
      message: `Sheet focus destination resolver threw: ${id}`
    })
    return null
  }
}

/**
 * Build the `onCloseAutoFocus` handler for sheet `id`.
 *
 * Always prevents Radix's default, and consumes the sheet's opener and fallback
 * whichever step below settles, so a later open that records none cannot return
 * focus to this open's opener. Then:
 * 1. focus already sits on a connected element other than `body` (a rename
 *    input autofocused, an alert dialog opened, a prompt that grabbed focus):
 *    leave it;
 * 2. else focus the connected destination (a resolver is evaluated now);
 * 3. else focus the connected opener;
 * 4. else focus the connected fallback;
 * 5. else leave focus alone and log at `info` (sheet id only). Steps 2 to 4
 *    count only when focus actually landed, so a disabled target falls through.
 *
 * Radix fires this in a `setTimeout(0)` after the content unmounts, which is
 * why a focus move made by the same click handler has already happened.
 */
export function sheetCloseAutoFocus(id: string): (event: Event) => void {
  return (event) => {
    event.preventDefault()
    // The opener and fallback belong to this open. Take them before any early
    // return so they cannot leak into the next close.
    const opener = openers.get(id)
    const fallback = fallbacks.get(id)
    openers.delete(id)
    fallbacks.delete(id)
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) {
      // Consume the destination even though it goes unused, so it cannot leak
      // into the next close; a resolver is not evaluated.
      destinations.delete(id)
      return
    }
    const destination = takeDestination(id)

    // A connected target can still refuse focus (a disabled opener, a hidden or
    // inert subtree), and `focus()` then no-ops silently. Check that focus took
    // effect before settling, so the next candidate is tried and a miss is logged.
    for (const target of [destination, opener, fallback]) {
      if (!isFocusReturnTarget(target)) continue
      target.focus()
      if (document.activeElement === target) return
    }
    void logFrontendError({
      level: 'info',
      source: LOG_SOURCE,
      message: `Sheet closed with no connected focus target: ${id}`
    })
  }
}

/** @internal test helper: forget every recorded opener, fallback and destination. */
export function _resetSheetFocusReturnForTests(): void {
  openers.clear()
  fallbacks.clear()
  destinations.clear()
}
