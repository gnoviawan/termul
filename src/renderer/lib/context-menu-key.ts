/**
 * Keyboard and button paths into a Radix context menu, which only opens on a
 * `contextmenu` event.
 */

/** Shift+F10 or the context-menu key: the keyboard way to ask for a context menu. */
export function isContextMenuKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

/**
 * Sends a `contextmenu` event from `element`, placed at its bottom-left
 * corner, so the context menu around it opens there. Used for the keyboard
 * keys (WebKit does not send the event for Shift+F10) and for "More" buttons.
 */
export function openContextMenuFrom(element: HTMLElement): void {
  const rect = element.getBoundingClientRect()
  element.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left,
      clientY: rect.bottom
    })
  )
}
