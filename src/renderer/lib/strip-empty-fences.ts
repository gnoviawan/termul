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
 * Fences that contain real content never match (the closing ``` must follow
 * only whitespace), so non-empty code — including ASCII art — is untouched.
 */

/** ```lang\n  \n``` — an opening fence, only whitespace, then a closing fence. */
const EMPTY_TERMINATED_FENCE = /```[^\n]*\r?\n[ \t\r\n]*```[ \t]*(\r?\n|$)/g

/** A line whose content is a fence delimiter (```), ignoring leading space. */
function isFenceLine(line: string): boolean {
  return line.trimStart().startsWith('```')
}

/**
 * Strip a trailing *unterminated* fence whose body is empty. Only acts when the
 * fence-delimiter count is odd (the last opening fence has no close) and every
 * line after that opening fence is whitespace — a dangling ```lang the agent
 * never filled. A closed fence, or a fence with content, is never touched.
 */
function stripTrailingEmptyFence(text: string): string {
  const lines = text.split('\n')
  const fenceIdxs = lines.map((l, i) => (isFenceLine(l) ? i : -1)).filter((i) => i >= 0)
  if (fenceIdxs.length % 2 === 0) return text // all fences are closed
  const openIdx = fenceIdxs[fenceIdxs.length - 1]
  const bodyAfter = lines.slice(openIdx + 1).join('\n')
  if (bodyAfter.trim().length > 0) return text // dangling fence has real content
  return lines.slice(0, openIdx).join('\n')
}

export function stripEmptyFences(text: string, streaming: boolean): string {
  const out = text.replace(EMPTY_TERMINATED_FENCE, '')
  if (!streaming) return stripTrailingEmptyFence(out)
  return out
}
