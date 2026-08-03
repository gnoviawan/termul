/**
 * Inline skill-chip token model.
 *
 * Selected skills are spliced into the composer value as private-use sentinel
 * tokens (`\uE000<name>\uE001`). The sentinels are non-whitespace and contain
 * no `@` or `/`, so `findSlashTrigger`'s `/(?:^|\s)(\/(\S*))$/` and the
 * `@`-mention scanner are unaffected. Rendered as raw text they are invisible
 * (private-use glyphs render blank in most fonts), so a fallback raw render
 * degrades gracefully. The transparent-textarea overlay
 * (`SkillComposerOverlay`) and the timeline user bubble (`ChatMessage`) parse
 * the value into segments and swap tokens for `SkillChip` pills; the wire
 * prompt replaces each token with `(<name>)` (see `replaceSkillTokensInline`).
 *
 * ## Caret alignment padding
 *
 * The transparent textarea renders the token text as invisible glyphs, so the
 * token's visible width is just the `name` (sentinels are zero-width in most
 * fonts). The overlay's `SkillChip` pill is wider than that — it adds an icon,
 * pill padding, border, and gap, and renders the name at `font-medium` while the
 * textarea uses regular weight (both share size via `text-inherit`). Without
 * compensation the textarea caret (placed at the end of the token text) lands
 * to the LEFT of the chip's right edge, so the caret appears "behind" the chip
 * by the chip's overhead.
 *
 * To keep the caret aligned, each token may carry an optional PADDING BLOCK
 * (`\uE002<padding>\uE003`) immediately after the name token. The padding is a
 * run of FIGURE SPACE chars (`\u2007`, U+2007) — chosen because it is
 * non-printing (the textarea text is transparent), has a measurable width
 * (canvas `measureText`), and lives INSIDE the sentinel block so the
 * slash-trigger (end-anchored) and @-mention (whitespace-bounded) scanners
 * never see it as a trigger boundary. The padding widens the transparent
 * token text to match the chip's rendered width; the overlay renders the chip
 * (whose width already covers the padding area) and skips the padding, so
 * the caret stays aligned with the chip's right edge.
 *
 * The padding is computed synchronously at pick time via canvas measurement
 * (`measureSkillPadding` in `skill-chip-metrics.ts`) and spliced in by
 * `insertSkillToken`. It is stripped from the wire (`replaceSkillTokensInline`
 * maps the skill segment to `(name)` and never emits the padding) and is not
 * rendered by the overlay/timeline (the padding is consumed into the skill
 * segment, not a text segment). `removeSkillTokenBeforeCaret` removes the
 * whole token + padding block + trailing space in one backspace.
 */

export const SKILL_TOKEN_START = '\uE000'
export const SKILL_TOKEN_END = '\uE001'
/** Sentinel pair wrapping the optional caret-alignment padding block. */
export const SKILL_PAD_START = '\uE002'
export const SKILL_PAD_END = '\uE003'
/**
 * The padding character: FIGURE SPACE (U+2007). Non-printing under the
 * transparent textarea, measurable via canvas, and bounded inside the
 * `\uE002..\uE003` block so it never participates in slash/@ triggers.
 */
export const SKILL_PAD_CHAR = '\u2007'

/** A run of plain text or a single skill token extracted from the value. */
export type SkillSegment =
  | { kind: 'text'; text: string }
  | { kind: 'skill'; name: string; raw: string; padding: string }

/**
 * Split a composer value into ordered text/skill segments. Token boundaries are
 * `\uE000<name>\uE001`. A token may be followed immediately by an optional
 * padding block `\uE002<padding>\uE003` (consumed into the same skill segment
 * so it is not rendered as text and is not emitted by the wire framer).
 * Malformed tokens (start without end, or empty name) are treated as plain
 * text so a corrupted value never crashes the overlay. A padding block without
 * a closing `\uE003` is dropped (padding left empty) and the rest is parsed
 * as text — graceful degradation, never a crash.
 */
export function parseSkillSegments(value: string): SkillSegment[] {
  const segments: SkillSegment[] = []
  let i = 0
  let text = ''
  while (i < value.length) {
    if (value[i] === SKILL_TOKEN_START) {
      const end = value.indexOf(SKILL_TOKEN_END, i + 1)
      if (end === -1) {
        // No closing sentinel — treat the rest as plain text.
        text += value.slice(i)
        i = value.length
        break
      }
      const name = value.slice(i + 1, end)
      if (name.length === 0) {
        // Empty token name — treat the sentinels as plain text.
        text += value.slice(i, end + 1)
        i = end + 1
        continue
      }
      // Optional padding block immediately after the token end. Consumed into
      // the skill segment (not rendered, not wired) so the transparent
      // textarea token text widens to match the chip while the overlay skips it.
      let padding = ''
      let cursor = end + 1
      if (cursor < value.length && value[cursor] === SKILL_PAD_START) {
        const padEnd = value.indexOf(SKILL_PAD_END, cursor + 1)
        if (padEnd !== -1) {
          padding = value.slice(cursor + 1, padEnd)
          cursor = padEnd + 1
        } else {
          // Malformed padding (no closing sentinel): drop it, keep the token.
          padding = ''
          cursor = end + 1
        }
      }
      if (text.length > 0) {
        segments.push({ kind: 'text', text })
        text = ''
      }
      segments.push({ kind: 'skill', name, raw: value.slice(i, cursor), padding })
      i = cursor
    } else {
      text += value[i]
      i += 1
    }
  }
  if (text.length > 0) segments.push({ kind: 'text', text })
  return segments
}

