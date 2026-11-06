import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { type MutableRefObject, useEffect } from 'react'
import { CONTEXT_PILL_NODE } from '@/lib/composer/doc-to-prompt'
import { contextToAttrs, type SelectionContext } from '@/lib/composer/selection-context'
import { logFrontendError } from '@/lib/log-api'

const LOG_SOURCE = 'insert-selection-context'

/** A request from the message list to add a context. A new `nonce` re-applies it. */
export interface SelectionContextInsertRequest {
  context: SelectionContext
  nonce: number
}

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
    const pill = state.schema.nodes[CONTEXT_PILL_NODE].create(contextToAttrs(context))
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
    const needsLeadingSpace = charBefore.length > 0 && !/\s/.test(charBefore)
    let pos = $from.pos
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
    tr.setSelection(TextSelection.create(tr.doc, pos))
    editor.view.dispatch(tr)
    editor.view.focus()
    void logFrontendError({
      level: 'info',
      source: LOG_SOURCE,
      message: `Added a selection context (${context.language === undefined ? 'text' : 'code'}, ${context.text.length} chars)`
    })
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message: `Could not add a selection context: ${err instanceof Error ? err.name : 'unknown error'}`
    })
    return false
  }
  // Best effort, after the insert: a view without layout (jsdom) cannot scroll.
  try {
    editor.view.dispatch(editor.view.state.tr.scrollIntoView())
  } catch {
    // Not scrollable: the caret stays where it is.
  }
  return true
}

// The request lives in the chat panel and survives a composer remount.
const appliedRequests = new WeakSet<SelectionContextInsertRequest>()

/**
 * Apply each insert request to the composer editor once, also across remounts.
 * A request that arrives while the composer is disabled waits until it is enabled.
 */
export function useSelectionContextInsertRequest(
  editorRef: MutableRefObject<Editor | null>,
  request: SelectionContextInsertRequest | undefined,
  disabled: boolean
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the nonce is the trigger; the request object is read with it.
  useEffect(() => {
    if (!request || disabled || appliedRequests.has(request)) return
    // Outside React's commit: the pill NodeView renders with flushSync. A failed
    // insert stays unapplied, so the next composer mount retries it.
    queueMicrotask(() => {
      if (appliedRequests.has(request)) return
      if (insertSelectionContext(editorRef.current, request.context)) appliedRequests.add(request)
    })
  }, [request?.nonce, disabled, editorRef])
}
