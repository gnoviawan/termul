/**
 * Pure helpers that turn an ACP tool call into a short, human one-liner —
 * "Read UiKit.tsx · L185-219", "Edited UiKit.tsx · +8 −3", "Ran <command>",
 * "Searched <query>". No React/store dependency, so it's directly unit-testable.
 *
 * Tool input shapes vary per agent, so extraction is best-effort across a set of
 * common key names, with graceful fallbacks to the agent-provided title.
 */
import type { Subagent, SubagentControl } from '@shared/types/subagent'
import type { ToolCall, ToolCallContent, ToolKind } from '@/lib/acp-api'
import { diffLineCounts } from './tool-call-format'

export interface ToolCallSummary {
  /** Leading action word, e.g. "Read", "Edited", "Ran". May be empty. */
  verb: string
  /** The thing acted on — a file name, command, or query. */
  primary: string
  /** Trailing meta, e.g. "L185-219" or "+8 −3". Null when none applies. */
  detail: string | null
  /**
   * Structured add/remove line counts for an edit diff, so the UI can color the
   * `+N` green and `−N` red. Null for non-edit calls (the plain `detail` string
   * still carries any other trailing meta).
   */
  diffStat?: { added: number; removed: number } | null
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function firstString(
  obj: Record<string, unknown> | null,
  keys: string[]
): string | undefined {
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

export const PATH_KEYS = [
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

/**
 * Keys that commonly carry readable text in a tool-call content item or raw
 * output. Shared between `readableOutput` and `ToolCallCard`'s fallback
 * extraction so the two paths never drift.
 */
export const READABLE_TEXT_KEYS = ['output', 'stdout', 'result', 'text', 'content', 'message']

/** A subagent dispatch: the host attached its canonical record. */
export function isSubagentCall(toolCall: ToolCall): toolCall is ToolCall & { subagent: Subagent } {
  return toolCall.subagent !== undefined
}

/**
 * A call that steers existing subagents instead of starting one (Codex
 * `wait`, `sendInput`, `closeAgent`, activity cards), as the host marks it.
 */
export function isSubagentControlCall(
  toolCall: ToolCall
): toolCall is ToolCall & { subagentControl: SubagentControl } {
  return toolCall.subagentControl !== undefined
}

/** Final path segment (handles both `/` and `\\`). */
export function baseName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** First diff item's path — a path-only lookup that never runs the diff. */
function firstDiffPath(content: ToolCallContent[]): string | undefined {
  for (const item of content) {
    if (item.type === 'diff') {
      const d = item as { path?: string }
      if (d.path) return d.path
    }
  }
  return undefined
}

/**
 * Diff path + aggregate add/remove counts — the expensive half of
 * `describeToolCall` (it diffs full file contents). Cached on the content
 * array's identity: tool-call updates replace the array wholesale, so a
 * repeat look at an unchanged call is free and a changed call recomputes.
 * `useChatChangedFiles` re-extracts files on every store commit — this
 * keeps that O(calls × file size) scan from repeating the diff itself.
 */
const diffInfoCache = new WeakMap<
  ToolCallContent[],
  { path?: string; added: number; removed: number; hasDiff: boolean }
>()

function diffInfoUncached(content: ToolCallContent[]): {
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

function diffInfo(content: ToolCallContent[]): {
  path?: string
  added: number
  removed: number
  hasDiff: boolean
} {
  const cached = diffInfoCache.get(content)
  if (cached) return cached
  const result = diffInfoUncached(content)
  diffInfoCache.set(content, result)
  return result
}

/**
 * Shared best-effort file-path resolver for a tool call. Checks `locations`
 * (the canonical ACP follow-along field) first, then `rawInput` against
 * `PATH_KEYS`, then the first diff item's path. Used by both
 * `describeToolCall` (chip label) and `ToolCallCard`'s open-file action
 * so they stay in sync.
 */
export function toolCallPath(toolCall: ToolCall): string | undefined {
  const loc = toolCall.locations?.[0]?.path
  if (loc) return loc
  const input = asRecord(toolCall.rawInput)
  const fromInput = firstString(input, PATH_KEYS)
  if (fromInput) return fromInput
  const content = toolCall.content ?? []
  return firstDiffPath(content)
}

/**
 * Every path a file-changing call claims, trimmed and deduped in order: its
 * `toolCallPath`, each `locations` entry (both ends of a move), then each diff
 * item's path (a multi-file edit that lists its files only as diffs). The
 * session-paths filter and the trimmed-call summary share it; the host's
 * `file_change_paths` (session_persistence/normalize.rs) mirrors it for the
 * durable summary.
 */
export function toolCallChangedPaths(toolCall: ToolCall): string[] {
  const diffPaths = (toolCall.content ?? []).map((item) =>
    item.type === 'diff' ? (item as { path?: string }).path : undefined
  )
  const paths = new Set<string>()
  for (const raw of [
    toolCallPath(toolCall),
    ...(toolCall.locations ?? []).map((loc) => loc.path),
    ...diffPaths
  ]) {
    const path = raw?.trim()
    if (path) paths.add(path)
  }
  return Array.from(paths)
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
  const direct = firstString(obj, READABLE_TEXT_KEYS)
  if (direct) return direct
  const meta = asRecord(obj.metadata)
  const metaDiff = firstString(meta, ['diff'])
  if (metaDiff) return metaDiff
  const fileDiff = asRecord((meta?.fileDiff ?? obj.fileDiff) as unknown)
  const patch = firstString(fileDiff, ['patch', 'diff'])
  if (patch) return patch
  return ''
}

/** True while the call has not settled; the label then reads in the present tense. */
export function isToolCallRunning(toolCall: ToolCall): boolean {
  return toolCall.status === 'pending' || toolCall.status === 'in_progress'
}

/**
 * Where a subagent's parent turn stands: still running, ended with no user
 * message after it, or followed by a newer user turn.
 */
export type ParentTurn = 'active' | 'ended' | 'superseded'

/**
 * Whether a subagent is still running. Only a running or waiting record can
 * be. A source that reports progress live holds `running` across turns until
 * it reports the end. Otherwise the record mirrors the dispatch call, whose
 * completion a cancelled or crashed turn can lose, so a foreground dispatch
 * runs only while its turn is active. A background launch completes its call
 * at once and outlives its turn, but nothing reports its end, so it counts as
 * running until a newer user turn starts.
 */
export function isSubagentRunning(toolCall: ToolCall, parentTurn: ParentTurn): boolean {
  const record = toolCall.subagent
  if (!record) return false
  if (record.activity === 'idle' || record.activity === 'unknown') return false
  if (record.caps.liveProgress) return true
  if (record.background && toolCall.status === 'completed') return parentTurn !== 'superseded'
  return parentTurn === 'active'
}

function runningVerbForKind(kind: ToolKind | undefined): string {
  switch (kind) {
    case 'read':
      return 'Reading'
    case 'edit':
      return 'Editing'
    case 'delete':
      return 'Deleting'
    case 'move':
      return 'Moving'
    case 'search':
      return 'Searching'
    case 'execute':
      return 'Running'
    case 'think':
      return 'Thinking'
    case 'fetch':
      return 'Fetching'
    case 'switch_mode':
      return 'Switching mode'
    default:
      return ''
  }
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

/** Count is a finite, non-negative integer (durable payloads are untrusted). */
function isLineCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * The host-computed `ToolCall.diffStat` of a restored/recovered call, or null
 * when absent or malformed (a legacy/corrupt record never renders `+NaN`).
 */
function persistedDiffStat(value: unknown): { added: number; removed: number } | null {
  const record = asRecord(value)
  if (!record || !isLineCount(record.added) || !isLineCount(record.removed)) return null
  return { added: record.added, removed: record.removed }
}

/**
 * Derive a compact, human description of a tool call from its kind + input +
 * structured content, falling back to the agent's own title.
 */
export function describeToolCall(toolCall: ToolCall): ToolCallSummary {
  const input = asRecord(toolCall.rawInput)
  const content = toolCall.content ?? []
  const title = toolCall.title?.trim()
  const verb = isToolCallRunning(toolCall)
    ? runningVerbForKind(toolCall.kind)
    : verbForKind(toolCall.kind)

  // Subagent dispatch: render as the task name with no verb (the robot icon
  // carries the meaning), rather than the misleading "Thinking" of `think`.
  if (isSubagentCall(toolCall)) {
    return { verb: '', primary: toolCall.subagent.title, detail: null }
  }
  if (isSubagentControlCall(toolCall)) {
    return { verb: '', primary: title ?? 'Agent command', detail: null }
  }

  switch (toolCall.kind) {
    case 'read':
    case 'delete':
    case 'move': {
      const p = toolCallPath(toolCall)
      const primary = p ? baseName(p) : (title ?? 'file')
      return { verb, primary, detail: toolCall.kind === 'read' ? lineRange(input) : null }
    }
    case 'edit': {
      const diff = diffInfo(content)
      const p = toolCallPath(toolCall)
      const primary = p ? baseName(p) : (title ?? 'file')
      let detail: string | null = null
      let diffStat: { added: number; removed: number } | null = null
      if (diff.hasDiff) {
        diffStat = { added: diff.added, removed: diff.removed }
      } else {
        // Restored/recovered calls carry no diff `content` (never persisted);
        // the host-computed durable summary supplies the counts instead.
        diffStat = persistedDiffStat(toolCall.diffStat)
      }
      if (diffStat) {
        detail =
          diffStat.removed > 0
            ? `+${diffStat.added} \u2212${diffStat.removed}`
            : `+${diffStat.added}`
      }
      return { verb, primary, detail, diffStat }
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

type ActivityCategory =
  | 'command'
  | 'file-read'
  | 'file-created'
  | 'file-edited'
  | 'file-deleted'
  | 'file-moved'
  | 'search'
  | 'fetch'
  | 'agent'
  | 'background-agent'
  | 'agent-control'
  | 'mode'
  | 'other'

/**
 * Create-only edit: at least one diff item, and every diff created its file
 * (`oldText == null`). A mixed create+edit call, or a restored call with no
 * diff content at all, counts as an edit.
 */
function isFileCreation(call: ToolCall): boolean {
  const diffs = (call.content ?? []).filter((item) => item.type === 'diff')
  return (
    diffs.length > 0 && diffs.every((item) => (item as { oldText?: string | null }).oldText == null)
  )
}

/**
 * First-match-wins classification. Subagent checks lead because ACP gives
 * dispatches no dedicated kind — they arrive looking like `think`/`other`.
 */
const ACTIVITY_CATEGORY_RULES: ReadonlyArray<{
  category: ActivityCategory
  match: (call: ToolCall) => boolean
}> = [
  { category: 'agent-control', match: (call) => isSubagentControlCall(call) },
  { category: 'background-agent', match: (call) => call.subagent?.background === true },
  { category: 'agent', match: (call) => isSubagentCall(call) },
  { category: 'command', match: (call) => call.kind === 'execute' },
  { category: 'file-read', match: (call) => call.kind === 'read' },
  { category: 'file-created', match: (call) => call.kind === 'edit' && isFileCreation(call) },
  { category: 'file-edited', match: (call) => call.kind === 'edit' },
  { category: 'file-deleted', match: (call) => call.kind === 'delete' },
  { category: 'file-moved', match: (call) => call.kind === 'move' },
  { category: 'search', match: (call) => call.kind === 'search' },
  { category: 'fetch', match: (call) => call.kind === 'fetch' },
  { category: 'mode', match: (call) => call.kind === 'switch_mode' }
]

const ACTIVITY_PHRASES: Record<ActivityCategory, { one: string; many: (n: number) => string }> = {
  command: { one: 'ran 1 command', many: (n) => `ran ${n} commands` },
  'file-read': { one: 'read 1 file', many: (n) => `read ${n} files` },
  'file-created': { one: 'created 1 file', many: (n) => `created ${n} files` },
  'file-edited': { one: 'edited 1 file', many: (n) => `edited ${n} files` },
  'file-deleted': { one: 'deleted 1 file', many: (n) => `deleted ${n} files` },
  'file-moved': { one: 'moved 1 file', many: (n) => `moved ${n} files` },
  search: { one: 'ran 1 search', many: (n) => `ran ${n} searches` },
  fetch: { one: 'fetched 1 page', many: (n) => `fetched ${n} pages` },
  agent: { one: 'ran 1 agent', many: (n) => `ran ${n} agents` },
  'background-agent': {
    one: 'ran 1 background agent',
    many: (n) => `ran ${n} background agents`
  },
  'agent-control': {
    one: 'sent 1 agent command',
    many: (n) => `sent ${n} agent commands`
  },
  mode: { one: 'switched mode', many: (n) => `switched mode ${n} times` },
  other: { one: 'used 1 tool', many: (n) => `used ${n} tools` }
}

const THOUGHT_PHRASE = { one: 'thought', many: (n: number) => `thought ${n} times` }

/** `.t-think-text` is `nowrap`, so the phrase count is the label's length bound. */
const MAX_ACTIVITY_PHRASES = 4

export interface ToolActivitySummary {
  label: string
  added: number
  removed: number
}

/**
 * Roll tool calls into one categorized line for a collapsed activity
 * disclosure — "Ran 2 commands, created 1 file" — plus the summed diff
 * counts. A `thoughts` count leads the line: "Thought 3 times, ran 2
 * commands". Phrases appear in first-occurrence order; past the cap the label
 * tails off as "and N more", where N counts the unshown CALLS. Null when there
 * are neither calls nor thoughts.
 */
export function summarizeToolActivity(
  calls: ToolCall[],
  { thoughts = 0 }: { thoughts?: number } = {}
): ToolActivitySummary | null {
  if (calls.length === 0 && thoughts === 0) return null
  const counts = new Map<ActivityCategory, number>()
  let added = 0
  let removed = 0
  for (const call of calls) {
    const category = ACTIVITY_CATEGORY_RULES.find((rule) => rule.match(call))?.category ?? 'other'
    counts.set(category, (counts.get(category) ?? 0) + 1)
    const diffStat = describeToolCall(call).diffStat
    if (diffStat) {
      added += diffStat.added
      removed += diffStat.removed
    }
  }
  const entries = [...counts].map(([category, count]) => ({
    phrase: ACTIVITY_PHRASES[category],
    count
  }))
  if (thoughts > 0) entries.unshift({ phrase: THOUGHT_PHRASE, count: thoughts })
  const phrases = entries
    .slice(0, MAX_ACTIVITY_PHRASES)
    .map(({ phrase, count }) => (count === 1 ? phrase.one : phrase.many(count)))
  const hiddenCalls = entries.slice(MAX_ACTIVITY_PHRASES).reduce((sum, { count }) => sum + count, 0)
  let label = phrases.join(', ')
  if (hiddenCalls > 0) label += `, and ${hiddenCalls} more`
  return { label: label.charAt(0).toUpperCase() + label.slice(1), added, removed }
}
