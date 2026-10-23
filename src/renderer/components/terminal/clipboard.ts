import type { Terminal } from '@xterm/xterm'
import type { MutableRefObject } from 'react'
import { isPlatformModifier } from '@/lib/platform'
import { decideTerminalClipboardKey } from './clipboard-key'

export { CLIPBOARD_RATE_LIMIT_MS } from './clipboard-key'

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
  const now = Date.now()
  const decision = decideTerminalClipboardKey({
    key: event.key,
    platformModifier: isPlatformModifier(event),
    hasSelection: () => terminal.hasSelection(),
    clipboardAvailable: () =>
      typeof navigator === 'undefined' || typeof navigator.clipboard !== 'undefined',
    now,
    lastClipboardOp: lastClipboardOpRef.current
  })

  switch (decision) {
    case null:
      return undefined
    case 'rate-limited':
      return false // Rate limited - prevent xterm handling but don't process
    case 'copy': {
      event.preventDefault()
      const selection = terminal.getSelection()
      if (!actions.copyRequiresNonEmptySelection || selection) {
        lastClipboardOpRef.current = now
        // Use the hook's copySelection for consistency
        void actions.copySelection()
      }
      return false
    }
    case 'interrupt':
      // No selection - allow xterm to send Ctrl+C (interrupt signal)
      return true
    case 'native-paste':
      // In a non-secure context (HTTP+bare-IP — GH-588) `navigator.clipboard`
      // is undefined and the facade's paste-event fallback can't fire
      // because preventDefault() here would suppress the very paste event it
      // waits on. Degrade to xterm's native paste (the browser paste event
      // on xterm's helper textarea); the secure-context path keeps the
      // bracketed + sanitized paste via the facade (pasteFromClipboard).
      lastClipboardOpRef.current = now
      return true
    case 'paste':
      event.preventDefault()
      lastClipboardOpRef.current = now
      // Use the hook's pasteFromClipboard for consistency
      void actions.pasteFromClipboard()
      return false
    case 'select-all':
      terminal.selectAll()
      return false
  }
}
