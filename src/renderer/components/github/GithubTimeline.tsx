import type {
  GithubComment,
  GithubItemDetail,
  GithubTimelineEvent
} from '@shared/types/github.types'
import { useState } from 'react'
import {
  Bot,
  CircleCheck,
  CircleDot,
  GitMerge,
  Tag,
  type TermulIcon,
  User
} from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { formatRelativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { GithubMarkdown } from './GithubComment'
import { GithubAvatar, LabelChip } from './github-status'
import { plainPreview } from './plain-preview'

type TimelineEntry =
  | { kind: 'comment'; at: string; comment: GithubComment }
  | { kind: 'event'; at: string; event: GithubTimelineEvent }

/** GitHub records a ClosedEvent about a second after a merge; the merge already says it. */
const MERGE_CLOSE_WINDOW_MS = 5_000

function withoutMergeCloses(events: GithubTimelineEvent[]): GithubTimelineEvent[] {
  const merges = events
    .filter((event) => event.kind === 'merged')
    .map((event) => Date.parse(event.createdAt))
  return events.filter((event) => {
    if (event.kind !== 'closed') return true
    const at = Date.parse(event.createdAt)
    return !merges.some((merged) => at >= merged && at - merged <= MERGE_CLOSE_WINDOW_MS)
  })
}

/** Comments and events, oldest first; equal times keep comments before events. */
function timelineEntries(detail: GithubItemDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...detail.comments.map((comment) => ({
      kind: 'comment' as const,
      at: comment.createdAt,
      comment
    })),
    ...withoutMergeCloses(detail.timeline).map((event) => ({
      kind: 'event' as const,
      at: event.createdAt,
      event
    }))
  ]
  return entries
    .map((entry, index) => ({ entry, index, time: Date.parse(entry.at) || 0 }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(({ entry }) => entry)
}

function When({ iso }: { iso: string }): React.JSX.Element {
  return (
    <time
      dateTime={iso}
      title={new Date(iso).toLocaleString()}
      className="shrink-0 tabular-nums text-muted-foreground"
    >
      {formatRelativeTime(iso)}
    </time>
  )
}

/**
 * The item's conversation as one flat column (mockup D): the description as
 * the opening post, then comments and label / assignee / state events in
 * time order. Bot comments start folded to one line.
 */
export function GithubTimeline({
  detail,
  scope
}: {
  detail: GithubItemDetail
  /** Link-confirm scope prefix (the item key). */
  scope: string
}): React.JSX.Element {
  const { item } = detail
  return (
    <ol aria-label="Conversation" className="flex min-w-0 flex-col">
      <TimelineRow rail={<GithubAvatar login={item.author} />}>
        <p className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="min-w-0 truncate font-medium text-foreground">{item.author}</span>
          <span className="shrink-0 text-muted-foreground">opened</span>
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <When iso={detail.createdAt} />
        </p>
        <section aria-label="Description" className="min-w-0 pt-1">
          {detail.body.trim() ? (
            <GithubMarkdown text={detail.body} scope={`${scope}-body`} />
          ) : (
            <p className="text-sm italic text-muted-foreground">No description provided.</p>
          )}
        </section>
      </TimelineRow>
      {timelineEntries(detail).map((entry) =>
        entry.kind === 'comment' ? (
          entry.comment.isBot ? (
            <BotComment key={entry.comment.id} comment={entry.comment} />
          ) : (
            <TimelineRow
              key={entry.comment.id}
              rail={<GithubAvatar login={entry.comment.author} />}
            >
              <article aria-label={`Comment by ${entry.comment.author}`} className="min-w-0">
                <p className="flex min-w-0 items-center gap-1.5 text-xs">
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {entry.comment.author}
                  </span>
                  <span aria-hidden="true" className="text-muted-foreground">
                    ·
                  </span>
                  <When iso={entry.comment.createdAt} />
                </p>
                <div className="min-w-0 pt-1">
                  {entry.comment.body.trim() ? (
                    <GithubMarkdown text={entry.comment.body} scope={entry.comment.id} />
                  ) : (
                    <p className="text-xs italic text-muted-foreground">No content.</p>
                  )}
                </div>
              </article>
            </TimelineRow>
          )
        ) : (
          <EventRow key={entry.event.id} event={entry.event} />
        )
      )}
    </ol>
  )
}

/** One timeline entry: a 32px rail glyph on a vertical line, then the content. */
function TimelineRow({
  rail,
  compact = false,
  children
}: {
  rail: React.ReactNode
  /** Events sit closer together than posts. */
  compact?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="relative flex min-w-0 gap-3 pb-5 before:absolute before:bottom-0 before:left-4 before:top-0 before:w-px before:bg-border last:before:hidden">
      <span className={cn('relative z-[1] flex w-8 shrink-0 justify-center', compact && 'pt-0.5')}>
        {rail}
      </span>
      <div className="min-w-0 flex-1 pt-1.5">{children}</div>
    </li>
  )
}

function BotComment({ comment }: { comment: GithubComment }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const preview = plainPreview(comment.body)
  return (
    <TimelineRow
      rail={
        <span className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Bot size={16} aria-hidden="true" />
        </span>
      }
    >
      <article
        aria-label={`Comment by ${comment.author} (bot)`}
        className="-mt-1 min-w-0 rounded-xl border border-border"
      >
        <div className="flex min-h-10 min-w-0 items-center gap-2 px-3 text-xs">
          <span className="shrink-0 font-medium text-foreground">{comment.author}</span>
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-3xs text-muted-foreground">
            bot
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {open ? <When iso={comment.createdAt} /> : preview}
          </span>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} comment by ${comment.author}`}
            onClick={() => setOpen(!open)}
            className={cn(
              'relative shrink-0 rounded-md px-1 font-medium text-primary',
              "after:absolute after:-inset-2 after:content-['']",
              FOCUS_RING_CLASS
            )}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
        {open && (
          <div className="min-w-0 border-t border-border px-3 py-2">
            <GithubMarkdown text={comment.body} scope={comment.id} />
          </div>
        )}
      </article>
    </TimelineRow>
  )
}

const EVENT_LOOK: Record<GithubTimelineEvent['kind'], { Icon: TermulIcon; verb: string }> = {
  labeled: { Icon: Tag, verb: 'added' },
  unlabeled: { Icon: Tag, verb: 'removed' },
  assigned: { Icon: User, verb: 'assigned' },
  unassigned: { Icon: User, verb: 'unassigned' },
  closed: { Icon: CircleCheck, verb: 'closed this' },
  merged: { Icon: GitMerge, verb: 'merged this' },
  reopened: { Icon: CircleDot, verb: 'reopened this' }
}

function EventRow({ event }: { event: GithubTimelineEvent }): React.JSX.Element {
  const { Icon, verb } = EVENT_LOOK[event.kind]
  const self = event.assignee !== null && event.assignee === event.actor
  return (
    <TimelineRow
      compact
      rail={<Icon size={16} aria-hidden="true" className="mt-1 text-muted-foreground" />}
    >
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{event.actor || 'Someone'}</span>
        <span>
          {(event.kind === 'assigned' || event.kind === 'unassigned') && self
            ? event.kind === 'assigned'
              ? 'self-assigned this'
              : 'removed their assignment'
            : verb}
        </span>
        {event.label && <LabelChip label={event.label} />}
        {event.assignee && !self && (
          <span className="font-medium text-foreground">{event.assignee}</span>
        )}
        <span aria-hidden="true">·</span>
        <When iso={event.createdAt} />
      </p>
    </TimelineRow>
  )
}