/**
 * Build a skill token string for the given skill name, optionally carrying a
 * caret-alignment padding block (`\uE002<padding>\uE003`) so the transparent
 * textarea token text is as wide as the `SkillChip` pill rendered over it.
 * Empty padding omits the block (backward-compatible with values authored
 * before padding existed).
 */
export function skillToken(name: string, padding = ''): string {
  const padBlock = padding.length > 0 ? `${SKILL_PAD_START}${padding}${SKILL_PAD_END}` : ''
  return `${SKILL_TOKEN_START}${name}${SKILL_TOKEN_END}${padBlock}`
}

export interface InsertTokenResult {
  value: string
  caret: number
}

/**
 * Splice a skill token into the value at `caret`, removing the `deleteBefore`
 * chars immediately preceding the caret (the `/`-trigger filter text the slash
 * menu clears). A trailing space is appended so the caret lands in plain text
 * and the user can keep typing; the next `/` trigger still matches because the
 * space is whitespace. The optional `padding` (computed by
 * `measureSkillPadding`) is carried inside the token's padding block so the
 * transparent textarea text widens to match the rendered `SkillChip` pill and
 * the caret stays aligned with the chip's right edge. Returns the new value
 * and the caret position to apply.
 */
export function insertSkillToken(
  value: string,
  caret: number,
  name: string,
  deleteBefore = 0,
  padding = ''
): InsertTokenResult {
  const start = Math.max(0, Math.min(caret - deleteBefore, value.length))
  const end = Math.max(start, Math.min(caret, value.length))
  const before = value.slice(0, start)
  const after = value.slice(end)
  const token = skillToken(name, padding)
  const next = `${before}${token} ${after}`
  // Caret lands right after the trailing space.
  return { value: next, caret: before.length + token.length + 1 }
}

export type RemoveSkillTokenResult =
  | { removed: true; value: string; caret: number }
  | { removed: false }

/**
 * Backspace semantics for the composer: when the caret is *immediately* after a
 * skill token (no selection), remove the whole token plus any padding block and
 * the trailing space the splicer appended, and place the caret where the token
 * started. Tolerates the splicer's trailing space (caret may sit one char after
 * the token/padding end). Returns `removed:false` for the caller to fall back
 * to the default one-char backspace.
 */
export function removeSkillTokenBeforeCaret(value: string, caret: number): RemoveSkillTokenResult {
  if (caret <= 0 || caret > value.length) return { removed: false }
  // Walk back from the caret over: the optional trailing space, then the
  // optional padding block (\uE002...\uE003), to reach the token-end \uE001.
  let end = caret
  if (end - 1 >= 0 && value[end - 1] === ' ') {
    end -= 1
  }
  // Optional padding block: ends with \uE003 immediately before the space/caret.
  if (end - 1 >= 0 && value[end - 1] === SKILL_PAD_END) {
    const padStart = value.lastIndexOf(SKILL_PAD_START, end - 1)
    if (padStart === -1) return { removed: false }
    // The token-end \uE001 must sit immediately before the padding start.
    if (padStart - 1 < 0 || value[padStart - 1] !== SKILL_TOKEN_END) return { removed: false }
    end = padStart // points at \uE002; the char before is \uE001
  }
  // Now value[end - 1] must be the token-end \uE001.
  if (end - 1 < 0 || value[end - 1] !== SKILL_TOKEN_END) return { removed: false }
  // tokenEnd points just after \uE001. Find the matching \uE000.
  const tokenEnd = end - 1
  const start = value.lastIndexOf(SKILL_TOKEN_START, tokenEnd - 1)
  if (start === -1) return { removed: false }
  const name = value.slice(start + 1, tokenEnd)
  if (name.length === 0) return { removed: false }
  const before = value.slice(0, start)
  const after = value.slice(caret)
  return { removed: true, value: `${before}${after}`, caret: start }
}

/**
 * Replace each skill token with `(<name>)` for the wire prompt's user-text
 * portion. Inline duplicates are preserved (the same skill may appear at
 * multiple positions). Non-token text is passed through verbatim.
 */
export function replaceSkillTokensInline(value: string): string {
  return parseSkillSegments(value)
    .map((s) => (s.kind === 'skill' ? `(${s.name})` : s.text))
    .join('')
}

/**
 * Extract skill names from tokens in first-appearance order. Used to build the
 * wire header (`<name>: <path>` lines, unique by name).
 */
export function extractSkillNames(value: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const seg of parseSkillSegments(value)) {
    if (seg.kind === 'skill' && !seen.has(seg.name)) {
      seen.add(seg.name)
      names.push(seg.name)
    }
  }
  return names
}
