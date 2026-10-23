import type { Editor } from '@tiptap/core'
import { displayOffsetToDocOffset, docOffsetToDisplayOffset } from '@/lib/composer/doc-to-prompt'

/**
 * The editor instance a composer host keeps in its `editorRef`. Every host
 * operation on it goes through the functions below, so a surface with a
 * different editor (the GPUIX client's native override of this file) swaps
 * the instance type and the operations together.
 */
export type ComposerEditor = Editor

/** Display-string offset of the selection's `to` (or `head`) end. Falls back when the editor is not mounted. */
export function composerEditorCaret(
  editor: ComposerEditor | null,
  fallback: number,
  end: 'to' | 'head' = 'to'
): number {
  if (!editor) return fallback
  const { selection } = editor.state
  return docOffsetToDisplayOffset(editor.state.doc, end === 'head' ? selection.head : selection.to)
}

export function isComposerEditorLive(editor: ComposerEditor | null): editor is ComposerEditor {
  return editor !== null && !editor.isDestroyed
}

/** Focus without scrolling; `'end'` also moves the caret to the end of the draft. */
export function focusComposerEditor(editor: ComposerEditor | null, position?: 'end'): void {
  editor?.commands.focus(position, { scrollIntoView: false })
}

/** Focus and place the caret at a display-string offset. Throws when the editor rejects the position. */
export function setComposerEditorCaret(editor: ComposerEditor, displayOffset: number): void {
  const docPos = displayOffsetToDocOffset(editor.state.doc, displayOffset)
  editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection(docPos).run()
}

/** The editable element (menu ARIA wiring, scroll-into-view). */
export function composerEditorElement(editor: ComposerEditor | null): HTMLElement | null {
  return editor?.view.dom ?? null
}
