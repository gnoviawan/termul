import type { GithubItemDetail } from '@shared/types/github.types'
import { ConfirmedExternalLink } from '@/components/external-link/ExternalLinkConfirm'
import { ExternalLink, GitBranch, RefreshCw } from '@/components/icons'
import { DiffStatCounts } from '@/components/ui/diff-stat-counts'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { cn } from '@/lib/utils'
import type { GithubItemRef } from '@/stores/github-store'
import { GithubItemMenu, GithubStateButton } from './GithubItemMenu'
import { GithubAvatar, ItemStatePill, relativeAgo } from './github-status'

interface GithubItemHeaderProps {
  itemRef: GithubItemRef
  detail: GithubItemDetail
  refreshing: boolean
  onRefresh: () => void
  onEditLabels: () => void
  onEditAssignees: () => void
}

/**
 * The item page's header (mockups C and G): state, repository and actions;
 * the title; who opened it and when; for a PR its branches and size.
 */
export function GithubItemHeader({
  itemRef,
  detail,
  refreshing,
  onRefresh,
  onEditLabels,
  onEditAssignees
}: GithubItemHeaderProps): React.JSX.Element {
  const isMobile = useMobileWebShell()
  const { item, repo, pr } = detail
  return (
    <header className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ItemStatePill
          kind={item.kind}
          state={item.state}
          label={
            item.kind === 'issue' && item.state === 'closed' && detail.stateReason === 'not_planned'
              ? 'Closed as not planned'
              : undefined
          }
        />
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {repo.owner}/{repo.name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className={cn(PANEL_ICON_BUTTON_CLASS, 'pointer-coarse:size-11')}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={14} aria-hidden="true" className={cn(refreshing && 'animate-spin')} />
          </button>
          {!isMobile && (
            <>
              <ConfirmedExternalLink
                href={item.url}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span className="hidden sm:inline">Open on GitHub</span>
                <span className="sr-only sm:hidden">Open on GitHub</span>
              </ConfirmedExternalLink>
              <GithubStateButton itemRef={itemRef} detail={detail} />
            </>
          )}
          <GithubItemMenu
            itemRef={itemRef}
            detail={detail}
            onEditLabels={onEditLabels}
            onEditAssignees={onEditAssignees}
          />
        </span>
      </div>
      <h1 className="break-words text-lg font-semibold leading-snug text-foreground pointer-coarse:text-xl">
        {item.title}{' '}
        <span className="font-normal tabular-nums text-muted-foreground">#{item.number}</span>
      </h1>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <GithubAvatar login={item.author} size="sm" />
        <span className="font-medium text-foreground">{item.author}</span>
        <span>
          opened <time dateTime={detail.createdAt}>{relativeAgo(detail.createdAt)}</time> · updated{' '}
          <time dateTime={item.updatedAt}>{relativeAgo(item.updatedAt)}</time>
        </span>
      </p>
      {pr && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
      )}
    </header>
  )
}
