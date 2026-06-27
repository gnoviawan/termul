/**
 * Pure helpers that turn an ACP tool call into a short, human one-liner —
 * "Read UiKit.tsx · L185-219", "Edited UiKit.tsx · +8 −3", "Ran <command>",
 * "Searched <query>". No React/store dependency, so it's directly unit-testable.
 *
 * Tool input shapes vary per agent, so extraction is best-effort across a set of
 * common key names, with graceful fallbacks to the agent-provided title.
 */
import type { ToolCall, ToolCallContent, ToolKind } from '@/lib/acp-api'
import { diffLineCounts } from './tool-call-format'

export interface ToolCallSummary {
  /** Leading action word, e.g. "Read", "Edited", "Ran". May be empty. */
  verb: string
  /** The thing acted on — a file name, command, or query. */
  primary: string
  /** Trailing meta, e.g. "L185-219" or "+8 −3". Null when none applies. */
  detail: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return undefined
}

function firstNumber(obj: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!obj) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

const PATH_KEYS = [
  'path',
  'filePath',
  'file_path',
  'file',
  'target_file',
  'targetFile',
  'abspath',
  'absPath',
  'filename',
  'fileName'
]
const COMMAND_KEYS = ['command', 'cmd', 'script', 'commandLine']
const QUERY_KEYS = ['query', 'pattern', 'q', 'search', 'searchTerm', 'regex']
const URL_KEYS = ['url', 'uri', 'href', 'link']

/** Final path segment (handles both `/` and `\\`). */
export function baseName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Diff path + aggregate add/remove counts from structured content, if any. */
function diffInfo(content: ToolCallContent[]): {
  path?: string
  added: number
  removed: number
  hasDiff: boolean
} {
  let added = 0
  let removed = 0
  let path: string | undefined
  let hasDiff = false
  for (const item of content) {
    if (item.type === 'diff') {
      hasDiff = true
      const d = item as { path?: string; oldText?: string | null; newText?: string }
      if (!path && d.path) path = d.path
      const counts = diffLineCounts({ oldText: d.oldText ?? null, newText: d.newText ?? '' })
      added += counts.added
      removed += counts.removed
    }
  }
  return { path, added, removed, hasDiff }
}

/** "L<start>-<end>" from common range keys, or null when not derivable. */
function lineRange(input: Record<string, unknown> | null): string | null {
  const start = firstNumber(input, ['startLine', 'start_line', 'start', 'line', 'lineStart'])
  const end = firstNumber(input, ['endLine', 'end_line', 'end', 'lineEnd'])
  if (start != null && end != null) return `L${start}-${end}`
  const offset = firstNumber(input, ['offset'])
  const limit = firstNumber(input, ['limit', 'count', 'lines'])
  if (offset != null && limit != null && limit > 0) return `L${offset}-${offset + limit}`
  return null
}

/**
 * Pull a human-readable result string out of an agent's raw tool output,
 * skipping the machine envelope (metadata, ids, JSON). Prefers a plain `output`
 * / `stdout` style field, then a unified diff/patch, else returns "" so the UI
 * can fall back to structured content rather than dumping JSON at the user.
 */
export function readableOutput(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  const obj = asRecord(value)
  if (!obj) return ''
  const direct = firstString(obj, ['output', 'stdout', 'result', 'text', 'content', 'message'])
  if (direct) return direct
  const meta = asRecord(obj.metadata)
  const metaDiff = firstString(meta, ['diff'])
  if (metaDiff) return metaDiff
  const fileDiff = asRecord((meta?.fileDiff ?? obj.fileDiff) as unknown)
  const patch = firstString(fileDiff, ['patch', 'diff'])
  if (patch) return patch
  return ''
}

function verbForKind(kind: ToolKind | undefined): string {
  switch (kind) {
    case 'read':
      return 'Read'
    case 'edit':
      return 'Edited'
    case 'delete':
      return 'Deleted'
    case 'move':
      return 'Moved'
    case 'search':
      return 'Searched'
    case 'execute':
      return 'Ran'
    case 'think':
      return 'Thinking'
    case 'fetch':
      return 'Fetched'
    case 'switch_mode':
      return 'Switched mode'
    default:
      return ''
  }
}

/**
 * Derive a compact, human description of a tool call from its kind + input +
 * structured content, falling back to the agent's own title.
 */
export function describeToolCall(toolCall: ToolCall): ToolCallSummary {
  const input = asRecord(toolCall.rawInput)
  const content = toolCall.content ?? []
  const title = toolCall.title?.trim()
  const verb = verbForKind(toolCall.kind)

  switch (toolCall.kind) {
    case 'read':
    case 'delete':
    case 'move': {
      const p = firstString(input, PATH_KEYS) ?? diffInfo(content).path
      const primary = p ? baseName(p) : (title ?? 'file')
      return { verb, primary, detail: toolCall.kind === 'read' ? lineRange(input) : null }
    }
    case 'edit': {
      const diff = diffInfo(content)
      const p = firstString(input, PATH_KEYS) ?? diff.path
      const primary = p ? baseName(p) : (title ?? 'file')
      let detail: string | null = null
      if (diff.hasDiff) {
        detail = diff.removed > 0 ? `+${diff.added} \u2212${diff.removed}` : `+${diff.added}`
      }
      return { verb, primary, detail }
    }
    case 'execute': {
      const cmd = firstString(input, COMMAND_KEYS) ?? title ?? 'command'
      return { verb, primary: cmd, detail: null }
    }
    case 'search': {
      const q = firstString(input, QUERY_KEYS) ?? title ?? ''
      return { verb, primary: q, detail: null }
    }
    case 'fetch': {
      const url = firstString(input, URL_KEYS) ?? title ?? ''
      return { verb, primary: url, detail: null }
    }
    case 'think': {
      const thought = firstString(input, ['thought', 'text', 'message'])
      return { verb, primary: thought ?? title ?? 'Thinking', detail: null }
    }
    default: {
      // Unknown/generic tool: lean on whatever title the agent provided.
      return { verb, primary: title ?? toolCall.kind ?? 'Tool call', detail: null }
    }
  }
}
