import type { GithubItemKind, GithubRepoSlot } from '@shared/types/github.types'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useDockClearance } from '@/hooks/use-dock-clearance'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useOskViewport } from '@/hooks/use-osk-viewport'
import { cn } from '@/lib/utils'
import { githubItemIdentity } from '@/stores/github-chat-links-store'
import {
  type GithubItemRef,
  githubItemKey,
  githubRepoMetaKey,
  resourceOf,
  useGithubStore
} from '@/stores/github-store'
import { useProjectStore } from '@/stores/project-store'
import { GithubChecksList } from './GithubChecksList'
import { GithubCommentComposer } from './GithubCommentComposer'
import { GithubHandoffBar } from './GithubHandoffBar'
import { GithubItemHeader } from './GithubItemHeader'
import { GithubItemMeta, type GithubMetaEditor } from './GithubItemMeta'
import { GithubLinkedChats, useGithubLinkedChats } from './GithubLinkedChats'
import { GithubMergeControls } from './GithubMergeControls'
import { GithubReviewThreads } from './GithubReviewThreads'
import { GithubTimeline } from './GithubTimeline'
import { relativeAgo } from './github-status'
import { useGithubPoll } from './use-github-poll'

const ITEM_POLL_MS = 2 * 60_000
const PENDING_CHECKS_POLL_MS = 30_000
/** Pane width from which labels and assignees move into a sidebar (mockup G). */
const SIDEBAR_MIN_WIDTH_PX = 1100

type ItemTab = 'conversation' | 'checks' | 'threads' | 'linked'

interface GithubItemPanelProps {
  cwd: string
  repo: GithubRepoSlot
  kind: GithubItemKind
  number: number
  /** The tab is on screen: only then does the panel poll. */
  isVisible: boolean
}

/** The element is at least `minWidth` wide; false until measured. */
function useWiderThan(minWidth: number): [(el: HTMLElement | null) => void, boolean] {
  const [wide, setWide] = useState(false)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback(
    (el: HTMLElement | null): void => {
      observer.current?.disconnect()
      observer.current = null
      if (!el || typeof ResizeObserver === 'undefined') return
      observer.current = new ResizeObserver(([entry]) => {
        setWide((entry?.contentRect.width ?? 0) >= minWidth)
      })
      observer.current.observe(el)
    },
    [minWidth]
  )
  return [ref, wide]
}

