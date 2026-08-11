import { act } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { displayOffsetToDocOffset, docToDisplayText } from '@/lib/composer/doc-to-prompt'
import { draftFromTokens } from '@/lib/composer/draft-from-tokens'

/**
 * Test helpers for driving the modular `ChatComposerEditor` (Tiptap) surface.
 *
 * The pre-refactor tests drove a `<textarea>` via `fireEvent.change(el, { target: { value } })`
 * — that pattern does not work on a contenteditable editor (no `value` setter).
 * These helpers reach the editor instance exposed on the DOM element
 * (`__composerEditor`) and drive it imperatively: `setContent` re-parses the
 * sentinel-token string into pill/text nodes and emits `onValueChange` so the
 * host's `setValue` + slash-menu open/`findSlashTrigger` logic runs exactly as
 * it does in production. `pressKey` dispatches a real DOM `KeyboardEvent` so
 * the editor's keymap plugin (slash/mention menu keys, Backspace-pill removal,
 * Enter→submit) runs.
 */

function getEditor(): Editor {
  const el = document.querySelector('[data-composer-editor="true"]') as
    | (HTMLElement & { __composerEditor?: Editor | null })
    | null
  const editor = el?.__composerEditor
  if (!editor) throw new Error('ChatComposerEditor not mounted (no __composerEditor handle)')
  return editor
}

function getEditorEl(): HTMLElement {
  const el = document.querySelector('[data-composer-editor="true"]') as HTMLElement | null
  if (!el) throw new Error('ChatComposerEditor element not found')
  return el
}

/**
 * Set the composer value (sentinel-token string). Parses into pill/text nodes,
 * emits `onValueChange` → host `setValue` → re-render. Slash/mention menus open
 * exactly as in production (`isSlashTriggerAny(value)`). Wrapped in `act` so the
 * editor's synchronous `onTransaction` → React `setValue` update is flushed
 * before the helper returns (no `act` warning, no racy `waitFor`).
 */
export function setComposerValue(value: string): void {
  const editor = getEditor()
  // `emitUpdate: false` avoids a redundant `useEditor` re-render; `onTransaction`
  // still fires and emits `onValueChange` so the host's `setValue` runs.
  act(() => {
    editor.commands.setContent(draftFromTokens(value), false)
  })
}

/** Read the current display-string value (sentinel-token format) from the editor doc. */
export function getComposerValue(): string {
  return docToDisplayText(getEditor().state.doc)
}

/** Place the caret at the given display-string offset (maps to a doc position). */
export function setComposerCaret(displayOffset: number): void {
  const editor = getEditor()
  const pos = displayOffsetToDocOffset(editor.state.doc, displayOffset)
  act(() => {
    editor.chain().focus().setTextSelection(pos).run()
  })
}

/**
 * Dispatch a real DOM `keydown` on the editor's contenteditable (runs the
 * keymap). For a plain `Backspace` with no modifiers, jsdom cannot fire the
 * native `beforeinput`/`deleteContentBackward` that a real browser dispatches
 * after an unhandled Backspace keydown — so when the editor's keymap did NOT
 * handle the key (doc unchanged) and the selection is collapsed mid-text, we
 * simulate that one-char backward delete (mirroring the native deletion the
 * browser would perform). When the keymap DID handle it (e.g. pill removal
 * dispatched a delete transaction), the doc differs and the fallback is skipped
 * — so the pill-removal path is still exercised, not bypassed.
 */
export function pressComposerKey(
  key: string,
  options: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}
): void {
  const el = getEditorEl()
  const editor = getEditor()
  const docBefore = editor.state.doc
  const selBefore = editor.state.selection
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        shiftKey: options.shiftKey ?? false,
        metaKey: options.metaKey ?? false,
        ctrlKey: options.ctrlKey ?? false,
        altKey: options.altKey ?? false
      })
    )
  })
  if (
    key === 'Backspace' &&
    !options.shiftKey &&
    !options.metaKey &&
    !options.ctrlKey &&
    !options.altKey &&
    editor.state.doc.eq(docBefore) &&
    editor.state.selection.empty &&
    selBefore.to > 1
  ) {
    const to = editor.state.selection.to
    act(() => {
      editor.view.dispatch(editor.state.tr.delete(Math.max(0, to - 1), to))
    })
  }
}

/** Focus the editor (mirrors `textareaRef.current.focus()` in the old tests). */
export function focusComposer(): void {
  act(() => {
    getEditor().commands.focus()
  })
}
