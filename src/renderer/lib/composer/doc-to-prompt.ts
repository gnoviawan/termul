/**
 * Serialize the Tiptap composer doc to/from the sentinel-token display string
 * the rest of the system consumes.
 *
 * The composer's chip "pill" is a real inline DOM node (a Tiptap `NodeView`),
 * so the visible text + chips live in the editor's ProseMirror doc. But the
 * shared composer pipeline (`useChatComposer.buildPromptParts` →
 * `buildPromptWithLoadedSkills` → `formatPromptWithSkills`), per-session draft
 * persistence, and the timeline `ChatMessage` user-bubble renderer all operate
 * on the **sentinel-token display string** (`\uE000<name>\uE001`) — that format
 * is the load-bearing wire contract and MUST stay byte-identical.
 *
 * This module is the bridge: `docToDisplayText` walks the doc and emits the
 * exact token string the pre-refactor `<textarea>` carried. `docOffsetToDisplayOffset`
 * maps an editor doc position to the string caret offset (for `mentions.update`),
 * and `displayOffsetToDocOffset` is the inverse (for caret restoration after a
 * programmatic value splice).
 *
 * ## Padding block re-emission (on-disk byte-stability)
 *
 * Each pill segment is emitted as `\uE000<name>\uE001\uE002<pad>\uE003` — i.e.
 * the token STILL carries the optional padding block (`\uE002..\uE003`). The
 * padding is obsolete for DISPLAY (the pill is a real DOM node, so there is no
 * caret-alignment deficit to compensate), but the `\uE002..\uE003` sentinel
 * format is part of the on-disk draft schema (frozen "Ask First" boundary), and
 * stripping it on load + re-save would mutate persisted draft bytes. So
 * `docToDisplayText` RE-EMITS a fixed single-figure-space padding block after
 * every pill; `draftFromTokens` consumes it on parse. The content of the
 * padding is not load-bearing (it's a single `\u2007`); only its presence
 * matters for byte-stability across load/save round-trips.
 */
import type { Node as PmNode } from '@tiptap/pm/model'
import {
  SKILL_PAD_CHAR,
  SKILL_PAD_END,
  SKILL_PAD_START,
  SKILL_TOKEN_END,
  SKILL_TOKEN_START
} from '@/lib/skill-tokens'

/**
 * The pill node type name. Kept in one place so the (de)serializers and the
 * `SkillPill` extension agree.
 */
export const SKILL_PILL_NODE = 'skillPill'

/**
 * The fixed padding run re-emitted after every pill token to preserve the
 * on-disk draft schema (`\uE002..\uE003`). A single FIGURE SPACE (U+2007) — the
 * content is not load-bearing (the pill is a real DOM node, so the padding no
 * longer compensates a caret-alignment deficit); only its presence matters so
 * `docToDisplayText` ↔ `draftFromTokens` round-trips don't strip padding bytes
 * from persisted drafts.
 */
export const SKILL_PAD_DEFAULT = SKILL_PAD_CHAR

export interface DocSegment {
  kind: 'text' | 'pill'
  /** Visible text for a `text` segment; the padded token (`\uE000<name>\uE001\uE002<pad>\uE003`)
   * for a `pill` segment. */
  text: string
  /** Doc position at the start of this segment. */
  docFrom: number
  /** Doc position just past the end of this segment. */
  docTo: number
  /** Display-string offset at the start of this segment. */
  displayFrom: number
  /** Display-string offset just past the end of this segment. */
  displayTo: number
}

/**
 * Walk the composer doc, yielding ordered text/pill segments with both doc and
 * display-string offsets. Paragraph boundaries and `hardBreak` nodes each emit
 * a `\n` display char (matching the pre-refactor textarea `\n`) — EXCEPT a
 * boundary `\n` is suppressed when the previous paragraph's last inline child
 * was a `hardBreak` (a paragraph ending in hardBreak + next paragraph would
 * otherwise yield `\n\n` where the pre-refactor textarea produced a single
 * `\n`). Pills emit the padded token form (see {@link SKILL_PAD_DEFAULT}).
 *
 * ProseMirror positions: a top-level block at `offset` (from `doc.forEach`)
 * occupies doc pos `[offset, offset + nodeSize)`; its inline children start at
 * `offset + 1` (after the block's opening token). The inter-block boundary is
 * a zero-width doc position at `offset + nodeSize`.
 */
