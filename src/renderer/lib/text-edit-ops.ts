/**
 * Text edit operations for the global context menu.
 *
 * Fills the gap left by the existing clipboard facade: there was no helper for
 * inserting pasted text into a focused input/textarea/contentEditable or for
 * cutting (copy + delete) the current selection. These helpers wrap
 * `document.execCommand('insertText'|'delete'|'selectAll')` + the existing
 * `clipboardApi` / `copyText` so the global menu's Copy/Cut/Paste/Select All
 * items behave the same on desktop and web.
 *
 * Never throws: a clipboard or DOM-insertion failure is logged once via
 * `logFrontendError` so the degradation survives a closed DevTools, and the
 * menu simply closes.
 */

import { clipboardApi } from '@/lib/api'
import { copyText } from '@/lib/copy-text'
import { logFrontendError } from '@/lib/log-api'

function logFailure(operation: string, error: unknown): void {
  void logFrontendError({
    level: 'error',
    message: `${operation} failed: ${String(error)}`,
    source: 'lib/text-edit-ops'
  })
}

/**
 * The currently focused editable element (input/textarea/contentEditable), or
 * `null` when focus is not on an editable.
 */
function getFocusedEditable(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const el = document.activeElement
  if (!el) return null
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return el
  }
  return null
}

/**
 * True when the focused element is a mutable editable (not readOnly, not
 * disabled). Used to gate Cut/Paste/Select All — `execCommand('delete'|
 * 'insertText')` no-ops on readonly/disabled inputs, so enabling those items
 * would mislead the user. Copy still works on readonly selections (Copy only
 * needs `hasSelection`).
 */
function isMutableEditable(el: HTMLElement | null): boolean {
  if (!el) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return !el.readOnly && !el.disabled
  }
  return el.isContentEditable
}

/**
 * The selected text from the focused input/textarea (via selectionStart/End)
 * or from window.getSelection() for contentEditable / generic page text.
 * P2: selections inside `<input>`/`<textarea>` are NOT reflected by
 * `window.getSelection()` (they use selectionStart/selectionEnd), so we check
 * the focused editable first.
 */
function getSelectionText(): string {
  if (typeof document === 'undefined') return ''
  const el = document.activeElement
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart
    const end = el.selectionEnd
    if (start !== null && end !== null && start !== end) {
      return el.value.substring(start, end)
    }
    return ''
  }
  if (typeof window === 'undefined' || !window.getSelection) return ''
  const sel = window.getSelection()
  return sel ? sel.toString() : ''
}

/**
 * Copy the current selection to the clipboard. Returns `false` when no
 * selection exists or the copy failed (logged via log-api).
 */
export async function copySelection(): Promise<boolean> {
  const text = getSelectionText()
  if (!text) return false
  try {
    return await copyText(text)
  } catch (error) {
    logFailure('copySelection', error)
    return false
  }
}

/**
 * Cut the current selection: copy it to the clipboard, then delete it from the
 * focused editable via `execCommand('delete')`. Only operates when a mutable
 * editable is focused (cutting readonly text has no meaningful target).
 * P1: only calls `execCommand('delete')` when the copy actually succeeded —
 * never deletes text that wasn't copied (no silent data loss). Returns `false`
 * when there is no selection, no mutable editable, or the copy failed.
 */
export async function cutSelection(): Promise<boolean> {
  const text = getSelectionText()
  if (!text) return false
  const editable = getFocusedEditable()
  if (!isMutableEditable(editable)) return false
  try {
    const copied = await copyText(text)
    if (!copied) return false
    return document.execCommand('delete')
  } catch (error) {
    logFailure('cutSelection', error)
    return false
  }
}

/**
 * Paste clipboard text into the focused editable at the caret. Reads the
 * clipboard via `clipboardApi` (Tauri IPC on desktop, Async Clipboard API /
 * paste-event fallback on web) and inserts it with
 * `execCommand('insertText', false, text)`.
 * P7: focus may move between the async clipboard read and the insert (menu
 * closing, async gap) — re-focus the editable before inserting so the paste
 * lands in the right element. Returns `false` when no mutable editable is
 * focused, the clipboard read failed, or the insert did not take effect.
 */
export async function pasteIntoFocused(): Promise<boolean> {
  const editable = getFocusedEditable()
  if (!editable || !isMutableEditable(editable)) return false
  try {
    const res = await clipboardApi.readText()
    if (!res.success || !res.data) return false
    editable.focus()
    return document.execCommand('insertText', false, res.data)
  } catch (error) {
    logFailure('pasteIntoFocused', error)
    return false
  }
}

/**
 * Select all text in the focused editable (input.select() for
 * input/textarea, `execCommand('selectAll')` for contentEditable).
 * P9: when no editable is focused, returns `false` — does NOT fall back to a
 * document-wide `execCommand('selectAll')` (would select UI chrome). The menu
 * item is also disabled when no mutable editable is focused.
 */
export function selectAllFocused(): boolean {
  try {
    const editable = getFocusedEditable()
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      editable.select()
      return true
    }
    if (editable instanceof HTMLElement && editable.isContentEditable) {
      return document.execCommand('selectAll')
    }
    return false
  } catch (error) {
    logFailure('selectAllFocused', error)
    return false
  }
}
