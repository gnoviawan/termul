export const CLIPBOARD_RATE_LIMIT_MS = 100

/**
 * What a key pressed with the platform modifier (⌘ on macOS, Ctrl elsewhere)
 * does in a terminal:
 * - `copy`: copy the selection, swallow the key.
 * - `interrupt`: no selection, so the key reaches the shell (Ctrl+C = SIGINT).
 * - `paste`: paste through the clipboard facade, swallow the key.
 * - `native-paste`: no Async Clipboard API (HTTP + bare IP, GH-588), so the
 *   terminal's own paste event handles it.
 * - `select-all`: select the whole buffer, swallow the key.
 * - `rate-limited`: within {@link CLIPBOARD_RATE_LIMIT_MS} of the last
 *   clipboard operation, swallow the key and do nothing.
 * - `null`: not a clipboard key; the caller continues its own dispatch.
 */
export type TerminalClipboardKeyDecision =
  | 'copy'
  | 'interrupt'
  | 'paste'
  | 'native-paste'
  | 'select-all'
  | 'rate-limited'
  | null

export interface TerminalClipboardKeyInput {
  /** `KeyboardEvent.key`, any case. */
  key: string
  platformModifier: boolean
  /** Read only for C, after the rate limit. */
  hasSelection: () => boolean
  /** Whether `navigator.clipboard` (or the runtime's equivalent) exists. Read only for V. */
  clipboardAvailable: () => boolean
  now: number
  lastClipboardOp: number
}

/** The clipboard keymap both terminal renderers share. Pure: the caller performs the action. */
export function decideTerminalClipboardKey(
  input: TerminalClipboardKeyInput
): TerminalClipboardKeyDecision {
  if (!input.platformModifier) return null
  if (input.now - input.lastClipboardOp < CLIPBOARD_RATE_LIMIT_MS) return 'rate-limited'
  switch (input.key.toLowerCase()) {
    case 'c':
      return input.hasSelection() ? 'copy' : 'interrupt'
    case 'v':
      return input.clipboardAvailable() ? 'paste' : 'native-paste'
    case 'a':
      return 'select-all'
  }
  return null
}