export function walkDocSegments(doc: PmNode): DocSegment[] {
  const segments: DocSegment[] = []
  let displayOffset = 0
  doc.forEach((block, blockOffset) => {
    // True when the block's last inline child was a `hardBreak` — used to
    // suppress the inter-block boundary `\n` (the hardBreak already emitted one).
    let blockEndedInHardBreak = false
    if (block.type.name === 'paragraph' || block.type.name === 'heading') {
      block.forEach((node, offset) => {
        const docFrom = blockOffset + 1 + offset
        let displayText = ''
        let kind: 'text' | 'pill' = 'text'
        if (node.isText) {
          displayText = node.text ?? ''
          blockEndedInHardBreak = false
        } else if (node.type.name === SKILL_PILL_NODE) {
          const name = String(node.attrs.name ?? '')
          // Re-emit the padding block so the on-disk draft schema
          // (\uE002..\uE003) survives load/save round-trips. The content is a
          // fixed single figure-space; only the presence is load-bearing.
          displayText = `${SKILL_TOKEN_START}${name}${SKILL_TOKEN_END}${SKILL_PAD_START}${SKILL_PAD_DEFAULT}${SKILL_PAD_END}`
          kind = 'pill'
          blockEndedInHardBreak = false
        } else if (node.type.name === 'hardBreak') {
          displayText = '\n'
          // A trailing hardBreak already contributes the `\n` for the line
          // break — suppress the inter-block boundary `\n` below so we don't
          // double-emit (matches the pre-refactor textarea's single `\n`).
          blockEndedInHardBreak = true
        }
        if (displayText.length > 0) {
          segments.push({
            kind,
            text: displayText,
            docFrom,
            docTo: docFrom + node.nodeSize,
            displayFrom: displayOffset,
            displayTo: displayOffset + displayText.length
          })
          displayOffset += displayText.length
        }
      })
    }
    // Paragraph boundary contributes a `\n` (matches the pre-refactor textarea,
    // where Enter produced a `\n`). Only emit between blocks — not after the
    // last one (no trailing newline) — and skip when the previous block ended
    // in a hardBreak (which already emitted its own `\n`).
    if (blockOffset + block.nodeSize < doc.content.size && !blockEndedInHardBreak) {
      const boundary = blockOffset + block.nodeSize
      segments.push({
        kind: 'text',
        text: '\n',
        docFrom: boundary,
        docTo: boundary,
        displayFrom: displayOffset,
        displayTo: displayOffset + 1
      })
      displayOffset += 1
    }
  })
  return segments
}

/**
 * Serialize the editor doc to the sentinel-token display string. Pills become
 * `\uE000<name>\uE001\uE002<pad>\uE003` (padding re-emitted for on-disk
 * byte-stability — see {@link SKILL_PAD_DEFAULT}); text nodes emit their text;
 * paragraph boundaries and `hardBreak` nodes emit `\n` (a trailing hardBreak
 * suppresses the following boundary `\n` so multi-paragraph + hardBreak
 * round-trips stay single-`\n`). The output is the string carried by
 * `useChatComposer.value` and consumed by `buildPromptParts` →
 * `buildPromptWithLoadedSkills`, so the wire payload stays byte-identical to
 * the pre-refactor textarea surface (the wire framer's `parseSkillSegments`
 * consumes the padding block and never emits it).
 */
export function docToDisplayText(doc: PmNode): string {
  return walkDocSegments(doc)
    .map((s) => s.text)
    .join('')
}

/**
 * Map an editor doc position to the display-string offset. Used to feed
 * `mentions.update(value, caret)` from the editor's live selection so the
 * @-mention menu tracks the caret as it did with `selectionStart` on the
 * textarea. A doc position inside a pill maps to the pill's display start
 * (the caret cannot rest inside an atom node in practice, but this is a safe
 * fallback).
 */
export function docOffsetToDisplayOffset(doc: PmNode, docOffset: number): number {
  const segments = walkDocSegments(doc)
  for (const seg of segments) {
    if (docOffset < seg.docTo) {
      if (docOffset <= seg.docFrom) return seg.displayFrom
      if (seg.kind === 'pill') return seg.displayFrom
      return seg.displayFrom + (docOffset - seg.docFrom)
    }
  }
  const last = segments.at(-1)
  return last ? last.displayTo : 0
}

/**
 * Map a display-string offset to an editor doc position (the inverse of
 * {@link docOffsetToDisplayOffset}). Used to restore the caret after a
 * programmatic value splice (`handleSelect` skill/command branch): the slash
 * menu's `findSlashTrigger` produces string offsets, the editor needs a doc
 * position for `setTextSelection`. A display offset that lands on a pill maps
 * to the pill's doc end (caret immediately after the pill — flush, no gap).
 *
 * On an empty doc (no segments), returns `1` — the valid caret position inside
 * the first empty paragraph (doc pos 0 is the paragraph's opening token; pos 1
 * is the editable content start). This guards `setTextSelection` from landing
 * at `doc.content.size` (past the paragraph's close token) which would throw.
 */
export function displayOffsetToDocOffset(doc: PmNode, displayOffset: number): number {
  const segments = walkDocSegments(doc)
  for (const seg of segments) {
    if (displayOffset < seg.displayTo) {
      if (displayOffset <= seg.displayFrom) return seg.docFrom
      if (seg.kind === 'pill') return seg.docTo
      return seg.docFrom + (displayOffset - seg.displayFrom)
    }
  }
  if (segments.length === 0) {
    // Empty doc — return the first paragraph's inner start (pos 1), clamped
    // to a valid range for a doc that might be `doc()` (content.size === 0).
    return Math.min(1, Math.max(0, doc.content.size - 1))
  }
  const last = segments.at(-1)
  return last ? last.docTo : doc.content.size
}

/**
 * Re-exported so callers don't reach into `skill-tokens` directly for the
 * padding sentinels.
 */
export { SKILL_PAD_END, SKILL_PAD_START }
