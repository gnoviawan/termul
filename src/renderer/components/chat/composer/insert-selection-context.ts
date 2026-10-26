import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { CONTEXT_PILL_NODE } from '@/lib/composer/doc-to-prompt'
import { contextToAttrs, type SelectionContext } from '@/lib/composer/selection-context'
import { logFrontendError } from '@/lib/log-api'

const LOG_SOURCE = 'insert-selection-context'

/**
 * Insert a selection-context pill at the composer caret (the last caret when
 * the editor is not focused), then focus the editor with the caret after it.
 * A space is added before the pill when it would touch a word, and after it
 * (like the other pill splicers) so the user can keep typing.
 *
 * Returns `false` (and logs a warning, never the selected text) when the
 * editor is missing, destroyed, not editable, or the insert throws.
 */
export function insertSelectionContext(editor: Editor | null, context: SelectionContext): boolean {
  if (!editor || editor.isDestroyed || !editor.isEditable) {
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message: 'Could not add a selection context: the composer editor is unavailable'
    })
    return false
  }
  try {
    const { state } = editor.view
    const { from, to, $from } = state.selection
    const pill = state.schema.nodes[CONTEXT_PILL_NODE].create(contextToAttrs(context))
    const charBefore = $from.parent.textBetween(
      Math.max(0, $from.parentOffset - 1),
      $from.parentOffset,
      undefined,
      '\uFFFC'
    )
    const $to = state.selection.$to
    const charAfter = $to.parent.textBetween(
      $to.parentOffset,
      Math.min($to.parent.content.size, $to.parentOffset + 1),
      undefined,
      '\uFFFC'
    )
    const needsLeadingSpace = charBefore.length > 0 && !/\s/.test(charBefore)
    const tr = state.tr.deleteRange(from, to)
    let pos = from
    if (needsLeadingSpace) {
      tr.insertText(' ', pos)
      pos += 1
    }
    tr.insert(pos, pill)
    pos += pill.nodeSize
    if (!/^\s/.test(charAfter)) {
      tr.insertText(' ', pos)
      pos += 1
    }
    tr.setSelection(TextSelection.create(tr.doc, pos)).scrollIntoView()
    editor.view.dispatch(tr)
    editor.view.focus()
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message: `Could not add a selection context: ${err instanceof Error ? err.name : 'unknown error'}`
    })
    return false
  }
  return true
}
