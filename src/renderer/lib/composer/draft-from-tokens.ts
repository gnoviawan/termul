/**
 * Parse a saved draft / seeded display string (sentinel-token format) into a
 * ProseMirror doc JSON that the Tiptap editor can `setContent`. The inverse of
 * {@link docToDisplayText}: each `\uE000<name>\uE001` token becomes an inline
 * `skillPill` node; plain text becomes text nodes; `\n` splits the doc into
 * paragraphs (matching the pre-refactor textarea, where Enter produced a `\n`).
 *
 * The optional padding block (`\uE002<pad>\uE003`) is consumed into the pill
 * segment by `parseSkillSegments` but NOT emitted as a node — the pill is a
 * real DOM node now, so the padding is obsolete. Malformed tokens (no closing
 * sentinel, empty name) fall back to plain text so a corrupted draft never
 * crashes the editor. Unparseable segments become plain text (the spec's
 * "Resume draft" fallback: a draft always loads, even if partially garbled).
 */
import { parseSkillSegments } from '@/lib/skill-tokens'
import { SKILL_PILL_NODE } from './doc-to-prompt'

interface PmDocJSON {
  type: 'doc'
  content: Array<Record<string, unknown>>
}

interface InlineNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
}

/**
 * Convert a sentinel-token display string into a Tiptap/ProseMirror doc JSON.
 * Pills become `skillPill` nodes carrying `name` + `path` attrs (`path` defaults
 * to `''`; the wire builder resolves paths from `skillPathsRef` at send time, so
 * the doc's `path` attr is a convenience, not load-bearing). Empty/whitespace
 * text segments are skipped (ProseMirror disallows empty text nodes in the
 * schema used by StarterKit).
 */
export function draftFromTokens(
  value: string,
  /** Optional name→path map to seed pill node `path` attrs (purely informational). */
  paths?: Record<string, string>
): PmDocJSON {
  const segments = parseSkillSegments(value)
  // Split into paragraph lines on explicit `\n` boundaries in the text
  // segments. Each line becomes a `paragraph` whose inline content is the
  // concatenation of the (split) segments within that line.
  const paragraphs: InlineNode[][] = [[]]
  for (const seg of segments) {
    if (seg.kind === 'skill') {
      paragraphs.at(-1)!.push({
        type: SKILL_PILL_NODE,
        attrs: { name: seg.name, path: paths?.[seg.name] ?? '' }
      })
      continue
    }
    // Text segment: split on `\n` to open new paragraphs.
    const lines = seg.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) paragraphs.push([])
      if (lines[i].length > 0) {
        paragraphs.at(-1)!.push({ type: 'text', text: lines[i] })
      }
    }
  }
  // ProseMirror's `paragraph` node (from StarterKit) disallows empty content
  // when the doc is otherwise empty — emit a single empty paragraph for the
  // empty-value case so the editor has a valid, editable document.
  if (paragraphs.length === 0 || (paragraphs.length === 1 && paragraphs[0].length === 0)) {
    return { type: 'doc', content: [{ type: 'paragraph' }] }
  }
  return {
    type: 'doc',
    content: paragraphs.map((inline) => ({
      type: 'paragraph',
      content: inline.length > 0 ? inline : undefined
    }))
  }
}
