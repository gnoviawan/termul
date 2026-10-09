import type { Editor } from '@tiptap/core'
import { Selection } from '@tiptap/pm/state'
import { docToDisplayText } from '@/lib/composer/doc-to-prompt'
import { logFrontendError } from '@/lib/log-api'

const LOG_SOURCE = 'composer-add-sheet'

/**
 * Blur the composer editor synchronously (dismisses the on-screen keyboard).
 * Non-critical: a missing, unmounted or destroyed editor is a no-op.
 */
export function blurComposerEditor(editor: Editor | null): void {
  if (!editor || editor.isDestroyed) return
  try {
    editor.view.dom.blur()
  } catch {
    // The view went away mid-call: there is nothing left to blur.
  }
}

/**
 * Append a `@` (file mention) or `/` (slash command) trigger at the end of the
 * composer so the existing mention / slash menus open for it.
 *
 * Runs synchronously from a tap handler: focus is taken with ProseMirror's own
 * `view.focus()` (Tiptap's `commands.focus` defers to rAF, which is too late
 * for iOS to raise the keyboard from the tap). The caret moves to the end of the
 * doc, and a space is prepended when the draft is non-empty and does not already
 * end in whitespace, because both `findSlashTrigger` and `activeMentionToken`
 * only match a trigger at the start of the text or after whitespace. The space
 * is inserted as text, so it is not collapsed.
 *
 * Returns `false` (and logs a warning, never the draft text) when the editor is
 * missing, destroyed or not editable, or when the insertion throws, so the
 * caller can fall back to returning focus to its own trigger.
 */
export function insertComposerTrigger(editor: Editor | null, trigger: '@' | '/'): boolean {
  if (!editor || editor.isDestroyed || !editor.isEditable) {
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message: `Could not insert the '${trigger}' trigger: the composer editor is unavailable`
    })
    return false
  }
  try {
    const { view } = editor
    view.focus()
    const { state } = view
    const draft = docToDisplayText(state.doc)
    const prefix = draft.length > 0 && !/\s$/.test(draft) ? ' ' : ''
    view.dispatch(
      state.tr.setSelection(Selection.atEnd(state.doc)).insertText(`${prefix}${trigger}`)
    )
  } catch (err) {
    // The error name only: a ProseMirror message can quote document content,
    // and the draft text must never reach the log.
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message: `Could not insert the '${trigger}' trigger: ${err instanceof Error ? err.name : 'unknown error'}`
    })
    return false
  }
  // Best effort, and after the insertion has been emitted: a long draft can
  // leave the caret below the editor's visible area. A view without layout
  // (jsdom) cannot scroll, which must not undo the insertion.
  try {
    editor.view.dispatch(editor.view.state.tr.scrollIntoView())
  } catch {
    // Not scrollable: the caret stays where it is.
  }
  return true
}
