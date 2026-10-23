/**
 * The GPUIX composer's document: text runs and pill atoms, the same content
 * the web composer keeps in its ProseMirror doc.
 *
 * Stock GPUIX 0.11 has IME only inside `<textarea>`, and a textarea holds one
 * plain string. So the editor shows the document as a projection: every pill
 * becomes a short label (`@file`, `/command`, `/skill`) in the textarea's
 * text, and the document remembers which ranges of that text are pills. All
 * offsets in this module are UTF-16 indices into the projected text, which is
 * what the textarea's caret moves over. The shared sentinel-token display
 * string (`value` in `useChatComposer`) is parsed with the web's
 * `draftFromTokens` and serialized with the web's `pillTokenText`.
 */

import {
  CMD_PILL_NODE,
  FILE_PILL_NODE,
  isPillNodeType,
  type PillNodeType,
  pillTokenText,
  SKILL_PILL_NODE
} from '@/lib/composer/doc-to-prompt'
import { draftFromTokens } from '@/lib/composer/draft-from-tokens'

export type Pill =
  | { readonly kind: 'file'; readonly display: string; readonly absPath: string }
  | { readonly kind: 'command'; readonly name: string }
  | { readonly kind: 'skill'; readonly name: string }

export type Segment = { readonly kind: 'text'; readonly text: string } | Pill

/** Normalized: no empty text runs, no two text runs side by side. */
export type ComposerDoc = readonly Segment[]

export interface PillSpan {
  readonly from: number
  readonly to: number
  readonly pill: Pill
}

export interface Projection {
  readonly text: string
  readonly pills: readonly PillSpan[]
}

export interface EditResult {
  readonly doc: ComposerDoc
  /** Caret in the new projection. */
  readonly caret: number
}

export const EMPTY_DOC: ComposerDoc = []

export function pillLabel(pill: Pill): string {
  switch (pill.kind) {
    case 'file':
      return `@${pill.display}`
    case 'command':
    case 'skill':
      return `/${pill.name}`
  }
}

const PILL_NODE: Record<Pill['kind'], PillNodeType> = {
  file: FILE_PILL_NODE,
  command: CMD_PILL_NODE,
  skill: SKILL_PILL_NODE
}

function pillAttrs(pill: Pill): Record<string, unknown> {
  return pill.kind === 'file' ? { display: pill.display, absPath: pill.absPath } : { name: pill.name }
}

function pillFromNode(type: PillNodeType, attrs: Record<string, unknown>): Pill {
  switch (type) {
    case FILE_PILL_NODE:
      return { kind: 'file', display: String(attrs.display ?? ''), absPath: String(attrs.absPath ?? '') }
    case CMD_PILL_NODE:
      return { kind: 'command', name: String(attrs.name ?? '') }
    case SKILL_PILL_NODE:
      return { kind: 'skill', name: String(attrs.name ?? '') }
  }
}

export function normalize(segments: readonly Segment[]): ComposerDoc {
  const out: Segment[] = []
  for (const segment of segments) {
    if (segment.kind !== 'text') {
      out.push(segment)
      continue
    }
    if (segment.text.length === 0) continue
    const last = out.at(-1)
    if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + segment.text }
    else out.push(segment)
  }
  return out
}

/** Parse the shared display string with the web's own parser. */
export function fromDisplay(value: string): ComposerDoc {
  const segments: Segment[] = []
  draftFromTokens(value).content.forEach((paragraph, index) => {
    if (index > 0) segments.push({ kind: 'text', text: '\n' })
    const inline = (paragraph.content ?? []) as Array<{ type: string; text?: string; attrs?: Record<string, unknown> }>
    for (const node of inline) {
      if (node.type === 'text') segments.push({ kind: 'text', text: node.text ?? '' })
      else if (isPillNodeType(node.type)) segments.push(pillFromNode(node.type, node.attrs ?? {}))
    }
  })
  return normalize(segments)
}

/** Serialize to the shared display string, pills through the web's `pillTokenText`. */
export function toDisplay(doc: ComposerDoc): string {
  return doc.map((s) => (s.kind === 'text' ? s.text : pillTokenText(PILL_NODE[s.kind], pillAttrs(s)))).join('')
}

export function project(doc: ComposerDoc): Projection {
  let text = ''
  const pills: PillSpan[] = []
  for (const segment of doc) {
    if (segment.kind === 'text') {
      text += segment.text
      continue
    }
    const label = pillLabel(segment)
    pills.push({ from: text.length, to: text.length + label.length, pill: segment })
    text += label
  }
  return { text, pills }
}

function segmentLength(segment: Segment): number {
  return segment.kind === 'text' ? segment.text.length : pillLabel(segment).length
}

