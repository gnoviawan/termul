/**
 * GPUIX answers a synchronous read only when the GPUI UI thread gets to it,
 * and throws once it has waited 2 s (`recv_ui_response`). Compat reads focus,
 * scroll offsets, boxes and the tree from shared code's DOM calls, often
 * inside a native event dispatch or a library's scroll handler. Under a heavy
 * frame load (F3's 8-chat stream-storm) those throws escaped, and the
 * runtime-error overlay replaced the app: a key handler's focus read, then
 * TanStack Virtual's `scrollLeft`. For the DOM caller, "no answer" is what a
 * detached element returns: no focused element, no scroll offset, no box, no
 * tree. live-reads memoizes it for the rest of the task, so one busy frame
 * costs one 2 s wait, not one per read.
 */

import type { CompatRenderer } from './live-reads'

const UI_TIMEOUT = /^Timed out after \d+ seconds? waiting for the /

export function isUiTimeout(err: unknown): boolean {
  return err instanceof Error && UI_TIMEOUT.test(err.message)
}

function answer<T>(read: () => T, none: T): T {
  try {
    return read()
  } catch (err) {
    if (isUiTimeout(err)) return none
    throw err
  }
}

/** `renderer` for compat, with every synchronous read answering "none" on a UI-thread timeout. */
export function busyTolerantReads(renderer: CompatRenderer): CompatRenderer {
  return {
    focusElement: (id) => renderer.focusElement(id),
    blur: () => renderer.blur(),
    scrollTo: (id, x, y) => renderer.scrollTo(id, x, y),
    scrollIntoView: (id) => renderer.scrollIntoView(id),
    getFocusedElementId: () => answer(() => renderer.getFocusedElementId(), null),
    getScrollOffset: (id) => answer(() => renderer.getScrollOffset(id), null),
    getElementBounds: (id) => answer(() => renderer.getElementBounds(id), null),
    getAutomationTree: () => answer(() => renderer.getAutomationTree(), 'null')
  }
}
