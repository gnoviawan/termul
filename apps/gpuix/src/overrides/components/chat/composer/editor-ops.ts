/** GPUIX twin of `components/chat/composer/editor-ops.ts`: the host's operations on the native composer. */

import type { NativeComposerEditor } from '../../../../composer/native-editor'

export type ComposerEditor = NativeComposerEditor

export function composerEditorCaret(
  editor: ComposerEditor | null,
  fallback: number,
  _end: 'to' | 'head' = 'to'
): number {
  return editor ? editor.displayCaret() : fallback
}

export function isComposerEditorLive(editor: ComposerEditor | null): editor is ComposerEditor {
  return editor?.isLive() === true
}

export function focusComposerEditor(editor: ComposerEditor | null, position?: 'end'): void {
  editor?.focus(position)
}

export function setComposerEditorCaret(editor: ComposerEditor, displayOffset: number): void {
  editor.setCaret(displayOffset)
}

export function composerEditorElement(editor: ComposerEditor | null): HTMLElement | null {
  return editor?.element ?? null
}
