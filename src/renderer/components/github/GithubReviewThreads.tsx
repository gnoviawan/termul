import type { GithubReviewThread } from '@shared/types/github.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { useState } from 'react'
import { CheckCircle2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { WriteGate } from '@/components/ui/write-gate'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { GithubComment } from './GithubComment'
import { GithubCommentComposer } from './GithubCommentComposer'

function ThreadBadges({ thread }: { thread: GithubReviewThread }): React.JSX.Element {
  return (
    <>
      {thread.isResolved && (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-success/20 px-1.5 text-3xs font-medium text-success">
          <CheckCircle2 size={12} aria-hidden="true" />
          Resolved
        </span>
      )}
      {thread.isOutdated && (
        <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-muted px-1.5 text-3xs font-medium text-muted-foreground">
          Outdated
        </span>
      )}
    </>
  )
}

function ThreadLocation({ thread }: { thread: GithubReviewThread }): React.JSX.Element {
  return (
    <span className="min-w-0 truncate font-mono text-2xs text-foreground" title={thread.path}>
      {thread.path}
      {thread.line !== null && <span className="text-muted-foreground">:{thread.line}</span>}
    </span>
  )
}

/** A thread's "Reply" button, which opens a small reply box in place. */
function ThreadReply({
  onReply
}: {
  onReply: (body: string) => Promise<IpcResult<unknown>>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const gated = !useServerAdmitsRemoteWrites()
  const isMobileShell = useMobileWebShell()
  if (open) {
    return (
      <GithubCommentComposer
        label="Reply to this thread"
        submitLabel="Reply"
        placeholder="Write a reply"
        onSubmit={onReply}
        onCancel={() => setOpen(false)}
        autoFocus
        className="px-1"
      />
    )
  }
  return (
    <WriteGate gated={gated} className="self-start">
      <Button
        variant="ghost"
        size={isMobileShell ? 'touch' : 'xs'}
        className="px-3"
        disabled={gated}
        onClick={() => setOpen(true)}
      >
        Reply
      </Button>
    </WriteGate>
  )
}

/**
 * CAP-3 review threads with file and line, as GitHub reports them. Resolved
 * threads start folded (native `details`); Termul never resolves a thread.
 */
export function GithubReviewThreads({
  threads,
  onReply
}: {
  threads: GithubReviewThread[]
  /** Post a reply into a thread; the panel shows what GitHub returns. */
  onReply: (threadId: string, body: string) => Promise<IpcResult<unknown>>
}): React.JSX.Element | null {
  if (threads.length === 0) return null
  const unresolved = threads.filter((t) => !t.isResolved).length
  return (
    <section aria-labelledby="github-review-threads" className="flex flex-col gap-2">
      <h2 id="github-review-threads" className="text-sm font-medium text-foreground">
        Review threads{' '}
        <span className="font-normal tabular-nums text-muted-foreground">
          {unresolved} unresolved of {threads.length}
        </span>
      </h2>
      {threads.map((thread) => (
        <details
          key={thread.id}
          open={!thread.isResolved}
          className="group min-w-0 rounded-lg border border-border"
        >
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 hover:bg-foreground/[0.03] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring [&::-webkit-details-marker]:hidden">
            <ThreadLocation thread={thread} />
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <ThreadBadges thread={thread} />
            </span>
          </summary>
          <div className="flex flex-col gap-2 px-2 pb-2">
            {thread.comments.map((comment) => (
              <GithubComment key={comment.id} comment={comment} />
            ))}
            <ThreadReply onReply={(body) => onReply(thread.id, body)} />
          </div>
        </details>
      ))}
    </section>
  )
}
