import type {
  GithubChecksResult,
  GithubItemDetail,
  GithubReviewThread
} from '@shared/types/github.types'
import { useState } from 'react'
import { Bot, Comment, Eye, MessageQuestion, Wrench } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { WriteGate } from '@/components/ui/write-gate'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import type { GithubHandoffAction } from '@/stores/github-chat-links-store'
import type { GithubItemRef } from '@/stores/github-store'
import { useActiveProject } from '@/stores/project-store'
import { type GithubHandoffRequest, runGithubHandoff } from './github-handoff'
import { handoffActions } from './handoff-actions'

const ICONS: Record<GithubHandoffAction, typeof Bot> = {
  start: Bot,
  ask: MessageQuestion,
  review: Eye,
  fix_ci: Wrench,
  resolve_comments: Comment
}

const HINTS: Record<GithubHandoffAction, string> = {
  start: 'Start an agent chat in a new worktree, with the issue as an editable prompt',
  ask: 'Ask an agent about this in a read-only chat',
  review: 'Have an agent review this pull request in a read-only chat',
  fix_ci: 'Hand the failing checks to an agent in a new worktree on the PR head',
  resolve_comments: 'Hand unresolved review threads to an agent in a new worktree on the PR head'
}

interface GithubHandoffBarProps {
  itemRef: GithubItemRef
  detail: GithubItemDetail
  checks: GithubChecksResult | null
}

/**
 * Agent hand-offs for the open item (CAP-5 to CAP-8), as a row of small
 * buttons in the item header. Actions that make a worktree sit behind
 * `WriteGate`; a blocked action stays visible with its reason.
 */
export function GithubHandoffBar({
  itemRef,
  detail,
  checks
}: GithubHandoffBarProps): React.JSX.Element | null {
  const project = useActiveProject()
  const admitsWrites = useServerAdmitsRemoteWrites()
  const isMobileShell = useMobileWebShell()
  const [running, setRunning] = useState<GithubHandoffAction | null>(null)
  const [picking, setPicking] = useState(false)
  if (!project) return null

  const actions = handoffActions(detail, checks, Boolean(project.isGitRepo))
  const reasons = [...new Set(actions.map((a) => a.blockedReason).filter((r) => r !== null))]

  const run = async (request: GithubHandoffRequest): Promise<void> => {
    setRunning(request.action)
    try {
      await runGithubHandoff({ projectId: project.id, itemRef, detail }, request)
    } finally {
      setRunning(null)
    }
  }

  const onAction = (action: GithubHandoffAction): void => {
    if (action === 'resolve_comments') {
      setPicking(true)
    } else if (action === 'fix_ci') {
      if (checks) void run({ action, checks })
    } else {
      void run({ action })
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div
        role="toolbar"
        aria-label="Agent actions"
        className="flex flex-wrap items-center gap-1.5"
      >
        {actions.map(({ action, label, writes, blockedReason }) => {
          const Icon = ICONS[action]
          const gated = writes && !admitsWrites
          return (
            <WriteGate key={action} gated={gated}>
              <Button
                variant="outline"
                size={isMobileShell ? 'touch' : 'xs'}
                className={isMobileShell ? 'px-3' : undefined}
                disabled={gated || blockedReason !== null || running !== null}
                title={blockedReason ?? HINTS[action]}
                onClick={() => onAction(action)}
              >
                <Icon size={14} aria-hidden="true" />
                {running === action ? `${label}…` : label}
              </Button>
            </WriteGate>
          )
        })}
      </div>
      {reasons.map((reason) => (
        <p key={reason} className="text-xs text-muted-foreground">
          {reason}
        </p>
      ))}
      {picking && detail.pr && (
        <ResolveCommentsDialog
          threads={detail.pr.reviewThreads.filter((t) => !t.isResolved)}
          onCancel={() => setPicking(false)}
          onConfirm={(threads) => {
            setPicking(false)
            void run({ action: 'resolve_comments', threads })
          }}
        />
      )}
    </div>
  )
}

function threadLabel(thread: GithubReviewThread): string {
  return thread.line === null ? thread.path : `${thread.path}:${thread.line}`
}

/** CAP-8 picker: unresolved threads, all on by default; only the chosen ones reach the prompt. */
function ResolveCommentsDialog({
  threads,
  onCancel,
  onConfirm
}: {
  threads: GithubReviewThread[]
  onCancel: () => void
  onConfirm: (threads: GithubReviewThread[]) => void
}): React.JSX.Element {
  const [selected, setSelected] = useState(() => new Set(threads.map((t) => t.id)))
  const toggle = (id: string, on: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const chosen = threads.filter((t) => selected.has(t.id))
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="flex max-h-[85dvh] flex-col">
        <DialogHeader>
          <DialogTitle>Resolve review comments</DialogTitle>
          <DialogDescription>
            An agent works on the chosen threads in a new worktree on the PR head and pushes there.
            You resolve the threads on GitHub.
          </DialogDescription>
        </DialogHeader>
        <ul className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto px-1">
          {threads.map((thread) => {
            const first = thread.comments[0]
            const id = `resolve-thread-${thread.id}`
            return (
              <li key={thread.id}>
                <label
                  htmlFor={id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 hover:bg-foreground/[0.03]"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="min-w-0 truncate font-mono text-2xs text-foreground"
                        title={thread.path}
                      >
                        {threadLabel(thread)}
                      </span>
                      {thread.isOutdated && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-3xs font-medium text-muted-foreground">
                          Outdated
                        </span>
                      )}
                    </span>
                    {first && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{first.author}</span>:{' '}
                        {first.body}
                      </span>
                    )}
                  </span>
                  <Switch
                    id={id}
                    checked={selected.has(thread.id)}
                    onCheckedChange={(on) => toggle(thread.id, on)}
                    className="mt-0.5 shrink-0"
                  />
                </label>
              </li>
            )
          })}
        </ul>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={chosen.length === 0} onClick={() => onConfirm(chosen)}>
            {chosen.length === 1 ? 'Hand off 1 thread' : `Hand off ${chosen.length} threads`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
