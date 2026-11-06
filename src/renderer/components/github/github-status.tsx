import type {
  GithubCheckRollup,
  GithubCheckStatus,
  GithubItemKind,
  GithubItemState,
  GithubLabel
} from '@shared/types/github.types'
import {
  CheckCircle2,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type TermulIcon,
  X,
  XCircle
} from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { formatRelativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { labelColors, useSurfaceHex } from './label-color'

interface StatusLook {
  label: string
  Icon: TermulIcon
  /** Glyph ink. */
  text: string
  /** Pill wash + ink (docs/design/status.md). */
  pill: string
}

const NEUTRAL_PILL = 'bg-foreground/10 text-foreground'
const MUTED_PILL = 'bg-muted text-muted-foreground'

/**
 * Item state as GitHub reports it, per kind. Open is the live state
 * (`success`); a PR closed without merging is `destructive`; merged and a
 * closed issue are finished work, so they stay neutral. Every look pairs the
 * colour with its icon and word.
 */
const ITEM_STATE_LOOK: Record<GithubItemKind, Record<GithubItemState, StatusLook>> = {
  issue: {
    open: {
      label: 'Open',
      Icon: CircleDot,
      text: 'text-success',
      pill: 'bg-success/20 text-success'
    },
    closed: {
      label: 'Closed',
      Icon: CircleCheck,
      text: 'text-muted-foreground',
      pill: NEUTRAL_PILL
    },
    // Issues are never merged or drafts; kept total so a host change cannot crash the row.
    merged: {
      label: 'Closed',
      Icon: CircleCheck,
      text: 'text-muted-foreground',
      pill: NEUTRAL_PILL
    },
    draft: {
      label: 'Open',
      Icon: CircleDot,
      text: 'text-success',
      pill: 'bg-success/20 text-success'
    }
  },
  pr: {
    open: {
      label: 'Open',
      Icon: GitPullRequest,
      text: 'text-success',
      pill: 'bg-success/20 text-success'
    },
    draft: {
      label: 'Draft',
      Icon: GitPullRequestDraft,
      text: 'text-muted-foreground',
      pill: MUTED_PILL
    },
    merged: { label: 'Merged', Icon: GitMerge, text: 'text-foreground', pill: NEUTRAL_PILL },
    closed: {
      label: 'Closed',
      Icon: GitPullRequestClosed,
      text: 'text-destructive',
      pill: 'bg-destructive/20 text-destructive'
    }
  }
}

export function itemStateLook(kind: GithubItemKind, state: GithubItemState): StatusLook {
  return ITEM_STATE_LOOK[kind][state]
}

const KIND_NOUN: Record<GithubItemKind, string> = { issue: 'Issue', pr: 'Pull request' }

/** The item's state glyph; its accessible name says kind and state ("Open pull request"). */
export function ItemStateIcon({
  kind,
  state,
  size = 14,
  className
}: {
  kind: GithubItemKind
  state: GithubItemState
  size?: number
  className?: string
}): React.JSX.Element {
  const look = itemStateLook(kind, state)
  return (
    <look.Icon
      size={size}
      role="img"
      aria-label={`${look.label} ${KIND_NOUN[kind].toLowerCase()}`}
      className={cn('shrink-0', look.text, className)}
    />
  )
}

export function ItemStatePill({
  kind,
  state,
  label
}: {
  kind: GithubItemKind
  state: GithubItemState
  /** Replaces the state word ("Closed as not planned"). */
  label?: string
}): React.JSX.Element {
  const look = itemStateLook(kind, state)
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium',
        look.pill
      )}
    >
      <look.Icon size={14} aria-hidden="true" />
      {label ?? look.label}
    </span>
  )
}

const CHECK_LOOK: Record<GithubCheckStatus, { label: string; Icon: TermulIcon; text: string }> = {
  success: { label: 'Passed', Icon: CheckCircle2, text: 'text-success' },
  failure: { label: 'Failed', Icon: XCircle, text: 'text-destructive' },
  pending: { label: 'Pending', Icon: CircleDashed, text: 'text-warning' },
  skipped: { label: 'Skipped', Icon: CircleMinus, text: 'text-muted-foreground' },
  neutral: { label: 'Neutral', Icon: CircleMinus, text: 'text-muted-foreground' },
  cancelled: { label: 'Cancelled', Icon: CircleMinus, text: 'text-muted-foreground' }
}

export function checkLook(status: GithubCheckStatus) {
  return CHECK_LOOK[status]
}