/**
 * CAP-3/4 detail of one issue or PR, as a pane tab: the header, labels and
 * assignees, agent hand-offs, then tabs (Conversation / Checks / Threads for
 * a PR, Conversation / Linked chats for an issue). On the phone shell the
 * comment box is pinned above the keyboard. Everything mirrors GitHub: an
 * action is followed by a re-read, never a local state change.
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
  const projectId = useProjectStore((s) => s.activeProjectId)
  const isMobile = useMobileWebShell()
  const osk = useOskViewport()
  const [tab, setTab] = useState<ItemTab>('conversation')
  const [editing, setEditing] = useState<GithubMetaEditor | null>(null)
  const [measureRef, wide] = useWiderThan(SIDEBAR_MIN_WIDTH_PX)
  const pinComposer = isMobile && tab === 'conversation'
  const dockRef = useDockClearance(pinComposer && isVisible)
  const linkedChats = useGithubLinkedChats(
    projectId,
    detail.data ? githubItemIdentity(detail.data.repo, number) : ''
  )

  // Restored tabs mount hidden; reading only on screen keeps them off the shared `gh` slots.
  useEffect(() => {
    if (!isVisible) return
    const store = useGithubStore.getState()
    void store.loadItem(itemRef)
    if (isPr) void store.loadChecks(itemRef)
    // Labels, assignable people and the viewer: "Assign yourself" needs the viewer up front.
    if (!store.repoMeta[githubRepoMetaKey(cwd, repo)]?.data) void store.loadRepoMeta(cwd, repo)
  }, [itemRef, isPr, isVisible, cwd, repo])

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
  const shownChecks = checksStale
    ? {
        ...checks,
        data: null,
        status: checks.status === 'error' ? ('error' as const) : ('loading' as const)
      }
    : checks
  const failedCount = shownChecks.data?.checks.filter((c) => c.status === 'failure').length ?? 0
  const tabs: TabSpec[] = pr
    ? [
        { id: 'conversation', label: 'Conversation', count: data.item.commentCount },
        {
          id: 'checks',
          label: 'Checks',
          badge: failedCount > 0 ? `${failedCount} failed` : undefined,
          count: failedCount > 0 ? undefined : shownChecks.data?.checks.length
        },
        { id: 'threads', label: 'Threads', count: pr.reviewThreads.length }
      ]
    : [
        { id: 'conversation', label: 'Conversation', count: data.item.commentCount },
        { id: 'linked', label: 'Linked chats', count: linkedChats.length }
      ]
  const meta = (layout: 'rows' | 'sidebar') => (
    <GithubItemMeta
      itemRef={itemRef}
      detail={data}
      layout={layout}
      editing={editing}
      onEditingChange={setEditing}
    />
  )
  const postComment = (body: string) =>
    useGithubStore.getState().comment(itemRef, { kind: 'conversation' }, body)

  return (
    <div
      ref={measureRef}
      className="flex h-full min-h-0 flex-col bg-background"
      // The pinned composer stays above the keyboard where the layout viewport does not shrink (iOS).
      style={
        pinComposer && osk.isOskOpen && osk.keyboardHeight > 0
          ? { paddingBottom: `var(--termul-keyboard-height, ${osk.keyboardHeight}px)` }
          : undefined
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn('mx-auto flex gap-8 px-4 py-4 sm:px-6', wide ? 'max-w-6xl' : 'max-w-3xl')}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <GithubItemHeader
              itemRef={itemRef}
              detail={data}
              refreshing={refreshing}
              onRefresh={refresh}
              onEditLabels={() => setEditing('labels')}
              onEditAssignees={() => setEditing('assignees')}
            />
            {!wide && meta('rows')}
            <GithubHandoffBar
              itemRef={itemRef}
              detail={data}
              // Fix CI acts on the current head's failures only.
              checks={checksStale ? null : checks.data}
            />

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

            <ItemTabs tabs={tabs} active={tab} onChange={setTab}>
              {tab === 'conversation' && (
                <div className="flex min-w-0 flex-col gap-5">
                  {pr && <GithubLinkedChats chats={linkedChats} />}
                  <GithubTimeline detail={data} scope={key} />
                  {pr && (
                    <GithubMergeControls
                      itemRef={itemRef}
                      detail={data}
                      pr={pr}
                      refreshing={refreshing}
                    />
                  )}
                  {!isMobile && (
                    <GithubCommentComposer
                      label="Add a comment"
                      submitLabel="Comment"
                      placeholder="Leave a comment (Markdown)"
                      onSubmit={postComment}
                    />
                  )}
                </div>
              )}
              {tab === 'checks' && <GithubChecksList cwd={cwd} repo={repo} checks={shownChecks} />}
              {tab === 'threads' && pr && (
                <GithubReviewThreads
                  threads={pr.reviewThreads}
                  onReply={(threadId, body) =>
                    useGithubStore
                      .getState()
                      .comment(itemRef, { kind: 'review_thread', threadId }, body)
                  }
                />
              )}
              {tab === 'threads' && pr?.reviewThreads.length === 0 && (
                <p className="text-sm text-muted-foreground">No review threads.</p>
              )}
              {tab === 'linked' && (
                <GithubLinkedChats
                  chats={linkedChats}
                  empty={
                    <p className="text-sm text-muted-foreground">
                      No agent chats started from this issue yet. Start working or Ask opens one.
                    </p>
                  }
                />
              )}
            </ItemTabs>
          </div>
          {wide && (
            <aside aria-label="Details" className="w-64 shrink-0 pt-1">
              {meta('sidebar')}
            </aside>
          )}
        </div>
      </div>
      {pinComposer && (
        <div
          ref={dockRef}
          className="shrink-0 border-t border-border bg-background px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2"
        >
          <GithubCommentComposer
            pinned
            label="Add a comment"
            submitLabel="Comment"
            placeholder="Comment (Markdown)"
            onSubmit={postComment}
          />
        </div>
      )}
    </div>
  )
}

interface TabSpec {
  id: ItemTab
  label: string
  count?: number
  /** Replaces the count with an alert ("1 failed"). */
  badge?: string
}

/** Underlined tabs (mockups C, D, G) over the active tab's panel. */
function ItemTabs({
  tabs,
  active,
  onChange,
  children
}: {
  tabs: TabSpec[]
  active: ItemTab
  onChange: (tab: ItemTab) => void
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        role="tablist"
        aria-label="Sections"
        className="-mx-4 flex min-w-0 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
        onKeyDown={(event) => {
          const index = tabs.findIndex((t) => t.id === active)
          const target: Record<string, number> = {
            ArrowRight: (index + 1) % tabs.length,
            ArrowLeft: (index - 1 + tabs.length) % tabs.length,
            Home: 0,
            End: tabs.length - 1
          }
          const next = tabs[target[event.key] ?? -1]
          if (!next) return
          event.preventDefault()
          onChange(next.id)
          document.getElementById(`${id}-${next.id}`)?.focus()
        }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              id={`${id}-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className={cn(
                '-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm transition-colors duration-150 ease-out pointer-coarse:h-12',
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring',
                selected
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {tab.label}
              {tab.badge ? (
                <span className="rounded-full bg-destructive/20 px-1.5 text-xs tabular-nums text-destructive">
                  {tab.badge}
                </span>
              ) : tab.count !== undefined ? (
                <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                  {tab.count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${active}`}
        className="min-w-0"
      >
        {children}
      </div>
    </div>
  )
}
