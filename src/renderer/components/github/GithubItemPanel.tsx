import type { GithubItemDetail, GithubItemKind, GithubRepoSlot } from '@shared/types/github.types'
import { useEffect, useMemo } from 'react'
import { ConfirmedExternalLink } from '@/components/external-link/ExternalLinkConfirm'
import { AlertTriangle, ExternalLink, GitBranch, RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  type GithubItemRef,
  githubItemKey,
  resourceOf,
  useGithubStore
} from '@/stores/github-store'
import { GithubChecksList } from './GithubChecksList'
import { GithubComment, GithubMarkdown } from './GithubComment'
import { GithubMergeControls } from './GithubMergeControls'
import { GithubReviewThreads } from './GithubReviewThreads'
import { ItemStatePill, LabelChip, relativeAgo } from './github-status'
import { useGithubPoll } from './use-github-poll'

const ITEM_POLL_MS = 2 * 60_000
const PENDING_CHECKS_POLL_MS = 30_000

interface GithubItemPanelProps {
  cwd: string
  repo: GithubRepoSlot
  kind: GithubItemKind
  number: number
  /** The tab is on screen: only then does the panel poll. */
  isVisible: boolean
}

/**
 * CAP-3/4 detail of one issue or PR, as a pane tab: state, body and
 * conversation (oldest first); for a PR also its branches, size, checks with
 * failing log tails, merge controls and review threads. Everything mirrors
 * GitHub: an action is followed by a re-read, never a local state change.
 */
export function GithubItemPanel({
  cwd,
  repo,
  kind,
  number,
  isVisible
}: GithubItemPanelProps): React.JSX.Element {
  const itemRef = useMemo<GithubItemRef>(
    () => ({ cwd, repo, kind, number }),
    [cwd, repo, kind, number]
  )
  const key = githubItemKey(cwd, repo, number)
  const detail = useGithubStore((s) => resourceOf(s.items[key]))
  const checks = useGithubStore((s) => resourceOf(s.checks[key]))
  const isPr = kind === 'pr'

  // Restored tabs mount hidden; reading only on screen keeps them off the shared `gh` slots.
  useEffect(() => {
    if (!isVisible) return
    const store = useGithubStore.getState()
    void store.loadItem(itemRef)
    if (isPr) void store.loadChecks(itemRef)
  }, [itemRef, isPr, isVisible])

  const refresh = (): void => {
    const store = useGithubStore.getState()
    void store.loadItem(itemRef, { refresh: true })
    if (isPr) void store.loadChecks(itemRef, { refresh: true })
  }

  // After a push the item reports a new head before the cached checks do.
  const headSha = detail.data?.pr?.headSha
  const checksStale = Boolean(headSha && checks.data && checks.data.headSha !== headSha)
  useEffect(() => {
    if (checksStale) void useGithubStore.getState().loadChecks(itemRef, { refresh: true })
  }, [checksStale, itemRef])

  const checksPending =
    (checksStale ? detail.data?.item.checks : (checks.data?.rollup ?? detail.data?.item.checks)) ===
    'pending'
  useGithubPoll(
    () => void useGithubStore.getState().loadItem(itemRef),
    ITEM_POLL_MS,
    null,
    isVisible
  )
  useGithubPoll(
    () => void useGithubStore.getState().loadChecks(itemRef),
    PENDING_CHECKS_POLL_MS,
    null,
    isVisible && isPr && checksPending
  )

  const data = detail.data
  if (!data) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 sm:px-6">
          {detail.status === 'error' ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-sm font-medium text-destructive">Couldn't load #{number}</p>
              {detail.error && <p className="text-xs text-muted-foreground">{detail.error}</p>}
              <Button variant="outline" size="sm" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : (
            <>
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-7 w-3/4" />
              <Skeleton className="h-32 w-full" />
            </>
          )}
        </div>
      </div>
    )
  }

  const { pr } = data
  const refreshing = detail.status === 'loading'

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-4 sm:px-6">
        <ItemHeader detail={data} refreshing={refreshing} onRefresh={refresh} />

        {detail.status === 'error' && (
          <p
            role="status"
            className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning"
          >
            <AlertTriangle size={14} aria-hidden="true" className="mt-px shrink-0" />
            {detail.errorCode === 'GH_RATE_LIMITED'
              ? 'GitHub rate limit reached.'
              : "Couldn't refresh."}{' '}
            Showing what was loaded {relativeAgo(data.fetchedAt)}.
          </p>
        )}

        {pr && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch size={14} aria-hidden="true" className="shrink-0" />
                <code className="min-w-0 truncate rounded bg-muted px-1 font-mono text-2xs text-foreground">
                  {pr.headRefName}
                </code>
                <span aria-hidden="true">→</span>
                <span className="sr-only">into</span>
                <code className="min-w-0 truncate rounded bg-muted px-1 font-mono text-2xs text-foreground">
                  {pr.baseRefName}
                </code>
              </span>
              <span className="tabular-nums">
                <DiffStatCounts added={pr.additions} removed={pr.deletions} />
              </span>
              <span className="tabular-nums">
                {pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'} changed
              </span>
            </div>
            <GithubChecksList
              cwd={cwd}
              repo={repo}
              checks={
                checksStale
                  ? {
                      ...checks,
                      data: null,
                      status: checks.status === 'error' ? 'error' : 'loading'
                    }
                  : checks
              }
            />
            <GithubMergeControls
              itemRef={itemRef}
              detail={data}
              pr={pr}
              refreshing={detail.status === 'loading'}
            />
          </>
        )}

        <section aria-label="Description" className="min-w-0">
          {data.body.trim() ? (
            <GithubMarkdown text={data.body} scope={`${key}-body`} />
          ) : (
            <p className="text-sm italic text-muted-foreground">No description provided.</p>
          )}
        </section>

        {data.comments.length > 0 && (
          <section aria-labelledby="github-comments" className="flex flex-col gap-2">
            <h2 id="github-comments" className="text-sm font-medium text-foreground">
              Comments{' '}
              <span className="font-normal tabular-nums text-muted-foreground">
                {data.comments.length}
              </span>
            </h2>
            {data.comments.map((comment) => (
              <GithubComment key={comment.id} comment={comment} />
            ))}
          </section>
        )}

        {pr && <GithubReviewThreads threads={pr.reviewThreads} />}
      </div>
    </div>
  )
}

function ItemHeader({
  detail,
  refreshing,
  onRefresh
}: {
  detail: GithubItemDetail
  refreshing: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const { item, repo } = detail
  return (
    <header className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <ItemStatePill kind={item.kind} state={item.state} />
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {repo.owner}/{repo.name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className={PANEL_ICON_BUTTON_CLASS}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={14} aria-hidden="true" className={cn(refreshing && 'animate-spin')} />
          </button>
          <ConfirmedExternalLink
            href={item.url}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <ExternalLink size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Open on GitHub</span>
            <span className="sr-only sm:hidden">Open on GitHub</span>
          </ConfirmedExternalLink>
        </span>
      </div>
      <h1 className="break-words text-lg font-semibold text-foreground">
        {item.title}{' '}
        <span className="font-normal tabular-nums text-muted-foreground">#{item.number}</span>
      </h1>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{item.author}</span> opened{' '}
        <time dateTime={detail.createdAt}>{relativeAgo(detail.createdAt)}</time> · updated{' '}
        <time dateTime={item.updatedAt}>{relativeAgo(item.updatedAt)}</time>
        {item.assignees.length > 0 && <> · Assigned to {item.assignees.join(', ')}</>}
      </p>
      {item.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {item.labels.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
        </div>
      )}
    </header>
  )
}
