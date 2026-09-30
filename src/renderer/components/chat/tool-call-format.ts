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
      return { label: 'running', className: 'text-warning bg-warning/10', spinning: true }
    case 'completed':
      return { label: 'done', className: 'text-success bg-success/10', spinning: false }
    case 'failed':
      return { label: 'failed', className: 'text-destructive bg-destructive/10', spinning: false }
    case 'pending':
    default:
      return {
        label: 'pending',
        className: 'text-muted-foreground bg-secondary/60',
        spinning: false
      }
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
 * Work bound for the quadratic path: max (trimmed) cells in the LCS table
 * before switching to the anchor-chained diff. 2M Int32 cells ≈ 8MB and
 * tens of ms — the ceiling before the diff itself becomes the jank.
 */
const MAX_LCS_CELLS = 2_000_000

/** Depth cap on the anchor-chained diff; degenerate inputs dump as-is. */
const MAX_ANCHOR_DEPTH = 24

interface EditOp {
  type: 'keep' | 'remove' | 'insert'
  text: string
  /** 1-based source line (keeps/removes). */
  oldIdx: number
  /** 1-based target line (keeps/inserts). */
  newIdx: number
}

/**
 * Common-prefix length of two ranges (index-bounded, never slices).
 */
function commonPrefix(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number
): number {
  let k = 0
  while (a0 + k < a1 && b0 + k < b1 && a[a0 + k] === b[b0 + k]) k++
  return k
}

/**
 * Common-suffix length of two ranges, exclusive of the first `skip` lines
 * already consumed by the shared prefix.
 */
function commonSuffix(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  skip: number
): number {
  let k = 0
  while (a1 - 1 - k >= a0 + skip && b1 - 1 - k >= b0 + skip && a[a1 - 1 - k] === b[b1 - 1 - k]) k++
  return k
}

/**
 * LCS table over the index ranges [a0,a1) × [b0,b1) as a flat Int32Array —
 * 4 bytes/cell instead of a boxed number[][] (~8× smaller).
 */
function lcsEmit(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  ops: EditOp[]
): void {
  const m = a1 - a0
  const n = b1 - b0
  const stride = n + 1
  const table = new Int32Array((m + 1) * stride)
  for (let i = 1; i <= m; i++) {
    const row = i * stride
    const prev = row - stride
    for (let j = 1; j <= n; j++) {
      table[row + j] =
        a[a0 + i - 1] === b[b0 + j - 1]
          ? table[prev + j - 1] + 1
          : Math.max(table[row + j - 1], table[prev + j])
    }
  }
  // Backtrack into a scratch stack, then emit reversed (ops must be
  // appended in forward order — the caller folds context top-down).
  const tail: EditOp[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[a0 + i - 1] === b[b0 + j - 1]) {
      tail.push({ type: 'keep', text: a[a0 + i - 1], oldIdx: a0 + i, newIdx: b0 + j })
      i--
      j--
    } else if (j > 0 && (i === 0 || table[i * stride + j - 1] >= table[(i - 1) * stride + j])) {
      tail.push({ type: 'insert', text: b[b0 + j - 1], oldIdx: a0 + i, newIdx: b0 + j })
      j--
    } else {
      tail.push({ type: 'remove', text: a[a0 + i - 1], oldIdx: a0 + i, newIdx: b0 + j })
      i--
    }
  }
  for (let k = tail.length - 1; k >= 0; k--) ops.push(tail[k])
}

/** Truthful fallback: every old line removed, every new line added. */
function dumpRange(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  ops: EditOp[]
): void {
  for (let i = a0; i < a1; i++) {
    ops.push({ type: 'remove', text: a[i], oldIdx: i + 1, newIdx: b0 })
  }
  for (let j = b0; j < b1; j++) {
    ops.push({ type: 'insert', text: b[j], oldIdx: a1, newIdx: j + 1 })
  }
}

/**
 * Anchor-chained diff (patience-style): lines unique on BOTH sides are
 * unambiguous anchors; segments between consecutive anchors recurse.
 * Linear-ish on real edits (unique lines abound in code); the depth cap
 * bounds worst-case adversarial input to the truthful dump.
 */
function anchorEmit(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  ops: EditOp[],
  depth: number
): void {
  const countA = new Map<string, number>()
  for (let i = a0; i < a1; i++) countA.set(a[i], (countA.get(a[i]) ?? 0) + 1)
  const countB = new Map<string, number>()
  for (let j = b0; j < b1; j++) countB.set(b[j], (countB.get(b[j]) ?? 0) + 1)
  // b-index of lines unique in both ranges
  const bUnique = new Map<string, number>()
  for (let j = b0; j < b1; j++) {
    const line = b[j]
    if (countB.get(line) === 1 && countA.get(line) === 1) bUnique.set(line, j)
  }
  // Greedy increasing chain: scan a in order, keep anchors whose b index
  // is strictly rising (the largest increasing subsequence is ideal but
  // unnecessary — any monotonic chain gives valid recursion boundaries).
  const anchors: Array<[number, number]> = []
  let lastB = -1
  for (let i = a0; i < a1; i++) {
    if (countA.get(a[i]) !== 1) continue
    const bi = bUnique.get(a[i])
    if (bi !== undefined && bi > lastB) {
      anchors.push([i, bi])
      lastB = bi
    }
  }
  if (anchors.length === 0) {
    dumpRange(a, b, a0, a1, b0, b1, ops)
    return
  }
  let pa = a0
  let pb = b0
  for (const [ai, bi] of anchors) {
    diffRange(a, b, pa, ai, pb, bi, ops, depth + 1)
    ops.push({ type: 'keep', text: a[ai], oldIdx: ai + 1, newIdx: bi + 1 })
    pa = ai + 1
    pb = bi + 1
  }
  diffRange(a, b, pa, a1, pb, b1, ops, depth + 1)
}

