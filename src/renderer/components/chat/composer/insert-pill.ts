import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { TOOL_PILL_NODE } from '@/lib/composer/doc-to-prompt'
import type { TermulToolId } from '@/lib/composer/termul-tools'
import { logFrontendError } from '@/lib/log-api'

/**
 * Insert an atom pill at the composer caret (the last caret when the editor
 * is not focused), then focus the editor with the caret after it. A space is
 * added before the pill when it would touch a word, and after it (like the
 * other pill splicers) so the user can keep typing. Throws when the
 * transaction fails; callers log and report.
 */
export function insertPillAtCaret(
  editor: Editor,
  nodeName: string,
  attrs: Record<string, unknown>
): void {
  const { state } = editor.view
  const pill = state.schema.nodes[nodeName].create(attrs)
  // Delete first, then work from a caret inside a paragraph: a select-all
  // (Ctrl+A) selection starts at the doc level, outside any paragraph.
  const tr = state.tr.deleteSelection()
  const caret = TextSelection.near(tr.doc.resolve(tr.selection.from))
  const { $from } = caret
  const charBefore = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 1),
    $from.parentOffset,
    undefined,
    '\uFFFC'
  )
  const charAfter = $from.parent.textBetween(
    $from.parentOffset,
    Math.min($from.parent.content.size, $from.parentOffset + 1),
    undefined,
    '\uFFFC'
  )
  let pos = $from.pos
  if (charBefore.length > 0 && !/\s/.test(charBefore)) {
    tr.insertText(' ', pos)
    pos += 1
  }
  tr.insert(pos, pill)
  pos += pill.nodeSize
  if (!/^\s/.test(charAfter)) {
    tr.insertText(' ', pos)
    pos += 1
  }
  tr.setSelection(TextSelection.create(tr.doc, pos))
  editor.view.dispatch(tr)
  editor.view.focus()
  // Best effort, after the insert: a view without layout (jsdom) cannot scroll.
  try {
    editor.view.dispatch(editor.view.state.tr.scrollIntoView())
  } catch {
    // Not scrollable: the caret stays where it is.
  }
}

const TOOL_LOG_SOURCE = 'insert-composer-tool'

/**
 * Insert a Troupe tool pill at the caret. Returns `false` (and logs a
 * warning) when the editor is unavailable or the insert throws.
 */
export function insertComposerTool(editor: Editor | null, id: TermulToolId): boolean {
  if (!editor || editor.isDestroyed || !editor.isEditable) {
    void logFrontendError({
      level: 'warn',
      source: TOOL_LOG_SOURCE,
      message: `Could not add the ${id} tool: the composer editor is unavailable`
    })
    return false
  }
  try {
    insertPillAtCaret(editor, TOOL_PILL_NODE, { id })
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: TOOL_LOG_SOURCE,
      message: `Could not add the ${id} tool: ${err instanceof Error ? err.name : 'unknown error'}`
    })
    return false
  }
  void logFrontendError({
    level: 'info',
    source: TOOL_LOG_SOURCE,
    message: `Added the ${id} tool pill`
  })
  return true
}
