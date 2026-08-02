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
 */

export const SKILL_TOKEN_START = '\uE000'
export const SKILL_TOKEN_END = '\uE001'

/** A run of plain text or a single skill token extracted from the value. */
export type SkillSegment =
  | { kind: 'text'; text: string }
  | { kind: 'skill'; name: string; raw: string }

/**
 * Split a composer value into ordered text/skill segments. Token boundaries are
 * `\uE000<name>\uE001`. Malformed tokens (start without end, or empty name) are
 * treated as plain text so a corrupted value never crashes the overlay.
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
      if (text.length > 0) {
        segments.push({ kind: 'text', text })
        text = ''
      }
      segments.push({ kind: 'skill', name, raw: value.slice(i, end + 1) })
      i = end + 1
    } else {
      text += value[i]
      i += 1
    }
  }
  if (text.length > 0) segments.push({ kind: 'text', text })
  return segments
}

/** Build a skill token string for the given skill name. */
export function skillToken(name: string): string {
  return `${SKILL_TOKEN_START}${name}${SKILL_TOKEN_END}`
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
 * space is whitespace. Returns the new value and the caret position to apply.
 */
export function insertSkillToken(
  value: string,
  caret: number,
  name: string,
  deleteBefore = 0
): InsertTokenResult {
  const start = Math.max(0, Math.min(caret - deleteBefore, value.length))
  const end = Math.max(start, Math.min(caret, value.length))
  const before = value.slice(0, start)
  const after = value.slice(end)
  const token = skillToken(name)
  const next = `${before}${token} ${after}`
  // Caret lands right after the trailing space.
  return { value: next, caret: before.length + token.length + 1 }
}

export type RemoveSkillTokenResult =
  | { removed: true; value: string; caret: number }
  | { removed: false }

/**
 * Backspace semantics for the composer: when the caret is *immediately* after a
 * skill token (no selection), remove the whole token plus the trailing space
 * the splicer appended, and place the caret where the token started. Tolerates
 * the splicer's trailing space (caret may sit one char after the token end).
 * Returns `removed:false` for the caller to fall back to the default
 * one-char backspace.
 */
export function removeSkillTokenBeforeCaret(value: string, caret: number): RemoveSkillTokenResult {
  if (caret <= 0 || caret > value.length) return { removed: false }
  // Allow one trailing space between the token end and the caret (the splicer
  // appends a space so the user can keep typing).
  let tokenEnd = caret
  if (value[caret - 1] === ' ') {
    if (caret - 2 < 0 || value[caret - 2] !== SKILL_TOKEN_END) return { removed: false }
    tokenEnd = caret - 1
  } else if (value[caret - 1] !== SKILL_TOKEN_END) {
    return { removed: false }
  }
  // tokenEnd points just after \uE001. Find the matching \uE000.
  const start = value.lastIndexOf(SKILL_TOKEN_START, tokenEnd - 1)
  if (start === -1) return { removed: false }
  const name = value.slice(start + 1, tokenEnd - 1)
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
