import type { GithubListItem, GithubRepoRef } from '@shared/types/github.types'
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { AlertTriangle, RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { openGithubSignInTerminal } from '@/lib/github-sign-in'
import { cn } from '@/lib/utils'
import { returnToWorkspaceRoute } from '@/lib/workspace-route'
import {
  githubListKey,
  resourceOf,
  selectGithubFilter,
  useGithubStore
} from '@/stores/github-store'
import { findPaneById, githubItemTabId, useWorkspaceStore } from '@/stores/workspace-store'
import { GithubFilters } from './GithubFilters'
import { GithubListRow } from './GithubListRow'
import { GithubAuthWarning, GithubStatusView, githubBlocker } from './GithubStatusView'
import { relativeAgo } from './github-status'
import { useGithubPoll } from './use-github-poll'

const LIST_POLL_VISIBLE_MS = 2 * 60_000
const LIST_POLL_HIDDEN_MS = 5 * 60_000
/** While signed out or without `gh`, re-read the local status so a finished login shows up. */
const STATUS_POLL_MS = 15_000

interface GithubPanelProps {
  projectId: string
  /** The working copy whose repository the list shows. */
  cwd: string
  /** Called after the panel opened a tab (an item, or the sign-in terminal): the phone drawer closes. */
  onNavigate?: () => void
}

function repoName(repo: GithubRepoRef): string {
  return `${repo.owner}/${repo.name}`
}

/**
 * CAP-1/2/9: the project's GitHub issues and PRs. Shows the onboarding state
 * until `gh` is installed, signed in and the remote resolves, then the
 * filtered list. A failed or rate-limited refresh keeps the last good list on
 * screen with a note. Selecting a row opens its detail as a pane tab.
 */
export function GithubPanel({ projectId, cwd, onNavigate }: GithubPanelProps): React.JSX.Element {
  const navigate = useNavigate()
  const pathname = useLocation().pathname
  const context = useGithubStore((s) => resourceOf(s.contexts[cwd]))
  const filter = useGithubStore(selectGithubFilter(cwd))
  const list = useGithubStore((s) => resourceOf(s.lists[githubListKey(cwd, filter)]))
  const { loadContext, loadList, setFilter } = useGithubStore.getState()
  const activeTabId = useWorkspaceStore((s) => {
    const pane = findPaneById(s.root, s.activePaneId)
    return pane?.type === 'leaf' ? pane.activeTabId : null
  })

  const blocker = context.data ? githubBlocker(context.data) : null
  const resolved = context.data?.repo.kind === 'resolved' ? context.data.repo : null
  const ready = Boolean(resolved && !blocker)
  const slotRepo = filter.repo === 'upstream' ? resolved?.upstream : resolved?.origin
  const slotRepoId = slotRepo ? `${slotRepo.host}/${repoName(slotRepo)}` : null
  // The list cache is keyed by slot: after a remote change it holds the old repository's items.
  const listData =
    list.data && `${list.data.repo.host}/${repoName(list.data.repo)}` === slotRepoId
      ? list.data
      : null

  useEffect(() => {
    if (cwd) void useGithubStore.getState().loadContext(cwd)
  }, [cwd])

  // A fork's upstream filter left over from another working copy falls back to origin.
  useEffect(() => {
    if (resolved && !resolved.upstream && filter.repo === 'upstream') {
      useGithubStore.getState().setFilter(cwd, { repo: 'origin' })
    }
  }, [resolved, filter.repo, cwd])

  // A filter change loads through `setFilter`; this covers mount, becoming ready and a remote change.
  useEffect(() => {
    if (ready && slotRepoId) void useGithubStore.getState().loadList(cwd)
  }, [ready, cwd, slotRepoId])

  useGithubPoll(() => void loadList(cwd), LIST_POLL_VISIBLE_MS, LIST_POLL_HIDDEN_MS, ready)
  useGithubPoll(
    () => void loadContext(cwd),
    STATUS_POLL_MS,
    null,
    Boolean(blocker && blocker.kind !== 'not_github')
  )

  const openItem = (item: GithubListItem): void => {
    returnToWorkspaceRoute(pathname, navigate)
    useWorkspaceStore.getState().addGithubItemTab({
      cwd,
      repo: filter.repo,
      kind: item.kind,
      number: item.number,
      title: item.title
    })
    onNavigate?.()
  }

  const signIn = (loginCommand: string): void => {
    returnToWorkspaceRoute(pathname, navigate)
    onNavigate?.()
    void openGithubSignInTerminal(projectId, cwd, loginCommand).then((opened) => {
      if (!opened) toast.error('Could not open a terminal to sign in')
    })
  }

  if (!context.data) {
    if (context.status === 'error') {
      return (
        <PanelMessage
          title="Couldn't check GitHub"
          detail={context.error ?? undefined}
          onRetry={() => void loadContext(cwd)}
        />
      )
    }
    return <ListSkeleton />
  }

  if (blocker || !resolved) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <GithubStatusView
          blocker={blocker ?? { kind: 'not_github' }}
          retrying={context.status === 'loading'}
          onRetry={() => void loadContext(cwd)}
          onSignIn={signIn}
        />
      </div>
    )
  }

  const auth = context.data.auth
  const items = listData?.items ?? []
  const refreshing = list.status === 'loading'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 pl-4 pr-1.5 pointer-coarse:h-11">
        {resolved.upstream ? (
          <Select
            value={filter.repo}
            onValueChange={(value) => setFilter(cwd, { repo: value as 'origin' | 'upstream' })}
          >
            <SelectTrigger
              aria-label="Repository"
              className="-ml-1.5 h-7 min-w-0 pointer-coarse:h-11 flex-1 gap-1 rounded-md border-transparent bg-transparent px-1.5 text-xs font-medium pointer-coarse:text-sm [&>span]:truncate"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="origin">{repoName(resolved.origin)}</SelectItem>
              <SelectItem value="upstream">{repoName(resolved.upstream)} (upstream)</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-foreground pointer-coarse:text-sm"
            title={`${resolved.origin.host}/${repoName(resolved.origin)}`}
          >
            {repoName(resolved.origin)}
          </span>
        )}
        <button
          type="button"
          onClick={() => void loadList(cwd, { refresh: true })}
          disabled={refreshing}
          className={cn(PANEL_ICON_BUTTON_CLASS, 'pointer-coarse:size-11')}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={14} aria-hidden="true" className={cn(refreshing && 'animate-spin')} />
        </button>
      </div>

      {auth.state === 'connected' && <GithubAuthWarning auth={auth} />}
      <GithubFilters filter={filter} onChange={(patch) => setFilter(cwd, patch)} />

      {list.status === 'error' && listData && (
        <p
          role="status"
          className="mx-2 mb-1 flex shrink-0 items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-2xs text-warning"
        >
          <AlertTriangle size={12} aria-hidden="true" className="mt-px shrink-0" />
          <span>
            {list.errorCode === 'GH_RATE_LIMITED'
              ? 'GitHub rate limit reached.'
              : "Couldn't refresh."}{' '}
            Showing the list from {relativeAgo(listData.fetchedAt)}.
          </span>
        </p>
      )}

      {listData === null ? (
        list.status === 'error' ? (
          <PanelMessage
            title={
              list.errorCode === 'GH_RATE_LIMITED'
                ? 'GitHub rate limit reached'
                : "Couldn't load issues and pull requests"
            }
            detail={list.error ?? undefined}
            onRetry={() => void loadList(cwd, { refresh: true })}
          />
        ) : (
          <ListSkeleton />
        )
      ) : items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          Nothing matches these filters.
        </p>
      ) : (
        <ul
          aria-label="Issues and pull requests"
          className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
        >
          {items.map((item) => (
            <GithubListRow
              key={`${item.kind}-${item.number}`}
              item={item}
              isActive={activeTabId === githubItemTabId(cwd, filter.repo, item.number)}
              onOpen={openItem}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function PanelMessage({
  title,
  detail,
  onRetry
}: {
  title: string
  detail?: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-4 py-6 text-center">
      <p className="text-sm font-medium text-destructive">{title}</p>
      {detail && <p className="break-words text-xs text-muted-foreground">{detail}</p>}
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-col gap-2 px-3 py-2"
    >
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-10 w-full rounded-lg" />
      ))}
    </div>
  )
}
