/**
 * The editor paints the document as stacked native `<code>` chunks: only the
 * chunks near the viewport mount, and an unchanged chunk keeps its string so
 * Syntect's highlight cache answers a scroll without re-highlighting.
 *
 * Syntect highlights each `<code>` from a fresh parse state, so a chunk that
 * starts inside a block comment, a template string or a fenced block would
 * colour the rest of that token as code. Boundaries therefore sit every
 * `CHUNK_LINES` lines, moved down past any multi-line token the Lezer tree
 * shows covering the line start.
 */

import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

export const CHUNK_LINES = 64
const MAX_SHIFT = CHUNK_LINES * 4
const MULTILINE_TOKEN =
  /^(BlockComment|Comment|CommentBlock|String|TemplateString|RawString|FencedCode|CodeBlock|HTMLBlock|BlockLiteral|ScriptText|StyleText)$/

export interface Chunk {
  /** First line, 1-based. */
  readonly startLine: number
  /** Last line, inclusive. */
  readonly endLine: number
}

function insideMultilineToken(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
    state
  ).resolveInner(pos, 1); node; node = node.parent) {
    if (node.from < pos && node.to > pos && MULTILINE_TOKEN.test(node.name)) return true
  }
  return false
}

/** Every chunk start line, ascending, beginning with 1. */
export function chunkStarts(state: EditorState): number[] {
  const starts = [1]
  const lines = state.doc.lines
  let next = 1 + CHUNK_LINES
  while (next <= lines) {
    let line = next
    while (
      line <= lines &&
      line - next < MAX_SHIFT &&
      insideMultilineToken(state, state.doc.line(line).from)
    ) {
      line++
    }
    if (line > lines) break
    starts.push(line)
    next = line + CHUNK_LINES
  }
  return starts
}

/** The chunks that intersect lines `first`..`last`. */
export function chunksBetween(starts: readonly number[], lines: number, first: number, last: number): Chunk[] {
  const chunks: Chunk[] = []
  for (let i = 0; i < starts.length; i++) {
    const startLine = starts[i]!
    const endLine = (starts[i + 1] ?? lines + 1) - 1
    if (endLine < first) continue
    if (startLine > last) break
    chunks.push({ startLine, endLine })
  }
  return chunks
}
