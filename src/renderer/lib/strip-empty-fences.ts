/**
 * Remove empty fenced code blocks from agent markdown before Streamdown renders
 * it. Streamdown renders a full bordered code-block shell (language label +
 * copy/download controls) even when the fence body is empty, which shows up as
 * an ugly hollow box.
 *
 * Two cases are stripped:
 * - A *terminated* empty fence (```lang … ``` with only whitespace between).
 * - When the turn has settled (`streaming` false), a *trailing unterminated*
 *   empty fence (a dangling ```lang the agent never filled or closed). While
 *   streaming, an unterminated fence is left alone — the transient shell is the
 *   intended "code is coming" streaming cue.
 *
 * Matching follows CommonMark fence rules: at most three leading spaces, a run
 * of backticks or tildes (≥3), and a closing run of the same character that is
 * at least as long. Inline backticks, four-space indented literals, and nested
 * shorter fences inside a longer outer fence are left alone.
 */

interface FenceOpen {
  /** Line index of the opening fence. */
  index: number
  /** Fence delimiter character (` or ~). */
  char: '`' | '~'
  /** Length of the opening run (closing must be ≥ this). */
  length: number
}

interface ParsedFence {
  char: '`' | '~'
  length: number
  /** Text after the delimiter run (info string for openers; must be blank for closers). */
  after: string
}

/** Match a CommonMark fence line; null if not a fence delimiter line. */
function parseFenceLine(line: string): ParsedFence | null {
  // At most three spaces of indentation (CommonMark).
  const indentMatch = /^( {0,3})([`~])\2{2,}/.exec(line)
  if (!indentMatch) return null
  const char = indentMatch[2] as '`' | '~'
  const indentLen = indentMatch[1].length
  let length = 0
  for (const c of line.slice(indentLen)) {
    if (c === char) length += 1
    else break
  }
  if (length < 3) return null
  return { char, length, after: line.slice(indentLen + length) }
}

/** True when `line` can close an open fence of `char`/`length`. */
function isClosingFence(line: string, char: '`' | '~', length: number): boolean {
  const parsed = parseFenceLine(line)
  if (!parsed) return false
  if (parsed.char !== char || parsed.length < length) return false
  // Closing fence: only spaces after the delimiter run.
  return parsed.after.trim() === ''
}

/**
 * Strip terminated empty fences with a line scanner that tracks open delimiter
 * character and run length. When a fence has content (including nested shorter
 * fences), the whole block is copied through without re-scanning the body.
 */
function stripTerminatedEmptyFences(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const parsed = parseFenceLine(line)
    if (!parsed) {
      out.push(line)
      i += 1
      continue
    }

    // Find the matching close for this open delimiter/run length.
    let j = i + 1
    let closed = false
    while (j < lines.length) {
      if (isClosingFence(lines[j], parsed.char, parsed.length)) {
        closed = true
        break
      }
      j += 1
    }

    if (!closed) {
      // Unterminated — leave for stripTrailingEmptyFence when settled.
      out.push(line)
      i += 1
      continue
    }

    const body = lines.slice(i + 1, j)
    if (body.every((l) => l.trim() === '')) {
      // Drop the empty fence (open + body + close).
      i = j + 1
      continue
    }

    // Keep the entire fence block, including any nested shorter fences.
    out.push(...lines.slice(i, j + 1))
    i = j + 1
  }
  return out.join('\n')
}

/**
 * Strip a trailing *unterminated* fence whose body is empty. Only acts when the
 * last open fence has no close and every line after it is whitespace.
 */
function stripTrailingEmptyFence(text: string): string {
  const lines = text.split('\n')
  let open: FenceOpen | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (open) {
      if (isClosingFence(line, open.char, open.length)) {
        open = null
      }
      continue
    }
    const parsed = parseFenceLine(line)
    if (parsed) {
      open = { index: i, char: parsed.char, length: parsed.length }
    }
  }
  if (!open) return text
  const bodyAfter = lines.slice(open.index + 1).join('\n')
  if (bodyAfter.trim().length > 0) return text
  return lines.slice(0, open.index).join('\n')
}

export function stripEmptyFences(text: string, streaming: boolean): string {
  const out = stripTerminatedEmptyFences(text)
  if (!streaming) return stripTrailingEmptyFence(out)
  return out
}
