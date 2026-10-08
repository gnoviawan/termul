/**
 * Focus return for mobile sheets, across components.
 *
 * Radix returns focus on close only to a `Dialog.Trigger`. Our openers are
 * plain buttons that set state, and the opener and the sheet often live in
 * different components (the header button opens the Git sheet in
 * `WorkspaceLayout`), so focus fell to `<body>`. iOS Safari also does not focus
 * a tapped button, so reading `document.activeElement` at open time cannot
 * replace an explicit record.
 *
 * Usage, keyed by the overlay id (`files-sheet`, `git-sheet`, ...):
 * - the opener calls `recordSheetOpener(id, event.currentTarget)` before opening;
 * - a flow that navigates somewhere (a file opened) calls
 *   `setSheetFocusDestination(id, el)` before closing;
 * - the `SheetContent` takes `onCloseAutoFocus={sheetCloseAutoFocus(id)}`.
 */

import { logFrontendError } from '@/lib/log-api'

const LOG_SOURCE = 'sheet-focus-return'

/**
 * An editor or terminal surface. Focusing one raises the on-screen keyboard, so
 * no focus-return path may land on one.
 */
const NEVER_FOCUS_SELECTOR = '.xterm, .cm-editor, .ProseMirror'

const openers = new Map<string, HTMLElement>()
const destinations = new Map<string, HTMLElement>()

/** Remember the control that opened sheet `id`. Overwrites any earlier opener. */
export function recordSheetOpener(id: string, opener: HTMLElement | null | undefined): void {
  if (opener) openers.set(id, opener)
}

/**
 * Set where focus goes when sheet `id` closes, instead of the opener. One shot:
 * it is consumed by the next close of that sheet whether or not it was used.
 */
export function setSheetFocusDestination(id: string, destination: HTMLElement | null): void {
  if (destination) destinations.set(id, destination)
  else destinations.delete(id)
}

function isFocusReturnTarget(el: HTMLElement | undefined): el is HTMLElement {
  if (!el) return false
  return el.isConnected && el.closest(NEVER_FOCUS_SELECTOR) === null
}

/**
 * Build the `onCloseAutoFocus` handler for sheet `id`.
 *
 * Always prevents Radix's default. Then:
 * 1. focus already sits on a connected element other than `body` (a rename
 *    input autofocused, an alert dialog opened): leave it;
 * 2. else focus the connected destination;
 * 3. else focus the connected opener;
 * 4. else leave focus alone and log at `info` (sheet id only). Steps 2 and 3
 *    count only when focus actually landed, so a disabled target falls through.
 *
 * Radix fires this in a `setTimeout(0)` after the content unmounts, which is
 * why a focus move made by the same click handler has already happened.
 */
export function sheetCloseAutoFocus(id: string): (event: Event) => void {
  return (event) => {
    event.preventDefault()
    const destination = destinations.get(id)
    const opener = openers.get(id)
    destinations.delete(id)

    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return

    // A connected target can still refuse focus (a disabled opener, a hidden or
    // inert subtree), and `focus()` then no-ops silently. Check that focus took
    // effect before settling, so the next candidate is tried and a miss is logged.
    for (const target of [destination, opener]) {
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

/** @internal test helper: forget every recorded opener and destination. */
export function _resetSheetFocusReturnForTests(): void {
  openers.clear()
  destinations.clear()
}
