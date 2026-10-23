/**
 * Map a native `<textarea>` edit back onto the composer document.
 *
 * GPUIX 0.11 reports only the textarea's whole new value (no caret, no edit
 * range, and Backspace/arrows never reach `onKeyDown`). The edit is recovered
 * by diffing the previous and next text, anchored at the last caret the editor
 * knows, and then applied with the document's pill-atomic `replaceRange`.
 */

import { type ComposerDoc, type EditResult, project, replaceRange } from './model'

export interface TextEdit {
  readonly from: number
  readonly to: number
  readonly inserted: string
}

/** A pure insertion or deletion at the caret, if that reading explains the change. */
function editAtCaret(prev: string, next: string, caret: number): TextEdit | null {
  const grow = next.length - prev.length
  if (grow >= 0) {
    if (caret > prev.length || next.slice(0, caret) !== prev.slice(0, caret)) return null
    return next.slice(caret + grow) === prev.slice(caret)
      ? { from: caret, to: caret, inserted: next.slice(caret, caret + grow) }
      : null
  }
  // Backspace removes the characters before the caret, Delete the ones after it.
  for (const from of [caret + grow, caret]) {
    if (
      from >= 0 &&
      from - grow <= prev.length &&
      prev.slice(0, from) + prev.slice(from - grow) === next
    ) {
      return { from, to: from - grow, inserted: '' }
    }
  }
  return null
}

export function diffTexts(prev: string, next: string, caretHint: number | null): TextEdit {
  const atCaret = caretHint === null ? null : editAtCaret(prev, next, caretHint)
  if (atCaret) return atCaret
  let prefix = 0
  const max = Math.min(prev.length, next.length)
  while (prefix < max && prev[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < prev.length - prefix &&
    suffix < next.length - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++
  }
  return {
    from: prefix,
    to: prev.length - suffix,
    inserted: next.slice(prefix, next.length - suffix)
  }
}

export interface Reconciled extends EditResult {
  /** The projection of `doc`. When it differs from the native text, the editor writes it back. */
  readonly text: string
}

export function reconcile(
  doc: ComposerDoc,
  prev: string,
  next: string,
  caretHint: number | null
): Reconciled {
  if (prev === next) return { doc, caret: caretHint ?? next.length, text: next }
  const edit = diffTexts(prev, next, caretHint)
  let { from } = edit
  // Backspace over the space after a pill removes the pill too, as the web
  // keymap does. Only a one-character deletion that ends at the known caret
  // counts: a Delete key press there leaves the pill alone.
  if (edit.inserted === '' && edit.to - from === 1 && prev[from] === ' ' && caretHint === edit.to) {
    const pill = project(doc).pills.find((span) => span.to === from)
    if (pill) from = pill.from
  }
  const result = replaceRange(doc, from, edit.to, edit.inserted)
  return { ...result, text: project(result.doc).text }
}
