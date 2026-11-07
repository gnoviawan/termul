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

function stripToolSentinels(text: string): string {
  return text.replaceAll(TOOL_TOKEN_START, '').replaceAll(TOOL_TOKEN_END, '')
}

/**
 * Split a composer value into text and tool segments. A token whose id is not
 * in the registry keeps its id as text. A start with no end before the next
 * start is dropped, so it never swallows the pill after it. Every text segment
 * is stripped of stray sentinels, so a stale or damaged draft still loads and
 * never leaks one.
 */
export function parseToolSegments(value: string): ToolSegment[] {
  const segments: ToolSegment[] = []
  let text = ''
  const flushText = (): void => {
    const clean = stripToolSentinels(text)
    if (clean.length > 0) segments.push({ kind: 'text', text: clean })
    text = ''
  }
  let i = 0
  while (i < value.length) {
    const start = value.indexOf(TOOL_TOKEN_START, i)
    if (start === -1) break
    text += value.slice(i, start)
    const end = value.indexOf(TOOL_TOKEN_END, start + 1)
    const nextStart = value.indexOf(TOOL_TOKEN_START, start + 1)
    if (end === -1 || (nextStart !== -1 && nextStart < end)) {
      i = start + 1
      continue
    }
    const id = value.slice(start + 1, end)
    const tool = termulTool(id)
    if (tool) {
      flushText()
      segments.push({ kind: 'tool', tool })
    } else {
      text += id
    }
    i = end + 1
  }
  text += value.slice(i)
  flushText()
  return segments
}

/** True when the value holds at least one well-formed pill for a known tool. */
export function hasToolTokens(value: string): boolean {
  return (
    value.includes(TOOL_TOKEN_START) &&
    parseToolSegments(value).some((segment) => segment.kind === 'tool')
  )
}

/** Each tool pill becomes its wire text, where the user placed it. */
export function replaceToolTokensInline(value: string): string {
  if (!value.includes(TOOL_TOKEN_START) && !value.includes(TOOL_TOKEN_END)) return value
  return parseToolSegments(value)
    .map((segment) => (segment.kind === 'tool' ? segment.tool.wireText : segment.text))
    .join('')
}

/** Each tool pill becomes its label, for a title that names the tool. */
export function replaceToolTokensWithLabels(value: string): string {
  if (!value.includes(TOOL_TOKEN_START) && !value.includes(TOOL_TOKEN_END)) return value
  return parseToolSegments(value)
    .map((segment) => (segment.kind === 'tool' ? segment.tool.label : segment.text))
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