/** Display-string offset of a projection offset. An offset inside a pill label maps past the pill. */
export function toDisplayOffset(doc: ComposerDoc, offset: number): number {
  let text = 0
  let display = 0
  for (const segment of doc) {
    const length = segmentLength(segment)
    const token = segment.kind === 'text' ? length : toDisplay([segment]).length
    if (offset <= text) return display
    if (offset < text + length) return segment.kind === 'text' ? display + (offset - text) : display + token
    text += length
    display += token
  }
  return display
}

/** Projection offset of a display-string offset. An offset inside a pill token maps past the pill. */
export function fromDisplayOffset(doc: ComposerDoc, offset: number): number {
  let text = 0
  let display = 0
  for (const segment of doc) {
    const length = segmentLength(segment)
    const token = segment.kind === 'text' ? length : toDisplay([segment]).length
    if (offset <= display) return text
    if (offset < display + token) return segment.kind === 'text' ? text + (offset - display) : text + length
    text += length
    display += token
  }
  return text
}

/** Split the document at a projection offset that is not inside a pill. */
function splitAt(doc: ComposerDoc, offset: number): [Segment[], Segment[]] {
  const before: Segment[] = []
  const after: Segment[] = []
  let at = 0
  for (const segment of doc) {
    const length = segmentLength(segment)
    if (at + length <= offset) before.push(segment)
    else if (at >= offset) after.push(segment)
    else if (segment.kind === 'text') {
      before.push({ kind: 'text', text: segment.text.slice(0, offset - at) })
      after.push({ kind: 'text', text: segment.text.slice(offset - at) })
    } else {
      throw new Error(`splitAt ${offset} falls inside a pill`)
    }
    at += length
  }
  return [before, after]
}

/**
 * Replace `[from, to)` of the projection with `inserted`, keeping pills atomic.
 *
 * - A range that touches part of a pill grows to cover the whole pill, so the
 *   pill goes away as a unit (Backspace at its end, a selection across it).
 * - An insertion inside a pill label lands after the pill.
 * - Sentinel tokens inside `inserted` (a pasted display string) become pills.
 */
export function replaceRange(doc: ComposerDoc, from: number, to: number, inserted: string): EditResult {
  let start = Math.min(from, to)
  let end = Math.max(from, to)
  for (const span of project(doc).pills) {
    if (start === end) {
      if (start > span.from && start < span.to) start = end = span.to
    } else if (start < span.to && end > span.from) {
      start = Math.min(start, span.from)
      end = Math.max(end, span.to)
    }
  }
  const [before] = splitAt(doc, start)
  const [, after] = splitAt(doc, end)
  const middle = fromDisplay(inserted)
  const caret = start + middle.reduce((sum, s) => sum + segmentLength(s), 0)
  return { doc: normalize([...before, ...middle, ...after]), caret }
}

export function insertText(doc: ComposerDoc, caret: number, text: string): EditResult {
  return replaceRange(doc, caret, caret, text)
}

function pillEndingAt(doc: ComposerDoc, offset: number): PillSpan | undefined {
  return project(doc).pills.find((span) => span.to === offset)
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function previousBoundary(text: string, offset: number): number {
  let last = 0
  for (const { index } of graphemes.segment(text)) {
    if (index >= offset) break
    last = index
  }
  return last
}

function nextBoundary(text: string, offset: number): number {
  for (const { index, segment } of graphemes.segment(text)) {
    if (index >= offset) return index + segment.length
  }
  return text.length
}

/**
 * Backspace with an empty selection. A pill right before the caret goes as a
 * unit, and so does a pill followed by the single space the menus append
 * after it: the web composer's keymap removes both (`ChatComposerEditor`).
 */
export function deleteBackward(doc: ComposerDoc, caret: number): EditResult {
  if (caret === 0) return { doc, caret }
  const { text } = project(doc)
  const direct = pillEndingAt(doc, caret)
  if (direct) return replaceRange(doc, direct.from, caret, '')
  const spaced = text[caret - 1] === ' ' ? pillEndingAt(doc, caret - 1) : undefined
  if (spaced) return replaceRange(doc, spaced.from, caret, '')
  return replaceRange(doc, previousBoundary(text, caret), caret, '')
}

export function deleteForward(doc: ComposerDoc, caret: number): EditResult {
  const { text, pills } = project(doc)
  if (caret >= text.length) return { doc, caret }
  const pill = pills.find((span) => span.from === caret)
  return replaceRange(doc, caret, pill ? pill.to : nextBoundary(text, caret), '')
}

/** Arrow keys: a pill is one step. */
export function moveCaret(doc: ComposerDoc, caret: number, direction: -1 | 1): number {
  const { text, pills } = project(doc)
  if (direction < 0) {
    if (caret === 0) return 0
    const pill = pills.find((span) => span.to === caret || (caret > span.from && caret < span.to))
    return pill ? pill.from : previousBoundary(text, caret)
  }
  if (caret >= text.length) return text.length
  const pill = pills.find((span) => span.from === caret || (caret > span.from && caret < span.to))
  return pill ? pill.to : nextBoundary(text, caret)
}
