import { TERMUL_TOOLS, type TermulToolEntry, type TermulToolId, termulTool } from './termul-tools'

/**
 * Tool pill sentinels: `\uE00C<tool id>\uE00D`. The id names a
 * `TERMUL_TOOLS` entry; the label and the wire text come from the registry,
 * so a token never carries user text.
 */
export const TOOL_TOKEN_START = '\uE00C'
export const TOOL_TOKEN_END = '\uE00D'

export type ToolSegment = { kind: 'text'; text: string } | { kind: 'tool'; tool: TermulToolEntry }

export function toolToken(id: TermulToolId): string {
  return `${TOOL_TOKEN_START}${id}${TOOL_TOKEN_END}`
}

/**
 * Split a composer value into text and tool segments. A token whose id is not
 * in the registry keeps its id as text, and an unterminated token keeps the
 * rest as text, so a stale or damaged draft still loads and never leaks a
 * sentinel.
 */
export function parseToolSegments(value: string): ToolSegment[] {
  const segments: ToolSegment[] = []
  let text = ''
  let i = 0
  while (i < value.length) {
    const start = value.indexOf(TOOL_TOKEN_START, i)
    if (start === -1) break
    text += value.slice(i, start)
    const end = value.indexOf(TOOL_TOKEN_END, start + 1)
    if (end === -1) {
      text += value.slice(start + 1)
      i = value.length
      break
    }
    const id = value.slice(start + 1, end)
    const tool = termulTool(id)
    if (tool) {
      if (text.length > 0) segments.push({ kind: 'text', text })
      text = ''
      segments.push({ kind: 'tool', tool })
    } else {
      text += id
    }
    i = end + 1
  }
  text += value.slice(i)
  // A stray end sentinel has no start to pair with.
  text = text.replaceAll(TOOL_TOKEN_END, '')
  if (text.length > 0) segments.push({ kind: 'text', text })
  return segments
}

export function hasToolTokens(value: string): boolean {
  return value.includes(TOOL_TOKEN_START)
}

/** Each tool pill becomes its wire text, where the user placed it. */
export function replaceToolTokensInline(value: string): string {
  if (!hasToolTokens(value) && !value.includes(TOOL_TOKEN_END)) return value
  return parseToolSegments(value)
    .map((segment) => (segment.kind === 'tool' ? segment.tool.wireText : segment.text))
    .join('')
}

/** The inverse for a persisted prompt: each tool's exact wire text becomes its pill again. */
export function restoreToolTokens(wireText: string): string {
  let text = wireText
  for (const tool of TERMUL_TOOLS) {
    if (text.includes(tool.wireText)) text = text.replaceAll(tool.wireText, toolToken(tool.id))
  }
  return text
}
