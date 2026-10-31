import type { GithubListItem } from '@shared/types/github.types'
import { Comment } from '@/components/icons'
import { formatRelativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { CheckRollupIcon, ItemStateIcon, itemStateLook, LabelChip } from './github-status'

/** Labels shown on a row; the rest fold into `+N`. */
const MAX_ROW_LABELS = 3

interface GithubListRowProps {
  item: GithubListItem
  /** This item's tab is the one on screen. */
  isActive: boolean
  onOpen: (item: GithubListItem) => void
}

/**
 * One issue or PR: state glyph, title, then `#n · author · updated` with the
 * comment count and the PR's check rollup, then its labels.
 */
export function GithubListRow({ item, isActive, onOpen }: GithubListRowProps): React.JSX.Element {
  const updated = formatRelativeTime(item.updatedAt)
  const stateWord = itemStateLook(item.kind, item.state).label
  const kindWord = item.kind === 'pr' ? 'pull request' : 'issue'
  const shownLabels = item.labels.slice(0, MAX_ROW_LABELS)
  const hiddenLabels = item.labels.length - shownLabels.length

  return (
    <li>
      <button
        type="button"
        data-github-item={item.number}
        onClick={() => onOpen(item)}
        aria-current={isActive ? 'true' : undefined}
        aria-label={`${stateWord} ${kindWord} #${item.number}: ${item.title}`}
        title={item.title}
        className={cn(
          'flex w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ease-out',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          isActive ? 'keycap' : 'hover:bg-foreground/[0.03]'
        )}
      >
        <span className="mt-0.5 flex">
          <ItemStateIcon kind={item.kind} state={item.state} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="line-clamp-2 break-words text-xs font-medium text-foreground pointer-coarse:text-sm">
            {item.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="shrink-0 tabular-nums">#{item.number}</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{item.author}</span>
            {updated && (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0 tabular-nums">{updated}</span>
              </>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {item.commentCount > 0 && (
                <span
                  className="flex items-center gap-0.5 tabular-nums"
                  title={`${item.commentCount} comments`}
                >
                  <Comment size={12} aria-hidden="true" />
                  {item.commentCount}
                  <span className="sr-only"> comments</span>
                </span>
              )}
              {item.checks && <CheckRollupIcon rollup={item.checks} />}
            </span>
          </span>
          {shownLabels.length > 0 && (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {shownLabels.map((label) => (
                <LabelChip key={label.name} label={label} />
              ))}
              {hiddenLabels > 0 && (
                <span className="text-3xs tabular-nums text-muted-foreground">+{hiddenLabels}</span>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}
