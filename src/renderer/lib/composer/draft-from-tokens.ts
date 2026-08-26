/**
 * Parse a saved draft / seeded display string (sentinel-token format) into a
 * ProseMirror doc JSON that the Tiptap editor can `setContent`. The inverse of
 * {@link docToDisplayText}: each `\uE000<name>\uE001` token becomes an inline
 * `skillPill` node; each `\uE004<name>\uE005` token becomes an inline
 * `commandPill` node; plain text becomes text nodes; `\n` splits the doc into
 * paragraphs (matching the pre-refactor textarea, where Enter produced a `\n`).
 *
 * The optional padding block (`\uE002<pad>\uE003`) is consumed into the pill
 * segment by `parseComposerSegments` but NOT emitted as a node — the pill is
 * a real DOM node now, so the padding is obsolete. Malformed tokens (no closing
 * sentinel, empty name) fall back to plain text so a corrupted draft never
 * crashes the editor. Unparseable segments become plain text (the spec's
 * "Resume draft" fallback: a draft always loads, even if partially garbled).
 */
import {
  CMD_TOKEN_END,
  CMD_TOKEN_START,
  FILE_TOKEN_END,
  FILE_TOKEN_SEP,
  FILE_TOKEN_START,
  parseSkillSegments
} from '@/lib/skill-tokens'
import { CMD_PILL_NODE, FILE_PILL_NODE, SKILL_PILL_NODE } from './doc-to-prompt'

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
 * A run of plain text, a skill token, or a command token extracted from the
 * value. The combined parser delegates the skill-token walk (including the
 * optional padding block) to `parseSkillSegments` from `skill-tokens` (the
 * single source of truth for the skill walk), then walks the resulting text
 * segments for command tokens (`\uE004<name>\uE005`, no padding block). This
 * keeps one implementation of the skill-token walk — `parseComposerSegments`
 * does not re-implement it.
 */
type ComposerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'skill'; name: string }
  | { kind: 'command'; name: string }
  | { kind: 'file'; display: string; absPath: string }

/**
 * Split a composer value into ordered text/skill/command segments. Delegates
 * the skill-token walk (including the optional `\uE002<pad>\uE003` padding
 * block) to {@link parseSkillSegments} — the single source of truth for the
 * skill walk — then walks each text segment for command tokens
 * (`\uE004<name>\uE005`, no padding block). Malformed command tokens (no
 * closing sentinel, empty name) are treated as plain text so a corrupted value
 * never crashes the editor. The skill walker already handles malformed skill
 * tokens the same way.
 */
function parseComposerSegments(value: string): ComposerSegment[] {
  // Delegate to `parseSkillSegments` for the skill-token walk (it handles
  // \uE000..\uE001 + the optional \uE002..\uE003 padding block). Command
  // tokens (\uE004..\uE005) are not skill sentinels, so `parseSkillSegments`
  // treats them as plain text — they land inside the text segments, which we
  // walk below.
  const skillSegments = parseSkillSegments(value)
  const segments: ComposerSegment[] = []
  for (const seg of skillSegments) {
    if (seg.kind === 'skill') {
      segments.push({ kind: 'skill', name: seg.name })
      continue
    }
    // Text segment: walk for command tokens (\uE004<name>\uE005) and file
    // tokens (\uE006<display>\u001F<absPath>\uE007). Both carry no padding
    // block (the pills are real DOM nodes). File tokens are not skill
    // sentinels, so `parseSkillSegments` leaves them in the text segments
    // alongside command tokens — we walk for both here.
    let i = 0
    let text = ''
    while (i < seg.text.length) {
      if (seg.text[i] === CMD_TOKEN_START) {
        const end = seg.text.indexOf(CMD_TOKEN_END, i + 1)
        if (end === -1) {
          // No closing sentinel — treat the rest as plain text.
          text += seg.text.slice(i)
          break
        }
        const name = seg.text.slice(i + 1, end)
        if (name.length === 0) {
          // Empty token name — treat the sentinels as plain text.
          text += seg.text.slice(i, end + 1)
          i = end + 1
          continue
        }
        if (text.length > 0) {
          segments.push({ kind: 'text', text })
          text = ''
        }
        segments.push({ kind: 'command', name })
        i = end + 1
      } else if (seg.text[i] === FILE_TOKEN_START) {
        const end = seg.text.indexOf(FILE_TOKEN_END, i + 1)
        if (end === -1) {
          // No closing sentinel — treat the rest as plain text.
          text += seg.text.slice(i)
          break
        }
        const inner = seg.text.slice(i + 1, end)
        const sep = inner.indexOf(FILE_TOKEN_SEP)
        if (sep === -1) {
          // No separator — malformed, treat as plain text.
          text += seg.text.slice(i, end + 1)
          i = end + 1
          continue
        }
        const display = inner.slice(0, sep)
        const absPath = inner.slice(sep + 1)
        if (display.length === 0 || absPath.length === 0) {
          // Empty display/path — treat as plain text.
          text += seg.text.slice(i, end + 1)
          i = end + 1
          continue
        }
        if (text.length > 0) {
          segments.push({ kind: 'text', text })
          text = ''
        }
        segments.push({ kind: 'file', display, absPath })
        i = end + 1
      } else {
        text += seg.text[i]
        i += 1
      }
    }
    if (text.length > 0) segments.push({ kind: 'text', text })
  }
  return segments
}

/**
 * Convert a sentinel-token display string into a Tiptap/ProseMirror doc JSON.
 * Pills become `skillPill` nodes carrying `name` + `path` attrs (`path` defaults
 * to `''`; the wire builder resolves paths from `skillPathsRef` at send time, so
 * the doc's `path` attr is a convenience, not load-bearing). Command tokens
 * become `commandPill` nodes carrying `name`. Empty/whitespace text segments
 * are skipped (ProseMirror disallows empty text nodes in the schema used by
 * StarterKit).
 */
export function draftFromTokens(
  value: string,
  /** Optional name→path map to seed pill node `path` attrs (purely informational). */
  paths?: Record<string, string>
): PmDocJSON {
  const segments = parseComposerSegments(value)
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
    if (seg.kind === 'command') {
      paragraphs.at(-1)!.push({
        type: CMD_PILL_NODE,
        attrs: { name: seg.name }
      })
      continue
    }
    if (seg.kind === 'file') {
      paragraphs.at(-1)!.push({
        type: FILE_PILL_NODE,
        attrs: { display: seg.display, absPath: seg.absPath }
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