/**
 * Emit edit ops for [a0,a1) → [b0,b1): trim shared edges (both trimming
 * and the line counts above turn 13k-line mostly-same files into the
 * changed span), then the LCS backtrack when the middle fits the work
 * bound, else the anchor chain. The dump fallback always terminates.
 */
function diffRange(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  ops: EditOp[],
  depth: number
): void {
  const head = commonPrefix(a, b, a0, a1, b0, b1)
  for (let k = 0; k < head; k++) {
    ops.push({ type: 'keep', text: a[a0 + k], oldIdx: a0 + k + 1, newIdx: b0 + k + 1 })
  }
  a0 += head
  b0 += head
  const tail = commonSuffix(a, b, a0, a1, b0, b1, 0)
  const aEnd = a1 - tail
  const bEnd = b1 - tail
  if (aEnd - a0 === 0 || bEnd - b0 === 0) {
    // One side empty after trimming: pure remove or pure insert.
    dumpRange(a, b, a0, aEnd, b0, bEnd, ops)
  } else if ((aEnd - a0) * (bEnd - b0) <= MAX_LCS_CELLS) {
    lcsEmit(a, b, a0, aEnd, b0, bEnd, ops)
  } else if (depth < MAX_ANCHOR_DEPTH) {
    anchorEmit(a, b, a0, aEnd, b0, bEnd, ops, depth)
  } else {
    dumpRange(a, b, a0, aEnd, b0, bEnd, ops)
  }
  for (let k = 0; k < tail; k++) {
    ops.push({ type: 'keep', text: a[aEnd + k], oldIdx: aEnd + k + 1, newIdx: bEnd + k + 1 })
  }
}

/** All edit ops between two line arrays — bounded work on any input size. */
function diffOps(oldLines: string[], newLines: string[]): EditOp[] {
  const ops: EditOp[] = []
  diffRange(oldLines, newLines, 0, oldLines.length, 0, newLines.length, ops, 0)
  return ops
}

/**
 * Fold ops into DiffLines with context: unchanged lines more than
 * `contextLines` away from any change collapse into a '···' marker.
 */
function foldContext(ops: EditOp[], contextLines: number): DiffLine[] {
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'keep') {
      const lo = Math.max(0, k - contextLines)
      const hi = Math.min(ops.length - 1, k + contextLines)
      for (let c = lo; c <= hi; c++) keep[c] = true
    }
  }
  const result: DiffLine[] = []
  let lastKeptIdx = -1
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) continue
    const op = ops[k]
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

  return foldContext(diffOps(oldLines, newLines), 3)
}

/**
 * Count actual added/removed lines by computing a proper diff, not by
 * counting all lines in oldText/newText (which are full file contents, not
 * just the changed portions). Shares the same bounded diff as diffLines.
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

  let added = 0
  let removed = 0
  for (const op of diffOps(oldLines, newLines)) {
    if (op.type === 'insert') added++
    else if (op.type === 'remove') removed++
  }
  return { added, removed }
}

/** True if an option kind rejects (declines) the operation. */
export function isRejectOption(option: PermissionOption): boolean {
  return option.kind === 'reject_once' || option.kind === 'reject_always'
}

/** True if an option kind allows the operation. */
export function isAllowOption(option: PermissionOption): boolean {
  return option.kind === 'allow_once' || option.kind === 'allow_always'
}

/**
 * Pick a reject option for an Escape/dismiss action, or null if none exists.
 * Prefer the narrowest reject (`reject_once`) when both once/always are offered.
 */
export function pickRejectOption(options: PermissionOption[]): PermissionOption | null {
  const rejects = options.filter(isRejectOption)
  if (rejects.length === 0) return null
  return rejects.find((o) => o.kind === 'reject_once') ?? rejects[0]
}

/**
 * Prefer the narrowest allow (`allow_once`) as the single primary action;
 * fall back to the first allow option when only broader allows exist.
 */
export function pickPrimaryAllowOption(options: PermissionOption[]): PermissionOption | null {
  const allows = options.filter(isAllowOption)
  if (allows.length === 0) return null
  return allows.find((o) => o.kind === 'allow_once') ?? allows[0]
}
