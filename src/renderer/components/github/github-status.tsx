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
  XCircle
} from '@/components/icons'
import { formatRelativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'

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
  state
}: {
  kind: GithubItemKind
  state: GithubItemState
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
      {look.label}
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

const ROLLUP_LABEL: Record<GithubCheckRollup, string> = {
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

const HEX_COLOR = /^[0-9a-f]{6}$/i

/**
 * A label chip in theme ink. GitHub's label colour shows only as the dot: raw
 * label colours are often unreadable as text on a dark or light theme.
 */
export function LabelChip({ label }: { label: GithubLabel }): React.JSX.Element {
  const color = HEX_COLOR.test(label.color) ? `#${label.color}` : undefined
  return (
    <span className="inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-full border border-border px-1.5 text-3xs text-muted-foreground">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full bg-muted-foreground"
        style={color ? { backgroundColor: color } : undefined}
      />
      <span className="truncate">{label.name}</span>
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
