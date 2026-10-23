/**
 * The editor instance the GPUIX composer hands to its host through
 * `editorRef`, and the native caret placement it relies on.
 */

import type { NativeRenderer } from '@gpuix/react'

export interface NativeComposerEditor {
  isLive(): boolean
  isEditable(): boolean
  /** Display-string offset of the caret. */
  displayCaret(): number
  focus(position?: 'end'): void
  blur(): void
  /** Focus and put the caret at a display-string offset. */
  setCaret(displayOffset: number): void
  /** Append a trigger (`@` or `/`) at the end, with a space before it when needed. */
  insertTrigger(trigger: '@' | '/'): void
  readonly element: HTMLElement | null
}

type KeystrokeRenderer = NativeRenderer & { simulateKeystrokes(keys: string): void }

function canSimulate(renderer: NativeRenderer): renderer is KeystrokeRenderer {
  return typeof (renderer as Partial<KeystrokeRenderer>).simulateKeystrokes === 'function'
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemeCount(text: string): number {
  let count = 0
  for (const _ of graphemes.segment(text)) count++
  return count
}

/**
 * The arrow-key run that takes a textarea's caret from wherever it is to
 * `offset`: to the nearer end of the text, then one grapheme at a time.
 * Exported for tests.
 */
export function caretKeystrokes(text: string, offset: number): string {
  const before = graphemeCount(text.slice(0, offset))
  const after = graphemeCount(text.slice(offset))
  return before <= after
    ? ['cmd-up', ...Array<string>(before).fill('right')].join(' ')
    : ['cmd-down', ...Array<string>(after).fill('left')].join(' ')
}

/**
 * GPUIX 0.11 has no API to set a textarea's selection (kybern patches one in),
 * and an external `value` puts the caret at the end. The live renderer's
 * `simulateKeystrokes` feeds keys through the focused editor's own actions, so
 * the caret walks to `offset` with the editor's grapheme rules. Needs the
 * textarea focused and its new value already synced, so callers run it a
 * frame after the commit.
 */
export function placeTextareaCaret(
  renderer: NativeRenderer,
  textareaId: number,
  text: string,
  offset: number
): boolean {
  if (!canSimulate(renderer) || !renderer.focusElement) return false
  renderer.focusElement(textareaId)
  renderer.simulateKeystrokes(caretKeystrokes(text, offset))
  return true
}