export const ROLLUP_LABEL: Record<GithubCheckRollup, string> = {
  success: 'Checks passed',
  failure: 'Checks failed',
  pending: 'Checks running'
}

/** Check glyph with its status as the accessible name (and tooltip). */
export function CheckStatusIcon({
  status,
  label,
  size = 14
}: {
  status: GithubCheckStatus
  /** Overrides the status word, e.g. the rollup's "Checks failed". */
  label?: string
  size?: number
}): React.JSX.Element {
  const look = CHECK_LOOK[status]
  const name = label ?? look.label
  return (
    <span title={name} className="inline-flex shrink-0">
      <look.Icon size={size} role="img" aria-label={name} className={look.text} />
    </span>
  )
}

export function CheckRollupIcon({ rollup }: { rollup: GithubCheckRollup }): React.JSX.Element {
  return <CheckStatusIcon status={rollup} label={ROLLUP_LABEL[rollup]} />
}

/**
 * A label chip tinted with its GitHub colour through {@link labelColors}: the
 * ink is contrast-checked against the washed chip on `surface`, so a dark
 * label on a dark theme stays readable. A colour that is not six hex digits
 * (or a theme not applied yet) leaves the chip neutral.
 */
export function LabelChip({
  label,
  size = 'sm',
  surface = '--background',
  onRemove,
  removeDisabled
}: {
  label: GithubLabel
  /** `sm` in list rows, `md` on the item page and in pickers. */
  size?: 'sm' | 'md'
  surface?: '--background' | '--popover'
  /** Adds an x that calls this (active filter chips, picker selections). */
  onRemove?: () => void
  removeDisabled?: boolean
}): React.JSX.Element {
  const colors = labelColors(label.color, useSurfaceHex(surface))
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full shrink-0 items-center gap-1 rounded-full border',
        size === 'sm' ? 'h-5 px-1.5 text-3xs' : 'h-6 px-2 text-xs',
        colors ? null : 'border-border text-muted-foreground',
        onRemove && 'pr-0.5'
      )}
      style={
        colors
          ? { color: colors.ink, backgroundColor: colors.wash, borderColor: colors.edge }
          : undefined
      }
    >
      <span
        aria-hidden="true"
        className={cn('size-2 shrink-0 rounded-full', colors ? null : 'bg-muted-foreground')}
        style={colors ? { backgroundColor: colors.ink } : undefined}
      />
      <span className="truncate">{label.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removeDisabled}
          aria-label={`Remove ${label.name}`}
          className={cn(
            'relative inline-flex size-4 shrink-0 items-center justify-center rounded-full opacity-80 hover:opacity-100 disabled:opacity-40',
            "after:absolute after:-inset-2 after:content-['']",
            FOCUS_RING_CLASS
          )}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  )
}

/** A label's colour as a dot (picker rows), contrast-checked like {@link LabelChip}. */
export function LabelDot({
  color,
  surface = '--popover'
}: {
  color: string
  surface?: '--background' | '--popover'
}): React.JSX.Element {
  const colors = labelColors(color, useSurfaceHex(surface))
  return (
    <span
      aria-hidden="true"
      className={cn('size-2.5 shrink-0 rounded-full', colors ? null : 'bg-muted-foreground')}
      style={colors ? { backgroundColor: colors.ink } : undefined}
    />
  )
}

/** A login's initials in a circle. Avatars are never fetched. */
export function GithubAvatar({
  login,
  size = 'md'
}: {
  login: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const initial =
    login
      .replace(/[^A-Za-z0-9]/g, '')
      .charAt(0)
      .toUpperCase() || '?'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 select-none items-center justify-center rounded-full bg-foreground/10 font-medium text-foreground',
        size === 'sm' ? 'size-5 text-3xs' : 'size-8 text-xs'
      )}
    >
      {initial}
    </span>
  )
}

/** A GitHub item tab's name: `#123 Title`, or `#123` before any title is known. */
export function githubItemTabLabel(number: number, title: string): string {
  return title ? `#${number} ${title}` : `#${number}`
}

/** "5m ago", "just now", or "on Mar 3, 2026" for older dates. */
export function relativeAgo(iso: string): string {
  const relative = formatRelativeTime(iso)
  if (!relative) return 'earlier'
  if (relative === 'now') return 'just now'
  return /^\d+[mhdw]$/.test(relative) ? `${relative} ago` : `on ${relative}`
}
