/**
 * Pure helpers for rendering tool calls and permission options. No React/store
 * dependency, so they're directly unit-testable.
 */
import type {
  ToolKind,
  ToolCallStatus,
  DiffContent,
  PermissionOption
} from '@/lib/acp-api'

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
  type: 'added' | 'removed'
  text: string
}

/** Split a diff into removed (old) then added (new) lines for stacked rendering. */
export function diffLines(diff: Pick<DiffContent, 'oldText' | 'newText'>): DiffLine[] {
  const lines: DiffLine[] = []
  const oldText = diff.oldText ?? ''
  if (oldText.length > 0) {
    for (const l of oldText.split('\n')) lines.push({ type: 'removed', text: l.replace(/\r$/, '') })
  }
  const newText = diff.newText ?? ''
  if (newText.length > 0) {
    for (const l of newText.split('\n')) lines.push({ type: 'added', text: l.replace(/\r$/, '') })
  }
  return lines
}

export function diffLineCounts(diff: Pick<DiffContent, 'oldText' | 'newText'>): {
  added: number
  removed: number
} {
  const removed = (diff.oldText ?? '').length > 0 ? (diff.oldText ?? '').split('\n').length : 0
  const added = (diff.newText ?? '').length > 0 ? (diff.newText ?? '').split('\n').length : 0
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

/** Pick a reject option for an Escape/dismiss action, or null if none exists. */
export function pickRejectOption(options: PermissionOption[]): PermissionOption | null {
  return options.find(isRejectOption) ?? null
}
