/**
 * Pure helpers for rendering tool calls and permission options. No React/store
 * dependency, so they're directly unit-testable.
 */
import type { DiffContent, PermissionOption, ToolCallStatus, ToolKind } from '@/lib/acp-api'

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
      return {
        label: 'running',
        className: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
        spinning: true
      }
    case 'completed':
      return {
        label: 'done',
        className: 'text-green-600 dark:text-green-400 bg-green-500/10',
        spinning: false
      }
    case 'failed':
      return {
        label: 'failed',
        className: 'text-red-600 dark:text-red-400 bg-red-500/10',
        spinning: false
      }
    case 'pending':
    default:
      return { label: 'pending', className: 'text-muted-foreground bg-muted/40', spinning: false }
  }
}

export interface DiffLine {
  type: 'added' | 'removed'
  text: string
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

/** Split a diff into removed (old) then added (new) lines for stacked rendering. */
export function diffLines(diff: Pick<DiffContent, 'oldText' | 'newText'>): DiffLine[] {
  const lines: DiffLine[] = []
  for (const l of splitLines(diff.oldText ?? '')) lines.push({ type: 'removed', text: l })
  for (const l of splitLines(diff.newText ?? '')) lines.push({ type: 'added', text: l })
  return lines
}

export function diffLineCounts(diff: Pick<DiffContent, 'oldText' | 'newText'>): {
  added: number
  removed: number
} {
  return {
    removed: splitLines(diff.oldText ?? '').length,
    added: splitLines(diff.newText ?? '').length
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
