import type { Terminal } from '@xterm/xterm'
import type { MutableRefObject } from 'react'
import { isPlatformModifier } from '@/lib/platform'

export const CLIPBOARD_RATE_LIMIT_MS = 100

export interface TerminalClipboardKeyActions {
  /** Copy current selection (Ctrl/⌘+C). */
  copySelection: () => void
  /** Paste via the clipboard facade (Ctrl/⌘+V). */
  pasteFromClipboard: () => void
  /**
   * When true the copy path only stamps the rate limiter and invokes
   * copySelection when getSelection() returns a non-empty string; when false
   * it proceeds on hasSelection() alone.
   */
  copyRequiresNonEmptySelection?: boolean
}

/**
 * Clipboard key dispatch for the terminal's attachCustomKeyEventHandler.
 *
 * Handles copy/paste/select-all when the platform modifier is held.
 * macOS convention: ⌘+C/V/A for clipboard operations, Ctrl+C = SIGINT.
 * Windows/Linux convention: Ctrl+C/V/A for everything.
 *
 * Returns the attach handler's verdict (true = let xterm handle, false =
 * prevent xterm handling), or undefined when the event is not a
 * clipboard-modified key and the caller should continue its own dispatch.
 */
export function handleTerminalClipboardKey(
  event: KeyboardEvent,
  terminal: Terminal,
  lastClipboardOpRef: MutableRefObject<number>,
  actions: TerminalClipboardKeyActions
): boolean | undefined {
  if (!isPlatformModifier(event)) {
    return undefined
  }

  // Rate limit check
  const now = Date.now()
  if (now - lastClipboardOpRef.current < CLIPBOARD_RATE_LIMIT_MS) {
    return false // Rate limited - prevent xterm handling but don't process
  }

  switch (event.key.toLowerCase()) {
    case 'c':
      // Copy: if selection exists, copy and prevent xterm handling
      // Otherwise allow xterm to handle (for interrupt signal)
      if (terminal.hasSelection()) {
        event.preventDefault()
        const selection = terminal.getSelection()
        if (!actions.copyRequiresNonEmptySelection || selection) {
          lastClipboardOpRef.current = now
          // Use the hook's copySelection for consistency
          void actions.copySelection()
        }
        return false
      }
      // No selection - allow xterm to send Ctrl+C (interrupt signal)
      return true

    case 'v':
      // Paste: read clipboard and paste to terminal. In a non-secure
      // context (HTTP+bare-IP — GH-588), `navigator.clipboard` is
      // undefined and the facade's paste-event fallback can't fire
      // because preventDefault() here would suppress the very paste
      // event it waits on. Degrade to xterm's native paste (the browser
      // paste event on xterm's helper textarea) in that case; the
      // secure-context path keeps the bracketed + sanitized paste via
      // the facade (pasteFromClipboard).
      if (typeof navigator !== 'undefined' && typeof navigator.clipboard === 'undefined') {
        lastClipboardOpRef.current = now
        return true
      }
      event.preventDefault()
      lastClipboardOpRef.current = now
      // Use the hook's pasteFromClipboard for consistency
      void actions.pasteFromClipboard()
      return false

    case 'a':
      // Select all
      terminal.selectAll()
      return false
  }

  return undefined
}
