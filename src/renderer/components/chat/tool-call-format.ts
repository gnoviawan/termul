/**
 * Pure helpers for rendering tool calls and permission options. No React/store
 * dependency, so they're directly unit-testable.
 */
import type {
  DiffContent,
  PermissionOption,
  ToolCall,
  ToolCallStatus,
  ToolKind
} from '@/lib/acp-api'
import { isSubagentCall } from './tool-call-summary'

export type ToolIconName =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch'
  | 'agent'
  | 'tool'

/** Map an ACP tool kind to a stable icon name (unknown → generic 'tool'). */
export function kindIcon(kind: ToolKind | undefined): ToolIconName {
  switch (kind) {
    case 'read':
      return 'read'
    case 'edit':
      return 'edit'
    case 'delete':
      return 'delete'
    case 'move':
      return 'move'
    case 'search':
      return 'search'
    case 'execute':
      return 'execute'
    case 'think':
      return 'think'
    case 'fetch':
      return 'fetch'
    case 'switch_mode':
      return 'switch'
    default:
      return 'tool'
  }
}

/**
 * Icon name for a full tool call. Subagent/Task dispatches get the 'agent'
 * (robot) icon regardless of their reported kind; everything else falls back
 * to the kind-based mapping.
 */
export function toolIconName(toolCall: ToolCall): ToolIconName {
  if (isSubagentCall(toolCall)) return 'agent'
  return kindIcon(toolCall.kind)
}

export interface StatusStyle {
  label: string
  /** Tailwind classes for the status badge. */
  className: string
  /** Whether this represents an in-flight call (drives a spinner). */
  spinning: boolean
}

export function statusStyle(status: ToolCallStatus | undefined): StatusStyle {
  switch (status) {
    case 'in_progress':
      return { label: 'running', className: 'text-amber-400 bg-amber-400/10', spinning: true }
    case 'completed':
      return { label: 'done', className: 'text-green-400 bg-green-400/10', spinning: false }
    case 'failed':
      return { label: 'failed', className: 'text-red-400 bg-red-400/10', spinning: false }
    case 'pending':
    default:
      return { label: 'pending', className: 'text-muted-foreground bg-muted/40', spinning: false }
  }
}

export interface DiffLine {
  type: 'added' | 'removed' | 'context'
  text: string
  /** 1-based line number in the old (left) file; absent for pure additions. */
  oldLine?: number
  /** 1-based line number in the new (right) file; absent for pure removals. */
  newLine?: number
}

/** Split text into lines, dropping the spurious trailing empty segment that
 * `split('\n')` produces when the text ends with a newline, and trimming a
 * trailing CR so CRLF content renders cleanly. */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.map((l) => l.replace(/\r$/, ''))
}

/**
 * Compute the LCS table for two string arrays.
 * Returns a 2D table where table[i][j] = length of LCS of a[0..i-1] and b[0..j-1].
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      table[i][j] =
        a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i][j - 1], table[i - 1][j])
    }
  }
  return table
}

/**
 * Backtrack through the LCS table to produce a unified-style diff.
 * Returns DiffLine entries with context lines around changes.
 *
 * @param contextLines - Number of unchanged context lines to show around each change (default 3).
 */
function computeDiffLines(oldLines: string[], newLines: string[], contextLines = 3): DiffLine[] {
  const table = lcsTable(oldLines, newLines)

  // Walk back through the table to produce the raw edit script
  type EditOp = { type: 'keep' | 'remove' | 'insert'; text: string; oldIdx: number; newIdx: number }
  const ops: EditOp[] = []
  let i = oldLines.length
  let j = newLines.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'keep', text: oldLines[i - 1], oldIdx: i, newIdx: j })
      i--
      j--
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.push({ type: 'insert', text: newLines[j - 1], oldIdx: i, newIdx: j })
      j--
    } else {
      ops.push({ type: 'remove', text: oldLines[i - 1], oldIdx: i, newIdx: j })
      i--
    }
  }
  ops.reverse()

  // Convert to DiffLines with context folding
  // Mark each op as "near a change" or not, then expand context around changes
  const isChange = ops.map((op) => op.type !== 'keep')

  // Determine which context lines to keep (near changes)
  const keep = new Array(ops.length).fill(false)
  for (let k = 0; k < ops.length; k++) {
    if (isChange[k]) {
      // Expand context around this change
      const lo = Math.max(0, k - contextLines)
      const hi = Math.min(ops.length - 1, k + contextLines)
      for (let c = lo; c <= hi; c++) keep[c] = true
    }
  }

  // Build output, inserting ellipsis markers between non-adjacent kept regions
  const result: DiffLine[] = []
  let lastKeptIdx = -1
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) continue
    const op = ops[k]
    // Insert a gap marker if there's a skipped region
    if (lastKeptIdx >= 0 && k > lastKeptIdx + 1) {
      result.push({ type: 'context', text: '···' })
    }
    switch (op.type) {
      case 'keep':
        result.push({ type: 'context', text: op.text, oldLine: op.oldIdx, newLine: op.newIdx })
        break
      case 'remove':
        result.push({ type: 'removed', text: op.text, oldLine: op.oldIdx })
        break
      case 'insert':
        result.push({ type: 'added', text: op.text, newLine: op.newIdx })
        break
    }
    lastKeptIdx = k
  }
  return result
}

/**
 * Compute diff lines from full file contents (oldText/newText), showing only
 * the actual changed lines with surrounding context — not the entire file.
 */
export function diffLines(diff: Pick<DiffContent, 'oldText' | 'newText'>): DiffLine[] {
  const oldLines = splitLines(diff.oldText ?? '')
  const newLines = splitLines(diff.newText ?? '')

  // If no oldText, this is a new file — show all lines as added
  if (diff.oldText == null || diff.oldText === '') {
    return newLines.map((text, idx) => ({ type: 'added' as const, text, newLine: idx + 1 }))
  }

  // If no newText, this is a deletion — show all lines as removed
  if (diff.newText === '') {
    return oldLines.map((text, idx) => ({ type: 'removed' as const, text, oldLine: idx + 1 }))
  }

  return computeDiffLines(oldLines, newLines)
}

/**
 * Count actual added/removed lines by computing a proper diff, not by
 * counting all lines in oldText/newText (which are full file contents, not
 * just the changed portions).
 */
export function diffLineCounts(diff: Pick<DiffContent, 'oldText' | 'newText'>): {
  added: number
  removed: number
} {
  const oldLines = splitLines(diff.oldText ?? '')
  const newLines = splitLines(diff.newText ?? '')

  // New file: all lines are additions
  if (diff.oldText == null || diff.oldText === '') {
    return { added: newLines.length, removed: 0 }
  }

  // Deleted file: all lines are removals
  if (diff.newText === '') {
    return { added: 0, removed: oldLines.length }
  }

  // Compute LCS to count actual changes
  const table = lcsTable(oldLines, newLines)
  const lcsLen = table[oldLines.length][newLines.length]
  return {
    added: newLines.length - lcsLen,
    removed: oldLines.length - lcsLen
  }
}

/** True if an option kind rejects (declines) the operation. */
export function isRejectOption(option: PermissionOption): boolean {
  return option.kind === 'reject_once' || option.kind === 'reject_always'
}

/** True if an option kind allows the operation. */
export function isAllowOption(option: PermissionOption): boolean {
  return option.kind === 'allow_once' || option.kind === 'allow_always'
}

/** Pick a reject option for an Escape/dismiss action, or null if none exists. */
export function pickRejectOption(options: PermissionOption[]): PermissionOption | null {
  return options.find(isRejectOption) ?? null
}
